// ============ DAEMON TASK: SALIENCE RE-GRADE PROPOSALS ============
// ops/ADR-JANITOR.md §5. Foundational observations are excluded from the decay
// pass entirely (storage/postgres.ts:897 / daemon/decay.ts:38-40, §0.2) — once
// salience is set to "foundational" it never leaves, so grip freezes wherever it
// was (497 iron ~= 515 foundational, near-identical sets) and charge_phase
// freezes at its write-time value. readFoundationalObservations() used to
// silently drop the OLDEST rows past a `created_at DESC LIMIT 200` from every
// wake's Foundation lane — exactly the ones most likely to be genuine identity
// bedrock. §5.1's mechanical fix (independent of this task, storage/postgres.ts
// and storage/sqlite.ts) now ranks by calculatePullStrength before truncating,
// so the lane's own truncation drops the least-alive rows, not merely the
// oldest — this task's demotion work proceeds independently, at its own pace,
// and is not a prerequisite for the lane to behave correctly.
//
// This task proposes demoting an individual foundational observation to
// "active" so it re-enters the ordinary decay pass. It NEVER applies the
// demotion itself:
//   - No automatic accept path exists at any confidence. Excluded from
//     absorption.ts's absorb() (no matching proposal_type branch there) and
//     ai-review.ts's gatherCandidates() (fetches only link/orphan_rescue/dedup).
//     Every other proposal type asserts a relationship between two texts a 3B
//     model can read and judge; this one asserts a judgment about the owner's
//     values, which only Rook can make (§5.6).
//   - Never added to types.ts's EXPIRABLE_PROPOSAL_TYPES (§1) — a rejected
//     regrade must stay a permanent tombstone (§5.5), the same status-blind
//     unique index that is a bug for orphans.
//
// Commit 7b fix (§5, §8) — the invariant this task is now built to:
//   "A tombstone may only record a decision that could have gone the other way."
// Commit 7a shipped shadow as a per-proposal metadata tag checked at ACCEPT time
// (propose.ts:149-157), with no per-run creation cap. That meant night 1 created
// a pending proposal for EVERY candidate the pool had, all tagged shadow:true —
// Rook could only ever reject them. Night 2's candidate query then excludes any
// observation with a prior salience_regrade proposal in ANY status (§5.5's
// anti-nag guarantee), so the entire pool was permanently excluded from ever
// becoming a real, acceptable proposal, on night 1, before shadow ever lifted.
// And a second, independent ratchet survives fixing shadow alone: an uncapped
// create loop turns the whole pool into permanent pending rows in ONE run even
// with shadow off — shadow made the bug visible early, shadow did not cause it.
//
// Fix, in two parts:
//   1. Shadow mode creates ZERO proposals. It runs the full candidate query and
//      returns a bounded ScanRecord (population/candidates/would-create/sample)
//      instead — visible at wake, mutates nothing. Lifting shadow is an operator
//      write to daemon_config.data; the next run creates proposals evaluated
//      against the corpus as it is then. `metadata.shadow` is gone from created
//      proposals entirely: under this design it can only ever be `false`, and a
//      field with one reachable value is a lie in waiting.
//   2. Even with shadow off, per-run creation is capped by WIP (proposals
//      currently pending review), not candidate-pool size — REGRADE_WIP_CAP_EARLY
//      before REGRADE_RAMP_REVIEWED total reviews, REGRADE_WIP_CAP after. This is
//      §5.2's original 0/10/25 ramp, reframed as a pending-queue ceiling instead
//      of an unenforceable "night count" (nothing in this codebase counts nights).
//
// tools-v2/propose.ts's shadow check at :149-157 is left byte-identical — it is
// now a dead-man's switch (reaching that branch means a proposal exists that
// structurally should not, e.g. one created by a pre-fix daemon version), not
// the mode gate it used to be.
//
// Commit 7c fix (§2.1 instance nine) — this instrument's own two silent
// failures: buildSample() read last_surfaced_at off obs.texture, which is
// structurally always null (§2.1 instance six: updateSurfacingEffects never
// mirrors it there); and the ScanRecord.would_create this file computes above
// got mirrored into wake.ts's `regrade.created_last_run` under a name that
// means "actual inserts," even during shadow when zero rows are ever created.
// Fixed here by reading obs.last_surfaced_at (the real column, now mapped onto
// Observation in both backends) and by setting scan.created explicitly on
// every return path below — 0 under shadow, proposals_created once live.

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonRunContext, DaemonTaskResult, RegradeSample, ScanRecord } from "../types";
import { calculatePullStrength, getTimestamp } from "../../helpers";
import type { Observation } from "../../types";

/** ops/ADR-JANITOR.md §5.2 protection clause 5 — candidates must be older than this. */
const MIN_AGE_DAYS = 90;
/** ops/ADR-JANITOR.md §5.2 — last_surfaced_at must be null or older than this. */
const SURFACED_STALE_DAYS = 60;

/**
 * Generous technical ceiling on candidates fetched per run — well above the
 * known corpus size (515 foundational total, §0.2) so this cap is a genuine
 * safety valve, not the operative limit. Deliberately a SEPARATE constant from
 * readFoundationalObservations()'s FOUNDATIONAL_LANE_CAP (§5.1, ../../constants):
 * that method now ranks by calculatePullStrength DESCENDING and keeps the
 * MOST-alive rows (the lane's job); this task's query is ordered oldest-first
 * in storage and this task's own ranking (below) sorts by calculatePullStrength
 * ASCENDING to reach the LEAST-alive rows — the opposite end of the same
 * population, for the opposite purpose. This cap is large enough that, for this
 * corpus, it is never actually reached.
 */
const CANDIDATE_FETCH_CAP = 800;

/** How many of the ordered candidates ride along in the scan record for review. */
const REGRADE_SAMPLE_SIZE = 25;

/**
 * ops/ADR-JANITOR.md §5.2/§5.3's ramp, as a WIP (proposals awaiting review) cap
 * rather than a night count — nothing in this codebase counts nights, and a
 * night-counted cap can't be re-derived from daemon_config alone the way a WIP
 * cap can (getProposalStats already answers "how many are pending right now").
 * Before REGRADE_RAMP_REVIEWED total human reviews, cap creation tighter — Rook
 * is still calibrating trust in this proposal type.
 */
export const REGRADE_WIP_CAP_EARLY = 10;
export const REGRADE_WIP_CAP = 25;
export const REGRADE_RAMP_REVIEWED = 30;

function buildRationale(obs: Observation): string {
	return `Foundational, access_count ${obs.access_count ?? 0}, not surfaced in ${SURFACED_STALE_DAYS}+ days. Proposing demotion to active so it re-enters decay.`;
}

function buildSample(ordered: Observation[]): RegradeSample[] {
	return ordered.slice(0, REGRADE_SAMPLE_SIZE).map(obs => ({
		id: obs.id,
		summary: (obs.summary ?? obs.content).slice(0, 120),
		created: obs.created,
		access_count: obs.access_count ?? 0,
		// ops/ADR-JANITOR.md §2.1 instance nine (commit 7c) — the real column,
		// mapped onto Observation by both backends, not texture (see RegradeSample's
		// doc comment, daemon/types.ts).
		last_surfaced_at: obs.last_surfaced_at ?? null,
		pull_strength: calculatePullStrength(obs),
		rationale: buildRationale(obs)
	}));
}

export async function runSalienceRegradeTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	if (typeof storage.findSalienceRegradeCandidates !== "function") {
		return { task: "salience-regrade", changes: 0, proposals_created: 0 };
	}

	const config = await storage.readDaemonConfig();
	const data = (config.data ?? {}) as Record<string, unknown>;
	// Absent (not `false`) means shadow is ON — the daemon never writes this key
	// itself, matching backlog_mode's convention (ops/ADR-JANITOR.md §9 commit 4).
	const shadow = data.salience_regrade_shadow !== false;

	const minAgeCutoff = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const surfacedCutoff = new Date(Date.now() - SURFACED_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const [candidates, populationTotal, proposalStats] = await Promise.all([
		storage.findSalienceRegradeCandidates(minAgeCutoff, surfacedCutoff, CANDIDATE_FETCH_CAP),
		typeof storage.countFoundationalObservations === "function"
			? storage.countFoundationalObservations()
			: Promise.resolve(0),
		typeof storage.getProposalStats === "function"
			? storage.getProposalStats()
			: Promise.resolve({} as Record<string, { total: number; accepted: number; rejected: number; ratio: number }>)
	]);

	// Propose the least-alive ones first (ops/ADR-JANITOR.md §5.2's ordering, not
	// a threshold — every input calculatePullStrength reads is already covered by
	// the storage-layer protection clauses, so a cutoff here would be redundant).
	const ordered = [...candidates].sort((a, b) => calculatePullStrength(a) - calculatePullStrength(b));

	const regradeStats = proposalStats["salience_regrade"];
	const accepted = regradeStats?.accepted ?? 0;
	const rejected = regradeStats?.rejected ?? 0;
	const pendingRegrades = regradeStats ? Math.max(0, regradeStats.total - accepted - rejected) : 0;
	const cap = (accepted + rejected) >= REGRADE_RAMP_REVIEWED ? REGRADE_WIP_CAP : REGRADE_WIP_CAP_EARLY;
	const headroom = Math.max(0, cap - pendingRegrades);
	const wouldCreate = Math.min(ordered.length, headroom);

	// Built on BOTH paths (shadow or not) — the pool-vs-throughput gap
	// (candidates_total vs would_create) must be visible even while shadow
	// suppresses every actual create. `created` starts at 0 and is corrected
	// below only on the live path, after the loop — ops/ADR-JANITOR.md §2.1
	// instance nine (commit 7c): would_create is a preview, not an outcome, and
	// naming a field "created" when it can only ever equal the preview is the
	// exact bug this field's addition fixes.
	const scan: ScanRecord<RegradeSample> = {
		at: getTimestamp(),
		population_total: populationTotal ?? 0,
		candidates_total: ordered.length,
		would_create: wouldCreate,
		created: 0,
		sample: buildSample(ordered),
		sample_truncated_to: Math.min(ordered.length, REGRADE_SAMPLE_SIZE)
	};

	// Shadow: run the full query, record what WOULD happen, create NOTHING.
	// ops/ADR-JANITOR.md §5's invariant — a tombstone may only record a decision
	// that could have gone the other way, and under shadow accept is disabled,
	// so no proposal created here could ever be anything but a one-sided "no."
	// scan.created stays 0 — this branch never inserts a row.
	if (shadow) {
		return { task: "salience-regrade", changes: 0, proposals_created: 0, scan };
	}

	// headroom/ordered.length may already be 0 here (queue full or nothing found)
	// — slice(0, 0) is [], so the loop below is a correct, unremarkable no-op;
	// no separate early return needed.
	const toCreate = ordered.slice(0, headroom);

	// No batchProposalExists pre-check here, unlike orphans.ts: the storage-layer
	// candidate query already excludes any observation with a prior
	// salience_regrade proposal in ANY status (§5.5), so createProposal's
	// ON CONFLICT DO NOTHING can never actually conflict for a row this function
	// returns — proposals_created below is already accurate without it.
	let proposals_created = 0;
	let truncatedByDeadline = false;
	for (const obs of toCreate) {
		// ops/ADR-JANITOR.md §2/§9 commit 4 — same per-item deadline discipline as
		// orphans.ts's rescue loop. createProposal is a single INSERT, far cheaper
		// than orphans' per-item vector search, but this loop is still unbounded
		// wall-clock work sharing the same nightly time budget as every other stage.
		if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
			truncatedByDeadline = true;
			break;
		}
		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: "salience_regrade",
			source_id: obs.id,
			target_id: obs.id,
			confidence: 0.5,
			rationale: buildRationale(obs),
			// metadata.shadow is gone — under this design a created proposal can
			// only ever reach here with shadow false, so a field with one reachable
			// value would be a lie in waiting. propose.ts:149-157's check against
			// `=== true` still fails safe against any pre-fix row that has it.
			metadata: { action: "demote_to_active" },
			status: "pending"
		});
		proposals_created++;
	}

	// scan.created mirrors proposals_created by construction (same counter) —
	// the two can never drift apart. Equals would_create unless the deadline
	// broke the loop early (truncatedByDeadline), which is exactly the one case
	// where daylight between them is expected, not a bug (§2.1 instance nine).
	scan.created = proposals_created;

	return {
		task: "salience-regrade",
		changes: 0,
		proposals_created,
		scan,
		...(truncatedByDeadline ? { truncated_by_deadline: true } : {})
	};
}
