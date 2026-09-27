// ============ DAEMON HEARTBEAT (nightly stage tracing) ============
// A killed cron invocation leaves no trace: when Cloudflare cuts the run for
// exceeding the subrequest/CPU budget, the failure is uncatchable, so no catch
// block fires and nothing is logged. That is why runAiProposalReview silently
// never ran on the first live dogfood night (2026-07-28) — it took a manual
// SQL dig into daemon_config to find out.
//
// This writes a breadcrumb per tenant into daemon_config.data.last_daemon_run:
//   { started_at, completed_stages: string[], finished_at | null }
//
// Morning diagnosis:
//   SELECT tenant_id, data->'last_daemon_run' FROM daemon_config;
// finished_at null => the invocation died, and completed_stages names the last
// stage that survived.
//
// Cost is deliberately 3 writes per tenant, not one per stage:
//   1. as soon as the first stage completes — a very early death still leaves
//      started_at plus one stage
//   2. after each CHECKPOINT_STAGE — currently just the daemon task sweep, the
//      most expensive stage and the one that ate the budget on 2026-07-28. This
//      is what splits a death into before / inside / after the sweep.
//   3. at the very end, stamping finished_at.

import type { IBrainStorage } from "../storage/interface";
import type { DedupSample, NoveltyScanRecord, ParadoxSample, RegradeSample, ScanRecord, ValenceFloorResult } from "./types";

export interface DaemonRunTrace {
	started_at: string;
	completed_stages: string[];
	finished_at: string | null;
	/**
	 * Set only when the run died from a THROWN error we caught. Its absence on an
	 * unfinished run is the tell for a Cloudflare budget kill, which is uncatchable
	 * and therefore can never write anything. Without this field the two look
	 * identical in the morning, and the heartbeat would be forging its own evidence.
	 */
	error?: string;
	/**
	 * Names of stages that actually failed, as opposed to merely being reached —
	 * `completed_stages` means "this stage was entered," not "this stage succeeded"
	 * (a caught per-stage error still lets the cycle proceed to the next stage).
	 * Omitted entirely on a healthy run, same convention as `error`.
	 */
	failed_stages?: string[];
	/**
	 * Set true when a long-running loop (orphan rescue, AI review, dedup's
	 * per-source vector scan) broke early because DaemonRunContext.deadlineAt was
	 * reached. Written via markTruncatedByDeadline() — the AI review loop
	 * (ai-review.ts), the orphan rescue loop (tasks/orphans.ts), and dedup's scan
	 * loop (tasks/dedup.ts, commit 8) all call it and cycle.ts checks each stage's
	 * outcome (ops/ADR-JANITOR.md §9 commit 4).
	 */
	truncated_by_deadline?: boolean;
}

type HeartbeatStorage = Pick<IBrainStorage, "readDaemonConfig" | "updateDaemonConfigData">;

/**
 * daemon_config.data keys allowed to ride along on finish()'s one end-of-cycle
 * write. This is the single source of truth for what's legitimate here — a
 * caller reaching for an untyped grab-bag key belongs in a real field on this
 * interface, documented, not a silent addition to an anonymous object.
 */
export interface CycleBookkeeping {
	/** How many orphans THIS run drained (rescued+archived) — see cycle.ts. */
	last_orphan_drain?: { count: number; at: string };
	/**
	 * How many NEW orphan rows THIS run's detection phase actually inserted —
	 * the backlog that C2's fix (ops/ADR-JANITOR.md §2.1 "instance sixteen")
	 * makes visible for the first time, published beside last_orphan_drain so a
	 * reader sees both sides of the flow, not just the drain. Computed the same
	 * way as last_orphan_drain: a before/after getOrphanStats() diff around the
	 * whole cycle (orphaned+rescued+archived total — orphan_observations rows
	 * are never deleted, only re-statused, so this total only grows via
	 * markOrphans' INSERT), never a second query. See cycle.ts.
	 */
	last_orphan_detect?: { count: number; at: string };
	/**
	 * ops/ADR-JANITOR.md §5 commit 7b (fields: commit 7c, §2.1 instance nine) —
	 * the salience-regrade task's own scan record for this run
	 * (population/candidates/would-create/created/sample), folded into this
	 * same end-of-cycle write rather than a write of its own. Read by
	 * tools-v2/wake.ts's buildJanitorHealth to populate
	 * JanitorHealth.regrade.{candidates_last_scan,created_last_run,would_create_last_run,scan_at}.
	 */
	last_regrade_scan?: ScanRecord<RegradeSample>;
	/**
	 * ops/ADR-JANITOR.md §6.3 commit 8 — dedup's own scan record for this run
	 * (population/candidates/would-create/created/top-50-by-cosine sample),
	 * folded into this same end-of-cycle write, same convention as
	 * last_regrade_scan above. `readCrossTenantBoundary()` (daemon/context.ts)
	 * deliberately does not surface this — it is per-tenant only.
	 */
	last_dedup_scan?: ScanRecord<DedupSample>;
	/**
	 * paradox-detection's own scan record for this run (identity-core
	 * population/candidates/created, no throughput cap), folded into this same
	 * end-of-cycle write, same convention as last_regrade_scan/last_dedup_scan
	 * above. Read by tools-v2/wake.ts's buildJanitorHealth to populate
	 * JanitorHealth.paradox.
	 */
	last_paradox_scan?: ScanRecord<ParadoxSample>;
	/**
	 * fix(brain): novelty exists as a dimension again — cycle.ts's inline "novelty"
	 * stage's own scan record for this run (population/candidates/created, no
	 * throughput cap, same convention as last_paradox_scan above), folded into
	 * this same end-of-cycle write. Unlike the three scans above, this stage is
	 * NOT a runDaemonTasks() task — cycle.ts builds it directly, not via
	 * DaemonTaskResult.scan. `NoveltyScanRecord`, not the bare `ScanRecord`, as
	 * of B4 (ops/ADR-JANITOR.md §2.1 "instance sixteen"'s novelty instance) —
	 * carries an extra `never_surfaced_total` field the other three scans have
	 * no equivalent for.
	 */
	last_novelty_scan?: NoveltyScanRecord;
	/**
	 * ops/ADR-VALENCE-FLOOR.md, slice 0 — daemon/cycle.ts's "valence-floor"
	 * stage's own result for this run (not a runDaemonTasks() task — it needs
	 * cycle.ts's already-fetched territoryData, same reuse-not-refetch
	 * rationale as the inline "novelty" stage), folded into this same
	 * end-of-cycle write. Read by tools-v2/wake.ts's buildJanitorHealth to
	 * populate JanitorHealth.valence_floor. The ADR's literal storage key is
	 * `daemon_config.data.valence_floor` — this field name matches it exactly.
	 */
	valence_floor?: ValenceFloorResult;
}

/**
 * Stages worth a mid-run write. Keep this set tiny — every entry costs one read
 * plus one write per tenant per night. A stage earns a slot by being expensive
 * enough that "did we survive it?" is the question you'll actually be asking.
 */
export const CHECKPOINT_STAGES = new Set(["daemon-tasks"]);

export class DaemonHeartbeat {
	private readonly startedAt: string;
	private readonly stages: string[] = [];
	private readonly failedStages: string[] = [];
	private persistedFirstStage = false;
	private error: string | null = null;
	private truncatedByDeadline = false;

	constructor(private readonly storage: HeartbeatStorage, startedAt: string = new Date().toISOString()) {
		this.startedAt = startedAt;
	}

	/** Record that a stage finished. Persists on the first stage and on checkpoints. */
	async stageComplete(stage: string): Promise<void> {
		this.stages.push(stage);
		const isFirst = !this.persistedFirstStage;
		this.persistedFirstStage = true;
		if (!isFirst && !CHECKPOINT_STAGES.has(stage)) return;
		await this.persist(null);
	}

	/**
	 * Close the run out: final stage list plus finished_at.
	 * `extraData` merges additional daemon_config.data keys into this SAME write
	 * (e.g. a drain breadcrumb) — callers must never add a separate
	 * updateDaemonConfigData call of their own here; this is the one write budget
	 * for end-of-cycle bookkeeping (see daemon-cycle-order.spec.ts's
	 * "exactly three writes per tenant" pin).
	 */
	async finish(finishedAt: string = new Date().toISOString(), extraData?: CycleBookkeeping): Promise<void> {
		await this.persist(finishedAt, extraData);
	}

	/**
	 * Close the run out as FAILED: stamps finished_at plus the error that killed it.
	 * Use this on the catch path so tomorrow morning can tell a thrown error apart
	 * from an uncatchable budget kill.
	 */
	async fail(error: string, finishedAt: string = new Date().toISOString()): Promise<void> {
		this.error = error;
		await this.persist(finishedAt);
	}

	/**
	 * Record that a long-running loop (orphan rescue, AI review, dedup scan) broke
	 * early because DaemonRunContext.deadlineAt was reached (ops/ADR-JANITOR.md §2,
	 * §9 commit 4 — the first writer of a field commit 1 only typed). Synchronous —
	 * no write of its own; the flag rides whichever persist() call comes next
	 * (stageComplete/stageFailed/finish), same as the error/failedStages fields.
	 * Idempotent and sticky for the rest of this run.
	 */
	markTruncatedByDeadline(): void {
		this.truncatedByDeadline = true;
	}

	/** Mark a stage failed without ending the run; finish() preserves this error. */
	async stageFailed(stage: string, error: string): Promise<void> {
		if (!this.stages.includes(stage)) this.stages.push(stage);
		if (!this.failedStages.includes(stage)) this.failedStages.push(stage);
		this.error = this.error ? `${this.error}; ${stage}: ${error}` : `${stage}: ${error}`;
		if (!this.persistedFirstStage) this.persistedFirstStage = true;
		await this.persist(null);
	}

	/** Current in-memory trace (used by tests and logging). */
	snapshot(finishedAt: string | null = null): DaemonRunTrace {
		return {
			started_at: this.startedAt,
			completed_stages: [...this.stages],
			finished_at: finishedAt,
			// Omitted entirely on a healthy run — presence IS the signal.
			...(this.error === null ? {} : { error: this.error }),
			...(this.failedStages.length === 0 ? {} : { failed_stages: [...this.failedStages] }),
			...(this.truncatedByDeadline ? { truncated_by_deadline: true } : {})
		};
	}

	private async persist(finishedAt: string | null, extraData?: CycleBookkeeping): Promise<void> {
		try {
			// Re-read at write time: postgres updateDaemonConfigData replaces the whole
			// blob, and the AI reviewer writes last_ai_review into it mid-run. Merging a
			// snapshot read at construction time would clobber it.
			const config = await this.storage.readDaemonConfig();
			await this.storage.updateDaemonConfigData({
				...(config.data ?? {}),
				...(extraData ?? {}),
				last_daemon_run: this.snapshot(finishedAt)
			});
		} catch (err) {
			// Best-effort instrumentation — never take the nightly run down with it.
			console.error("Daemon heartbeat write failed:", err instanceof Error ? err.message : "unknown error");
		}
	}
}
