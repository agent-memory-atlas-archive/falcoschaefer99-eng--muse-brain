// ============ DAEMON TASK: ORPHAN DETECTION & RESCUE ============
// Phase 1 (detect): observations with no links, no entity_id, access_count <= 1,
//   age > 14 days, not already in orphan_observations. Marked in one batch write.
// Phase 2 (rescue): for each orphan under the attempt cap, find nearest non-orphan
//   via vector search, create rescue proposal. Cap is 3 attempts in steady mode, 1
//   in backlog mode (ops/ADR-JANITOR.md §2/§9 commit 4 — context.backlogMode,
//   operator-set via daemon_config.data.backlog_mode, the daemon never writes it).
//   Once exhausted, propose archival (metadata: { action: 'archive' }).

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonTaskResult } from "../types";
import type { DaemonRunContext, StateWindow } from "../types";
import { proposalKey } from "../../storage/keys";

const ORPHAN_AGE_DAYS = 14;

const MAX_RESCUE_ATTEMPTS_STEADY = 3;
const MAX_RESCUE_ATTEMPTS_BACKLOG = 1; // ADR-BRAIN-METABOLIC-ORGANISM.md §3, decided 2026-07-04

// listOrphans is hard-clamped at 200 rows in both backends (postgres.ts:3370) —
// 200 is the max reachable without a storage change, not a guess. Exported so
// buildJanitorHealth's orphan_flow block has a single source of truth instead of
// a second copy of these numbers that could drift from the ones actually
// enforced here.
export const RESCUE_LIMIT_STEADY = 50;
export const RESCUE_LIMIT_BACKLOG = 200;

// ops/ADR-JANITOR.md §2.1 (Eli) — RESCUE_LIMIT is a `listOrphans` WINDOW SIZE, not
// drain capacity. Rescue-by-link is structurally unreachable on this corpus (raw
// cosine gated at 0.90, absorption.ts:20; the measured corpus max is 0.802,
// ADR-RETRIEVAL-FUSION-RETUNE §0), so almost every orphan exits only by archival —
// which requires occupying the window TWICE: once per rescue attempt to burn it
// down, once more to be selected as `exhausted` and carry the archive proposal.
// Under MAX_RESCUE_ATTEMPTS = A, one orphan's full life costs A + 1 window slots.
// The old model (DETECT_LIMIT < RESCUE_LIMIT, a flat 2x relationship) was wrong by
// exactly this factor — the real invariant is DETECT_LIMIT × (A + 1) < RESCUE_LIMIT.
// Exported so wake.ts's buildJanitorHealth computes net_per_night from the same
// slot cost this task actually pays, not a second copy of the arithmetic.
export const SLOTS_PER_ORPHAN_STEADY = MAX_RESCUE_ATTEMPTS_STEADY + 1; // 4
export const SLOTS_PER_ORPHAN_BACKLOG = MAX_RESCUE_ATTEMPTS_BACKLOG + 1; // 2

// A drain does not look for new work. Every orphan DETECTED during a burn-down
// costs (A+1) slots a WAITING orphan needed — detection and rescue compete for the
// same window. Zero is not a cap here, it is the semantics of backlog mode, which
// raises rescue and forgets detection until the backlog clears.
export const DETECT_LIMIT_BACKLOG = 0;

// Derived, with a 2x safety margin against the raw (A+1)-scaled invariant, so a
// slow night or a slightly-larger-than-expected attempt count doesn't immediately
// re-open the violation this derivation exists to close. floor(50 / (4 * 2)) = 6.
const DRAIN_MARGIN = 2;
export const DETECT_LIMIT_STEADY = Math.floor(
	RESCUE_LIMIT_STEADY / (SLOTS_PER_ORPHAN_STEADY * DRAIN_MARGIN)
);

/**
 * Enforcement is derivation AND an assertion — derivation alone cannot catch a
 * hand-edit back to a literal, a third mode, or a change to MAX_RESCUE_ATTEMPTS
 * without re-deriving DETECT_LIMIT alongside it. Runs at module load: wake.ts
 * imports these constants, so a violating edit throws at import in the Worker —
 * correct rather than reckless, since every input here is a compile-time literal
 * and the condition can therefore only fail in CI, never at runtime on unchanged
 * code. Exported (not just called) so a test can exercise the throw directly with
 * arbitrary inputs, instead of only ever seeing it as an unhandled import-time
 * stack trace. ops/ADR-JANITOR.md §2.1.
 */
export function assertOrphanFlowInvariant(
	detectLimit: number,
	rescueLimit: number,
	slotsPerOrphan: number,
	mode: "steady" | "backlog"
): void {
	if (detectLimit * slotsPerOrphan >= rescueLimit) {
		throw new Error(
			`orphans.ts: ${mode}-mode orphan flow invariant violated — ` +
			`DETECT_LIMIT (${detectLimit}) × SLOTS_PER_ORPHAN (${slotsPerOrphan}) = ` +
			`${detectLimit * slotsPerOrphan} is not strictly less than RESCUE_LIMIT ` +
			`(${rescueLimit}). Fix the constants (never suppress this check) — ` +
			"ops/ADR-JANITOR.md §2.1."
		);
	}
}

assertOrphanFlowInvariant(DETECT_LIMIT_STEADY, RESCUE_LIMIT_STEADY, SLOTS_PER_ORPHAN_STEADY, "steady");
assertOrphanFlowInvariant(DETECT_LIMIT_BACKLOG, RESCUE_LIMIT_BACKLOG, SLOTS_PER_ORPHAN_BACKLOG, "backlog");

export async function runOrphanTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	let changes = 0;
	let proposals_created = 0;
	let truncatedByDeadline = false;

	const rescueLimit = context.backlogMode ? RESCUE_LIMIT_BACKLOG : RESCUE_LIMIT_STEADY;
	const detectLimit = context.backlogMode ? DETECT_LIMIT_BACKLOG : DETECT_LIMIT_STEADY;
	const maxRescueAttempts = context.backlogMode ? MAX_RESCUE_ATTEMPTS_BACKLOG : MAX_RESCUE_ATTEMPTS_STEADY;

	// ---- Phase 1: Detect new orphans ----

	// No pre-read of the existing orphan list here: markOrphans dedupes at the write
	// (ON CONFLICT DO NOTHING), and both backends clamp listOrphans to 200 rows, so
	// the old 5000-row "cap reached" guard was a query that could never fire.

	// findOrphanCandidates does the full filter in SQL — no links loaded into JS memory.
	// detectLimit is 0 in backlog mode by design (DETECT_LIMIT_BACKLOG) — skip the call
	// entirely rather than ask the storage layer for zero rows.
	//
	// ops/ADR-JANITOR.md §2.1 "instance sixteen" (Eli's hold, released): this used to
	// pass context.arrivalBoundary as a THIRD constraint whenever present — "created
	// before cutoffDate AND touched since the last successful run." That pairs a
	// StateWindow question ("is this row currently 14+ days old, right now") with an
	// ArrivalBoundary filter ("and did something write to it in roughly the last
	// day"), and an orphan (access_count <= 1 by definition) is exactly the row least
	// likely to have been touched recently — so the AND clause returned empty on
	// almost every real steady-mode run. The hold on removing it was "un-suppressing
	// detection mid-drain floods a queue that can't drain"; that premise is gone as of
	// the DETECT_LIMIT_STEADY derivation above (module-load-asserted against
	// RESCUE_LIMIT_STEADY — detection cannot outrun the drain by construction now), so
	// the arrival argument is dropped entirely. Both former branches collapse to one
	// call with no third argument — this task always asks "is this row old," never
	// "was this row touched recently," so it should never have threaded an
	// ArrivalBoundary through in the first place.
	//
	// 🔴 Two numbers move in a direction that looks like regression while this
	// actually gets healthier: orphan_count will climb for a while — that's the
	// backlog that was invisible under the old empty-AND becoming visible, not a
	// new fault. oldest_days was already fixed independently (b47c897's
	// FILTER (WHERE status = 'orphaned') on MIN(first_marked), both backends) and
	// is unaffected by this change.
	const cutoffDate = new Date(Date.now() - ORPHAN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString() as StateWindow;
	const candidates = detectLimit > 0
		? await storage.findOrphanCandidates(cutoffDate, detectLimit)
		: [];

	// Skip metabolized observations (already processed), then mark the rest in ONE
	// write. Marking individually cost up to one subrequest per candidate — the
	// single biggest burn in the nightly run, and enough on its own to exhaust the
	// invocation before the later stages ever ran.
	const toMark = candidates
		.filter(obs => obs.texture?.charge_phase !== "metabolized")
		.map(obs => obs.id);

	// Guarded: batching made one write responsible for the whole detection phase, so
	// one bad batch now throws past Phase 2 as well — silently killing rescue for
	// this tenant every night while the daemon-tasks heartbeat still reads complete.
	// Detection can wait a night; rescue draining the backlog cannot.
	try {
		changes += await storage.markOrphans(toMark);
	} catch (err) {
		console.error("orphans: markOrphans failed, continuing to rescue:", err instanceof Error ? err.message : err);
	}

	// ---- Phase 2: Rescue orphans ----

	// Work on active orphans only
	const activeOrphans = await storage.listOrphans("orphaned", rescueLimit);

	// Split the two branches up front so the existence check and the attempt
	// increment can each be a single call instead of one per orphan.
	const exhausted = activeOrphans.filter(o => o.rescue_attempts >= maxRescueAttempts);
	const rescuable = activeOrphans.filter(o => o.rescue_attempts < maxRescueAttempts);

	// Vector search stays per-orphan — it is a per-source query, irreducible.
	// Deadline check at the top: ops/ADR-JANITOR.md §2/§9 commit 4 — this loop is the
	// dominant wall-clock cost (~650ms/query, ADR-RETRIEVAL-FUSION-RETUNE §6), so it's
	// the one most likely to still be running when the budget runs out. Only orphans
	// actually reached (attemptedOrphanIds) get their rescue attempt incremented below
	// — one NOT reached tonight was never attempted and must not burn its budget,
	// which matters more than ever now that backlog mode drops MAX_RESCUE_ATTEMPTS to 1.
	const rescueTargets = new Map<string, { targetId: string; similarity: number }>();
	const attemptedOrphanIds: string[] = [];
	for (const orphan of rescuable) {
		if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
			truncatedByDeadline = true;
			break;
		}
		attemptedOrphanIds.push(orphan.observation_id);
		const similar = await storage.findSimilarUnlinked(orphan.observation_id, 3);
		if (similar.length > 0) {
			rescueTargets.set(orphan.observation_id, {
				targetId: similar[0].observation.id,
				similarity: similar[0].similarity
			});
		}
	}

	// ONE existence check for both branches (was one proposalExists per orphan).
	const existing = await storage.batchProposalExists([
		...exhausted.map(o => ({ type: "orphan_rescue", sourceId: o.observation_id, targetId: o.observation_id })),
		...[...rescueTargets].map(([sourceId, t]) => ({ type: "orphan_rescue", sourceId, targetId: t.targetId }))
	]);

	// Exhausted orphans: propose archival. No attempt increment — matches the
	// original early-`continue`, which skipped both the increment and the counter.
	for (const orphan of exhausted) {
		if (existing.has(proposalKey("orphan_rescue", orphan.observation_id, orphan.observation_id))) continue;
		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: "orphan_rescue",
			source_id: orphan.observation_id,
			target_id: orphan.observation_id,
			confidence: 0.9,
			rationale: `Orphan failed ${maxRescueAttempts} rescue attempts. Proposing archival.`,
			metadata: { action: "archive" },
			status: "pending"
		});
		proposals_created++;
	}

	// Rescuable orphans: propose the nearest unlinked neighbour where we found one.
	for (const orphan of rescuable) {
		const best = rescueTargets.get(orphan.observation_id);
		if (!best) continue;
		if (existing.has(proposalKey("orphan_rescue", orphan.observation_id, best.targetId))) continue;
		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: "orphan_rescue",
			source_id: orphan.observation_id,
			target_id: best.targetId,
			similarity: best.similarity,
			confidence: best.similarity,
			rationale: `Orphan rescue: nearest unlinked observation (similarity ${Math.round(best.similarity * 100)}%)`,
			metadata: {},
			status: "pending"
		});
		proposals_created++;
	}

	// Every rescuable orphan ACTUALLY REACHED this cycle counts as an attempt,
	// proposal or not — same as the original per-orphan increment, now scoped to
	// attemptedOrphanIds rather than every `rescuable` id so a deadline break never
	// burns an attempt budget on an orphan whose vector search never ran. Identical
	// to the pre-deadline behavior whenever the loop above completes without
	// truncating (attemptedOrphanIds === rescuable in that case).
	changes += await storage.incrementRescueAttempts(attemptedOrphanIds);

	return {
		task: "orphans",
		changes,
		proposals_created,
		...(truncatedByDeadline ? { truncated_by_deadline: true } : {})
	};
}
