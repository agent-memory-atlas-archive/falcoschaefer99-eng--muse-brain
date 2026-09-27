// ============ DAEMON ORCHESTRATOR (Sprint 4 + Sprint 6 + Sprint 7) ============
// Runs all daemon intelligence tasks in order.
// Execution order: dedup (shadow scan) → proposals → absorption → learning →
// cascade → orphans → absorption (2nd pass) → salience-regrade → kit-hygiene →
// skill-health → cross-agent → cross-tenant → paradox-detection →
// recall-contracts → task-scheduling.
// Dedup runs first of all — ops/ADR-JANITOR.md §8 ("step 0"): its scan is
// read-only and must capture the corpus's pre-drain cosine baseline before the
// orphan-rescue/absorption stages below rewrite the link graph.
// Proposals next — it's the primary feature and uses the fewest subrequests.
// Absorption runs IMMEDIATELY after proposals, before the expensive scans: it eats
// fresh high-confidence proposals while the Cloudflare subrequest budget is still
// full (the orphan scan alone can exhaust it — confidence-1.0 orphan_rescue
// proposals sat unabsorbed after live crons when absorption ran last), and its
// accepts feed the learning task's acceptance ratios the same night.
// A SECOND absorption pass runs right after orphans (ops/ADR-JANITOR.md §2/§9
// commit 4): orphan_rescue/archive proposals are CREATED in the orphans task, but
// the first absorption pass already ran two tasks earlier, so without a second
// call every archive proposal from tonight's drain would sit pending a full night
// before absorption ever saw it. This does NOT move the first pass — learning
// (task 3) still sees exactly the inputs ADR-BRAIN-METABOLIC-ORGANISM.md §2
// intended, since it runs before orphans and the second pass both.
// Each task is isolated — failures don't cascade.

import type { IBrainStorage } from "../storage/interface";
import type { DaemonTaskResult } from "./types";
import type { DaemonRunContext } from "./types";

import { runCascadeTask } from "./tasks/cascade";
import { runOrphanTask } from "./tasks/orphans";
import { runAbsorptionTask } from "./tasks/absorption";
import { runProposalTask } from "./tasks/proposals";
import { runLearningTask } from "./tasks/learning";
import { runKitHygieneTask } from "./tasks/kit-hygiene";
import { runSkillHealthTask } from "./tasks/skill-health";
import { runCrossAgentTask } from "./tasks/cross-agent";
import { runCrossTenantTask } from "./tasks/cross-tenant";
import { runParadoxDetectionTask } from "./tasks/paradox-detection";
import { runRecallContractsTask } from "./tasks/recall-contracts";
import { runTaskSchedulingTask } from "./tasks/task-scheduling";
import { runSalienceRegradeTask } from "./tasks/salience-regrade";
import { runDedupTask } from "./tasks/dedup";

export async function runDaemonTasks(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult[]> {
	const results: DaemonTaskResult[] = [];

	// 0. Dedup — corpus-wide near-duplicate shadow scan (ops/ADR-JANITOR.md §6,
	// §8 step 0). Read-only until an operator configures a measured threshold;
	// runs before every other task specifically so it sees the corpus BEFORE
	// the orphan-rescue/absorption stages below rewrite the link graph.
	try {
		const result = await runDedupTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "dedup",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 1. Proposals — generate link proposals from vector similarity
	try {
		const result = await runProposalTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "proposals",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 2. Auto-absorption — digest high-confidence proposals immediately, while the
	// subrequest budget is still full (see header rationale)
	try {
		const result = await runAbsorptionTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "absorption",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 3. Learning — adaptive threshold adjustment (sees tonight's absorption accepts)
	try {
		const result = await runLearningTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "learning",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 4. Memory cascade — record charge-based co-occurrence pairs
	try {
		const result = await runCascadeTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "cascade",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 5. Orphans — detect and attempt rescue (the expensive scan; may exhaust the
	// remaining subrequest budget, which is why absorption already ran)
	try {
		const result = await runOrphanTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "orphans",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 5b. Second absorption pass — see header rationale. Orphan-rescue/archive
	// proposals created just above wait until tomorrow night otherwise.
	try {
		const result = await runAbsorptionTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "absorption",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 5c. Salience re-grade — foundational demotion proposals (ops/ADR-JANITOR.md
	// §5). Corpus-level, same as the dedup scan above — but placed after
	// orphans/absorption rather than before proposals (unlike dedup, which runs
	// first, §8 step 0), since it doesn't feed or consume anything those earlier
	// tasks produce, and this position keeps every per-observation-write task
	// (orphans' archival metabolizes, absorption's accepts) settled before this
	// run's own read of charge_phase/foundational state, avoiding same-cycle
	// ordering ambiguity even though correctness here doesn't depend on ordering
	// across nights either way.
	try {
		const result = await runSalienceRegradeTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "salience-regrade",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 6. Kit hygiene — per-agent consolidation and dedup proposals
	try {
		const result = await runKitHygieneTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "kit-hygiene",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 7. Skill health — stale accepted skills + candidate drift proposals
	try {
		const result = await runSkillHealthTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "skill-health",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 8. Cross-agent synthesis — convergent findings across different agent entities
	try {
		const result = await runCrossAgentTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "cross-agent",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 9. Cross-tenant proposals — shared territory convergence (craft, philosophy only)
	try {
		const result = await runCrossTenantTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "cross-tenant",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 10. Paradox detection — identity cores challenged 3+ times without a paradox loop
	try {
		const result = await runParadoxDetectionTask(storage, context);
		results.push(result);
	} catch (err) {
		results.push({
			task: "paradox-detection",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 11. Recall contracts — materialize due recall contracts into tasks/proposals
	try {
		const result = await runRecallContractsTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "recall-contracts",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	// 12. Task scheduling — advance scheduled tasks to open when their scheduled_wake passes
	try {
		const result = await runTaskSchedulingTask(storage);
		results.push(result);
	} catch (err) {
		results.push({
			task: "task-scheduling",
			changes: 0,
			proposals_created: 0,
			error: err instanceof Error ? err.message : "unknown error"
		});
	}

	return results;
}
