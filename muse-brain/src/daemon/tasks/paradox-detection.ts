// ============ DAEMON TASK: PARADOX DETECTION ============
// v1 simplified approach: detect identity cores that have been challenged
// repeatedly without a paradox loop existing.
//
// If a core was challenged 3+ times in the last 30 days and no paradox
// open_loop (mode='paradox') exists linked to it, propose a paradox loop.
//
// This is intentionally conservative — false positives (proposing a paradox
// that isn't real) are less harmful than missing genuine tension.

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonTaskResult, ParadoxSample, ScanRecord } from "../types";
import type { DaemonRunContext } from "../types";
import { getTimestamp } from "../../helpers";

const CHALLENGE_THRESHOLD = 3;
const LOOKBACK_DAYS = 30;

/**
 * ops/ADR-JANITOR.md §7-style breadcrumb (see ScanRecord.sample). Identity core
 * populations are small by construction (Eli's own worked example: 41 cores) —
 * this only bounds the sample the way DEDUP_SAMPLE_SIZE bounds dedup.ts's, not
 * a throughput cap (this task has no cap: every real candidate gets a proposal).
 */
const PARADOX_SAMPLE_SIZE = 20;

// `context` is unused below (see the comment at the challenge filter for why
// arrivalBoundary must not be used here) — kept in the signature only for parity
// with every sibling daemon task's call shape in daemon/index.ts.
export async function runParadoxDetectionTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	let proposals_created = 0;
	const candidates: ParadoxSample[] = [];

	// Get all identity cores
	const cores = await storage.readIdentityCores();
	if (cores.length === 0) {
		const scan: ScanRecord<ParadoxSample> = {
			at: getTimestamp(),
			population_total: 0,
			candidates_total: 0,
			would_create: 0,
			created: 0,
			sample: [],
			sample_truncated_to: 0
		};
		return { task: "paradox-detection", changes: 0, proposals_created: 0, scan };
	}

	const cutoffDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

	// Get existing paradox open_loops to check if one already covers a given core
	const allLoops = await storage.readOpenLoops();
	const paradoxLoops = allLoops.filter(loop => loop.mode === "paradox");

	for (const core of cores) {
		// Deliberately NOT context.arrivalBoundary (an ArrivalBoundary — see
		// daemon/types.ts). Sibling dailies (cascade, orphans, cross-agent, ...)
		// are incremental scans — they only need to see rows written since the
		// last successful cycle, so an arrival boundary (~24h under the real
		// nightly cadence) is the right, cheaper instrument. This task asks a
		// different question: "does this core CURRENTLY carry 3+ challenges within
		// the last 30 days" — a StateWindow check over a fixed window whose answer
		// changes as the clock moves, not only when a new challenge is written.
		// Swapping in an arrival boundary here silently shrinks that 30-day window
		// to ~24h and requires 3 challenges to the same core in one day before the
		// task will ever propose — it produced zero proposals in production for
		// this reason. Always use the full cutoffDate.
		const recentChallenges = (core.challenges ?? []).filter(c => c.date >= cutoffDate);
		if (recentChallenges.length < CHALLENGE_THRESHOLD) continue;

		// Candidate the moment the window filter clears it — before the
		// already-covered checks below, which gate CREATION, not candidacy
		// (population_total/candidates_total in the returned scan must stay
		// legible even when every candidate already has a loop or proposal).
		const rationale = `Identity core "${core.name}" was challenged ${recentChallenges.length} times in the last ${LOOKBACK_DAYS} days — paradox loop may be needed`;
		candidates.push({
			core_id: core.id,
			core_name: core.name,
			challenge_count: recentChallenges.length,
			rationale
		});

		// Check if a paradox loop already exists linked to this core
		const alreadyHasParadox = paradoxLoops.some(loop =>
			loop.linked_entity_ids?.includes(core.id)
		);
		if (alreadyHasParadox) continue;

		// Check if a paradox_detected proposal already exists for this core
		const proposalExists = await storage.proposalExists("paradox_detected", core.id, core.id);
		if (proposalExists) continue;

		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: "paradox_detected",
			source_id: core.id,
			target_id: core.id,
			confidence: Math.min(0.5 + recentChallenges.length * 0.1, 0.95),
			rationale,
			metadata: {
				core_id: core.id,
				core_name: core.name,
				challenge_count: recentChallenges.length,
				recent_challenges: recentChallenges.slice(0, 3).map(c => ({
					description: c.description,
					date: c.date
				}))
			},
			status: "pending"
		});
		proposals_created++;
	}

	// No throughput cap exists for this task (unlike dedup/regrade) — every real
	// candidate not already covered by a loop or a pending proposal gets a
	// proposal, every run. would_create therefore always equals created here;
	// both are surfaced (rather than would_create being derived from created at
	// the read site) so this task's scan carries the same shape as its siblings
	// and a future cap doesn't require a schema change.
	const scan: ScanRecord<ParadoxSample> = {
		at: getTimestamp(),
		population_total: cores.length,
		candidates_total: candidates.length,
		would_create: proposals_created,
		created: proposals_created,
		sample: candidates.slice(0, PARADOX_SAMPLE_SIZE),
		sample_truncated_to: Math.min(candidates.length, PARADOX_SAMPLE_SIZE)
	};

	return { task: "paradox-detection", changes: 0, proposals_created, scan };
}
