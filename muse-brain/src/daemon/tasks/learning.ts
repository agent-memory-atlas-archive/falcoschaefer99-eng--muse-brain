// ============ DAEMON TASK: ADAPTIVE THRESHOLD LEARNING ============
// Reads proposal acceptance stats for the 'link' type.
// If acceptance ratio < 0.3 (too many rejections), raise threshold by 0.07 (max 0.95).
// If acceptance ratio > 0.8 (too many acceptances), lower threshold by 0.05 (min 0.65).
// Only adjusts if total proposals >= 20 (enough signal).
// Asymmetric to bias toward quality over quantity.
//
// Frozen entirely while context.backlogMode is true (ops/ADR-JANITOR.md §3/§9
// commit 4): a governor tuning a plant whose transfer function is wrong drives
// to a rail — five weeks of evidence it did (threshold pinned at 0.95 since
// 2026-07-30, §0.3). The plan is to measure acceptance on the corrected link
// formula (§3) for 7 nights before letting the ratchet move again. Reads
// context.backlogMode, not a second daemon_config.data.backlog_mode lookup of
// its own — the daemon orchestrator (daemon/index.ts) already reads the flag
// once via readDaemonRunContext() and threads it to every task; a second
// storage read here would be a copy of the same sentinel that has to be kept
// in lockstep by hand instead of a single source of truth.

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonRunContext, DaemonTaskResult } from "../types";

const MIN_THRESHOLD = 0.65;
const MAX_THRESHOLD = 0.95;
const LOW_ACCEPTANCE_THRESHOLD = 0.3;
const HIGH_ACCEPTANCE_THRESHOLD = 0.8;
const RAISE_DELTA = 0.07;
const LOWER_DELTA = 0.05;
const MIN_SAMPLE_SIZE = 20;

export async function runLearningTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	const config = await storage.readDaemonConfig();
	if (context.backlogMode === true) {
		return { task: "learning", changes: 0, proposals_created: 0 };
	}

	const stats = await storage.getProposalStats();
	const linkStats = stats["link"];

	if (!linkStats || linkStats.total < MIN_SAMPLE_SIZE) {
		// Not enough data yet — no adjustment
		return { task: "learning", changes: 0, proposals_created: 0 };
	}

	let threshold = config.link_proposal_threshold;
	const originalThreshold = threshold;

	if (linkStats.ratio < LOW_ACCEPTANCE_THRESHOLD) {
		// Too many rejections — raise bar
		threshold = Math.min(threshold + RAISE_DELTA, MAX_THRESHOLD);
	} else if (linkStats.ratio > HIGH_ACCEPTANCE_THRESHOLD) {
		// Very high acceptance — lower bar slightly to surface more candidates
		threshold = Math.max(threshold - LOWER_DELTA, MIN_THRESHOLD);
	}

	if (threshold !== originalThreshold) {
		await storage.updateProposalThreshold(threshold);
		return { task: "learning", changes: 1, proposals_created: 0 };
	}

	return { task: "learning", changes: 0, proposals_created: 0 };
}
