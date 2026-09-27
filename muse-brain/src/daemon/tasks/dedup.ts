// ============ DAEMON TASK: CORPUS DEDUP SCAN ============
// ops/ADR-JANITOR.md §6. Moved out of kit-hygiene.ts (§0.4/§6.1), which could
// never actually fire: it was a corpus-level operation living inside a
// per-agent loop, bounded by a per-night recency window, filtered by
// findSimilarUnlinked's anti-duplicate exclusions (wrong for dedup — a pair the
// orphan-rescue linker already linked is exactly what dedup needs to see), and
// gated at DEDUP_SIMILARITY = 0.92, above the corpus's measured cosine ceiling
// (0.802, ADR-RETRIEVAL-FUSION-RETUNE §0). Every one of those was a category
// error; tuning any single constant fixed nothing.
//
// This task is corpus-wide (not per-agent), takes no arrival-boundary window (the
// bounded slice below is its own, independent bound), and pushes a similarity
// floor into the new findSimilarByEmbedding primitive (§6.2) instead of
// filtering afterward.
//
// §5.0's canonical shadow definition applies verbatim, with dedup's own gating
// mechanism standing in for the boolean flag salience_regrade uses: shadow IS
// the absence of a configured `daemon_config.data.dedup_similarity_threshold`
// (§6.3 — "the live path ships with NO default threshold"). The task always
// runs its full candidate scan and writes a bounded ScanRecord; it creates
// proposals only once an operator has written a measured threshold. §3's
// "do not unify the two safety mechanisms" applies here too: regrade ships
// shadow-default-ON (a judgment nobody made yet); dedup ships
// threshold-with-no-default (a constant nobody measured yet). Different
// mechanisms for different reasons — do not collapse them into one shape.
//
// Registered FIRST in daemon/index.ts's runDaemonTasks() (§8 — "step 0"): the
// scan is read-only and must capture the corpus's pre-drain cosine baseline
// before the orphan-rescue/absorption stages rewrite the link graph.

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonRunContext, DaemonTaskResult, DedupSample, ScanRecord } from "../types";
import { getTimestamp } from "../../helpers";
import type { Observation } from "../../types";

/**
 * How many source observations this run's scan probes via
 * findSimilarByEmbedding. Same per-item cost profile as orphans.ts's rescue
 * loop (~650 ms/query, ADR-JANITOR.md §2) — same order of magnitude as
 * orphans.ts's steady-mode RESCUE_LIMIT_STEADY (50), deliberately modest since
 * this task now runs as sequence step 0, ahead of every other daemon task, and
 * must leave the shared JANITOR_BUDGET_MS headroom for orphans' own much
 * larger backlog-mode window (200).
 *
 * Recency-biased by construction (queryObservations's default order_by:
 * "created" desc, same call shape as proposals.ts) — a deliberate, not
 * accidental, choice: near-duplicates are more likely between temporally close
 * observations (the same conversation repeating a thought) than between an
 * entry from January and one from September, and this codebase has no rotation
 * cursor to sweep older slices without adding one (out of scope, §6.1 —
 * "additive, not a redesign"). Flagged, not built: if Rook wants full-corpus
 * coverage over multiple nights, that needs a cursor in daemon_config.data.
 */
const SCAN_SOURCE_LIMIT = 50;

/** Per-source candidate fan-out — same as kit-hygiene's old per-observation limit. */
const CANDIDATES_PER_SOURCE = 5;

/**
 * Bounds the SCAN's own SQL cost/relevance — NOT the live decision gate. The
 * live threshold (§6.3) has no default and is chosen by Rook from THIS scan's
 * own measured distribution; this floor only needs to sit comfortably below
 * the corpus's measured range (0.65-0.79, max 0.802,
 * ADR-RETRIEVAL-FUSION-RETUNE §0) so the scan can't miss anything worth
 * surfacing while still bounding the lateral join's candidate set.
 */
const SCAN_SIMILARITY_FLOOR = 0.5;

/** ops/ADR-JANITOR.md §6.3 — "record the top-50 pairs by cosine." */
const DEDUP_SAMPLE_SIZE = 50;

/**
 * ops/ADR-JANITOR.md §6.4 point 4 (extended by §5.2's eighth clause, §2.1):
 * never propose dedup where either side is foundational, territory='self', an
 * anchor's triggers_memory_id target, or already metabolized. Hard exclusion,
 * never a confidence threshold — applied to BOTH the source and the candidate
 * side of every pair, in both shadow and live modes, so candidates_total
 * already previews exactly what live mode would consider (same discipline as
 * findSalienceRegradeCandidates's protection list).
 */
function isProtected(obs: Observation, anchorTargetIds: ReadonlySet<string>): boolean {
	if (obs.texture?.salience === "foundational") return true;
	if (obs.territory === "self") return true;
	if (obs.texture?.charge_phase === "metabolized") return true;
	if (anchorTargetIds.has(obs.id)) return true;
	return false;
}

function summarize(obs: Observation): string {
	return (obs.summary ?? obs.content).slice(0, 120);
}

export async function runDedupTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	if (typeof storage.findSimilarByEmbedding !== "function") {
		return { task: "dedup", changes: 0, proposals_created: 0 };
	}

	const [config, anchors, sourceBatch] = await Promise.all([
		storage.readDaemonConfig(),
		storage.readAnchors(),
		storage.queryObservations({ limit: SCAN_SOURCE_LIMIT, order_by: "created", order_dir: "desc" })
	]);

	const anchorTargetIds = new Set(
		anchors.map(a => a.triggers_memory_id).filter((id): id is string => Boolean(id))
	);

	const data = (config.data ?? {}) as Record<string, unknown>;
	// Absent = shadow (§6.3/§5.0's canonical definition) — dedup's own "shadow"
	// IS the absence of a configured threshold, not a separate boolean flag the
	// way salience_regrade_shadow/backlog_mode are. §3 (this ADR): do not unify
	// the two safety mechanisms.
	//
	// BEFORE setting this: `mind_wake`/`mind_health`'s `janitor.dedup.scanned_last_run`
	// is how many source observations the scan that produced your candidate
	// distribution actually looked at (SCAN_SOURCE_LIMIT above, recency-ordered,
	// no rotation cursor — §6.1/§6.3). Setting a threshold turns proposals on for
	// THAT slice's distribution; it does not make the scan examine more of the
	// corpus. Compare `scanned_last_run` against the corpus total
	// (`brain_health.total`) before assuming a chosen floor generalizes.
	const configuredThreshold = typeof data.dedup_similarity_threshold === "number"
		? data.dedup_similarity_threshold
		: undefined;

	const sources = sourceBatch
		.map(row => row.observation)
		.filter(obs => !isProtected(obs, anchorTargetIds));

	const pairs = new Map<string, DedupSample>();
	let truncatedByDeadline = false;

	for (const source of sources) {
		if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
			truncatedByDeadline = true;
			break;
		}
		const similar = await storage.findSimilarByEmbedding(source.id, CANDIDATES_PER_SOURCE, SCAN_SIMILARITY_FLOOR);
		for (const candidate of similar) {
			if (isProtected(candidate.observation, anchorTargetIds)) continue;
			// Canonical (sorted) source/target order, not discovery order — a pair
			// found from both directions (A scanned first finds B, or B scanned
			// first finds A) is one candidate AND stores identically either way.
			// Without this, the same unordered pair could be inserted as (A,B) one
			// night and (B,A) another (e.g. A ages out of SCAN_SOURCE_LIMIT), and
			// both `proposalExists` and the DB's directional unique index would
			// miss the second as a duplicate.
			const [lo, hi] = source.id < candidate.observation.id
				? [source, candidate.observation]
				: [candidate.observation, source];
			const pairKey = `${lo.id}|${hi.id}`;
			if (pairs.has(pairKey)) continue;
			pairs.set(pairKey, {
				source_id: lo.id,
				target_id: hi.id,
				source_summary: summarize(lo),
				target_summary: summarize(hi),
				similarity: candidate.similarity
			});
		}
	}

	const ordered = [...pairs.values()].sort((a, b) => b.similarity - a.similarity);

	// A preview computed identically whether a threshold is configured or not —
	// zero when nothing is configured, since there is no gate to preview passing
	// (§6.3: no default, no invented value here).
	const wouldCreate = configuredThreshold !== undefined
		? ordered.filter(pair => pair.similarity >= configuredThreshold).length
		: 0;

	const scan: ScanRecord<DedupSample> = {
		at: getTimestamp(),
		population_total: sources.length,
		candidates_total: ordered.length,
		would_create: wouldCreate,
		created: 0,
		sample: ordered.slice(0, DEDUP_SAMPLE_SIZE),
		sample_truncated_to: Math.min(ordered.length, DEDUP_SAMPLE_SIZE)
	};

	if (configuredThreshold === undefined) {
		return {
			task: "dedup",
			changes: 0,
			proposals_created: 0,
			scan,
			...(truncatedByDeadline ? { truncated_by_deadline: true } : {})
		};
	}

	let proposals_created = 0;
	for (const pair of ordered) {
		if (pair.similarity < configuredThreshold) continue;
		if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
			truncatedByDeadline = true;
			break;
		}
		const exists = await storage.proposalExists("dedup", pair.source_id, pair.target_id);
		if (exists) continue;
		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: "dedup",
			source_id: pair.source_id,
			target_id: pair.target_id,
			similarity: pair.similarity,
			// §6.4 point 1 — the accept path (tools-v2/propose.ts) reads this to name
			// the link it creates. Never overridden by a reviewer the way "link"
			// proposals allow (RESONANCE_TYPES doesn't even list it — see propose.ts).
			resonance_type: "duplicate",
			confidence: pair.similarity,
			rationale: `Near-duplicate pair (similarity ${Math.round(pair.similarity * 100)}%)`,
			metadata: {},
			status: "pending"
		});
		proposals_created++;
	}

	scan.created = proposals_created;

	return {
		task: "dedup",
		changes: 0,
		proposals_created,
		scan,
		...(truncatedByDeadline ? { truncated_by_deadline: true } : {})
	};
}
