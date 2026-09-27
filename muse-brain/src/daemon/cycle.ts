import type { Env, Observation, TerritoryOverview, IronGripEntry } from "../types";
import type { IBrainStorage } from "../storage/interface";
import { getTimestamp, generateSummary, calculatePullStrength } from "../helpers";
import { executeTool } from "../tools-v2/index";
import { createEmbeddingProvider } from "../embedding/index";
import { createWorkersAIBindingAdapter } from "../ai/binding";
import type { WorkersAIClient } from "../ai/interface";
import { embedBackfillBatch } from "../embedding/backfill";
import { runDaemonTasks } from "./index";
import { runAiProposalReview } from "./ai-review";
import { runValenceLexiconTask } from "./tasks/valence-lexicon";
import { runValenceFloorTask } from "./tasks/valence-floor";
import { DaemonHeartbeat } from "./heartbeat";
import { readDaemonRunContext } from "./context";
import type { DaemonTaskResult, DedupSample, NoveltyScanRecord, NoveltySample, ParadoxSample, RegradeSample, ScanRecord, ValenceFloorResult } from "./types";

type CycleEnv = Env & { daemonAi?: WorkersAIClient };

export interface DaemonCycleResult { decayChanges: number; noveltyChanges: number; fatal: boolean; ok: boolean; }

// ops/ADR-JANITOR.md §5.2-style sample cap for the novelty stage's own scan
// record (B3) — same order of magnitude as PARADOX_SAMPLE_SIZE (paradox-detection.ts).
const NOVELTY_SAMPLE_SIZE = 20;

// Two tenants x 8 min = 16 min inside the 30-min TimeoutStartSec (ops/rook-brain-daemon.service),
// leaving headroom for the stages outside runDaemonTasks (ai-review, decay, subconscious,
// novelty, overviews, embedding-backfill). See ops/ADR-JANITOR.md §2 — the Cloudflare
// subrequest ceiling this used to budget against is gone; wall clock, shared sequentially
// across every tenant in one invocation, is what actually binds now.
export const JANITOR_BUDGET_MS = 8 * 60_000;

/**
 * Shared shape for the cycle's uniform stages: run fn(), stageComplete() on
 * success, or log + stageFailed(name, message) on a caught error — then move
 * on to the next stage either way. `daemon-tasks` does NOT use this: it
 * aggregates one error per sub-task from runDaemonTasks()'s own result list
 * rather than a single try/catch, so it stays hand-written in the cycle body.
 */
async function runStage(
	heartbeat: DaemonHeartbeat,
	tenant: string,
	name: string,
	fn: () => Promise<void>
): Promise<void> {
	try {
		await fn();
		await heartbeat.stageComplete(name);
	} catch (e) {
		console.error(`Daemon [${tenant}]: ${name} error`, e);
		const message = e instanceof Error ? e.message : String(e);
		await heartbeat.stageFailed(name, message);
	}
}

export async function runTenantCycle(storage: IBrainStorage, tenant: string, env: CycleEnv): Promise<DaemonCycleResult> {
	let decayChanges = 0;
	let noveltyChanges = 0;
	const ai = env.daemonAi ?? (env.AI ? createWorkersAIBindingAdapter(env.AI) : undefined);
	// Read the previous trace before this run starts writing heartbeat state. Only
	// a finished, error-free trace advances the dailies window; a killed or
	// failed run must be replayed by the next metabolism pass.
	const runContext = {
		...(await readDaemonRunContext(storage)),
		...(typeof storage.getAllowedTenants === "function"
			? { allowedTenants: storage.getAllowedTenants() }
			: {}),
		deadlineAt: Date.now() + JANITOR_BUDGET_MS
	};
	const heartbeat = new DaemonHeartbeat(storage, getTimestamp());
	// Snapshot before any task runs, so the end-of-run breadcrumb (folded into
	// heartbeat.finish()'s existing write, see below) can report how many orphans
	// THIS run actually drained (rescued+archived), not a lifetime total. Guarded:
	// a storage mock predating this primitive must not crash the whole cycle over
	// an optional health metric.
	const orphanStatsBeforeRun = typeof storage.getOrphanStats === "function"
		? await storage.getOrphanStats()
		: { orphaned: 0, rescued: 0, archived: 0, oldest_days: 0 };
	try {
	// AI proposal review — Workers AI (cheap 3B model) reviews what auto-absorption
	// left pending (link/orphan_rescue/dedup). Needs env.AI, so it's a standalone
	// call rather than a runDaemonTasks() task (the orchestrator has no AI binding).
	//
	// It runs BEFORE the daemon task sweep on purpose. The reviewer's job is the
	// accumulated pending pile from prior nights, not tonight's fresh proposals
	// (absorption digests the high-confidence ones the moment they're created), so
	// running it first costs nothing in freshness and guarantees it executes on a
	// full subrequest budget. Running it last meant it never executed AT ALL on the
	// first live night — the orphan scan exhausted the invocation before reaching
	// it, and an exhausted invocation dies uncatchably, so nothing was even logged.
	// Bonus: its accepts/rejects now feed the learning task's acceptance ratios
	// within the same run, since learning is daemon task 3.
	// First heartbeat write lands here — an early death still leaves a trace.
	await runStage(heartbeat, tenant, "ai-review", async () => {
		const { reviewed, truncatedByDeadline } = await runAiProposalReview(storage, ai, runContext);
		if (truncatedByDeadline) heartbeat.markTruncatedByDeadline();
		console.log(`Daemon [${tenant}] ai-review: ${reviewed} proposals reviewed`);
	});

	// Sprint 4: Daemon Intelligence tasks run FIRST (before decay pass).
	// Proposals need to see pre-decay charge phases — the decay pass promotes
	// active → processing, narrowing the proposal candidate pool.
	let daemonTaskError: string | undefined;
	let regradeScan: ScanRecord<RegradeSample> | undefined;
	let dedupScan: ScanRecord<DedupSample> | undefined;
	let paradoxScan: ScanRecord<ParadoxSample> | undefined;
	try {
		const daemonResults = await runDaemonTasks(storage, runContext);
		for (const r of daemonResults) {
			const errSuffix = r.error ? ` (error: ${r.error})` : "";
			console.log(`Daemon [${tenant}] ${r.task}: ${r.changes} changes, ${r.proposals_created} proposals${errSuffix}`);
		}
		const failedTasks = daemonResults.filter(result => result.error).map(result => `${result.task}: ${result.error}`);
		if (failedTasks.length > 0) daemonTaskError = failedTasks.join("; ");
		// e.g. runOrphanTask's rescue loop broke early on context.deadlineAt
		// (ops/ADR-JANITOR.md §9 commit 4) — surface it the same way ai-review does.
		if (daemonResults.some(result => result.truncated_by_deadline)) heartbeat.markTruncatedByDeadline();
		// ops/ADR-JANITOR.md §5 commit 7b / §6 commit 8, plus paradox-detection's
		// own scan — all three carried to the third heartbeat write below, never a
		// write of their own (same budget discipline as the orphan drain
		// breadcrumb right after this try/catch). Each task's `scan` field is
		// typed as a union (DaemonTaskResult.scan); narrowing by `task` name here
		// is what tells TypeScript — and a reader — which shape each one actually is.
		regradeScan = daemonResults.find(result => result.task === "salience-regrade")?.scan as ScanRecord<RegradeSample> | undefined;
		dedupScan = daemonResults.find(result => result.task === "dedup")?.scan as ScanRecord<DedupSample> | undefined;
		paradoxScan = daemonResults.find(result => result.task === "paradox-detection")?.scan as ScanRecord<ParadoxSample> | undefined;
	} catch (e) {
		console.error(`Daemon [${tenant}] Sprint 4 error:`, e);
		daemonTaskError = e instanceof Error ? e.message : String(e);
	}
	if (daemonTaskError) await heartbeat.stageFailed("daemon-tasks", daemonTaskError);
	else await heartbeat.stageComplete("daemon-tasks");

	// Decay must complete before any later-stage territory snapshot.
	await runStage(heartbeat, tenant, "decay", async () => {
		decayChanges = typeof storage.runDecay === "function" ? await storage.runDecay() : 0;
		console.log(`Daemon [${tenant}]: ${decayChanges} decay changes`);
	});

	let territoryData: { territory: string; observations: Observation[] }[] = [];
	try {
		territoryData = await storage.readAllTerritories();
	} catch (e) {
		console.error(`Daemon [${tenant}]: territory read error`, e);
	}


	// Subconscious processing (v2 tool dispatch)
	await runStage(heartbeat, tenant, "subconscious", async () => {
		await executeTool("mind_subconscious", { action: "process" }, { storage, ai });
		console.log(`Daemon [${tenant}]: subconscious processed`);
	});

	// Valence lexicon + floor (ops/ADR-VALENCE-FLOOR.md, slice 0 — measurement
	// only, no behavior change). Neither is a runDaemonTasks() task: lexicon
	// needs `ai` (the orchestrator has no AI binding, same reason ai-review
	// lives here rather than daemon/index.ts), and floor is kept on the same
	// call site so ordering — lexicon writes charge_valence rows BEFORE floor
	// reads them, both within this one cycle — is a structural property of
	// this file, not a discipline someone has to remember. Both reuse the
	// territoryData already fetched above; neither re-reads the corpus.
	await runStage(heartbeat, tenant, "valence-lexicon", async () => {
		const result = await runValenceLexiconTask(storage, ai, territoryData);
		console.log(`Daemon [${tenant}] valence-lexicon: ${result.classified_this_run} classified, ${result.unparseable_this_run} unparseable, ${result.deferred_this_run} deferred (ceiling), ${result.unclassified_remaining} unclassified remaining (${result.distinct_charges_total} distinct charges)`);
	});

	let valenceFloorResult: ValenceFloorResult | undefined;
	await runStage(heartbeat, tenant, "valence-floor", async () => {
		valenceFloorResult = await runValenceFloorTask(storage, territoryData);
		console.log(`Daemon [${tenant}] valence-floor: ${valenceFloorResult.seats} seats (measurement only — not consumed by the foundation lane yet)`);
	});

	// Novelty regeneration — boost novelty_score for observations unsurfaced >30 days
	let noveltyScan: NoveltyScanRecord | undefined;
	await runStage(heartbeat, tenant, "novelty", async () => {
		const noveltyTexturesToUpdate: { id: string; texture: Observation["texture"] }[] = [];
		const noveltySample: NoveltySample[] = [];
		let populationTotal = 0;
		let candidatesTotal = 0;
		let neverSurfacedTotal = 0;
		let regeneratedCount = 0;

		for (const { observations } of territoryData) {
			for (const o of observations) {
				if (o.texture?.salience === "foundational") continue;
				populationTotal++;

				if (!o.texture?.novelty_score) {
					if (!o.texture) continue;
					o.texture.novelty_score = 0.5;
					noveltyTexturesToUpdate.push({ id: o.id, texture: o.texture });
					// fix(brain): novelty exists as a dimension again — B2. Was
					// o.texture.last_surfaced_at, a key no writer ever sets (see
					// types.ts's Texture.last_surfaced_at @deprecated doc). The real
					// value lives on Observation.last_surfaced_at (a plain column,
					// mapped through by rowToObservation as of ops/ADR-JANITOR.md
					// §2.1 instance nine) — this branch could never fire on Postgres.
				} else {
					// fix(brain): novelty regeneration skips every memory that was
					// never surfaced — B4. `last_surfaced_at` is NULL for any row
					// `updateSurfacingEffects` has never touched — it is never set
					// at INSERT (storage/postgres.ts's `_insertObservation`/
					// `_executeInsertQueries` column lists omit it entirely, and the
					// column has no schema DEFAULT: migrations/001_initial_schema.sql:74).
					// The old `else if (o.last_surfaced_at)` treated that NULL as
					// "not a candidate," structurally excluding the exact population
					// this stage exists to lift — verified live 2026-09-06: 92.8% of
					// tenant "rainer" and 95.6% of tenant "rook" have never been
					// surfaced. A memory that has NEVER been retrieved is at least as
					// deserving of a boost as one surfaced 31 days ago, so a NULL
					// falls back to `created` as the reference point — an honest age
					// for the never-surfaced case rather than a sentinel that can
					// never satisfy the >=30-day check.
					const neverSurfaced = !o.last_surfaced_at;
					if (neverSurfaced) neverSurfacedTotal++;
					const referenceTimestamp = o.last_surfaced_at ?? o.created;
					const daysSinceSurfaced = (Date.now() - new Date(referenceTimestamp).getTime()) / (1000 * 60 * 60 * 24);
					if (daysSinceSurfaced >= 30) {
						candidatesTotal++;
						if (o.texture.novelty_score < 0.8) {
							const boost = Math.min(0.1 * Math.floor(daysSinceSurfaced / 30), 0.5);
							o.texture.novelty_score = Math.min(o.texture.novelty_score + boost, 1.0);
							noveltyTexturesToUpdate.push({ id: o.id, texture: o.texture });
							regeneratedCount++;
							if (noveltySample.length < NOVELTY_SAMPLE_SIZE) {
								noveltySample.push({
									id: o.id,
									days_since_surfaced: Math.floor(daysSinceSurfaced),
									novelty_score_after: o.texture.novelty_score
								});
							}
						}
					}
				}
			}
		}

		await storage.bulkReplaceTexture(noveltyTexturesToUpdate);
		noveltyChanges += noveltyTexturesToUpdate.length;
		noveltyScan = {
			at: getTimestamp(),
			population_total: populationTotal,
			candidates_total: candidatesTotal,
			// See NoveltyScanRecord's doc (daemon/types.ts) — counts rows with
			// last_surfaced_at === null among population_total, NOT gated by the
			// 30-day threshold the way candidates_total is.
			never_surfaced_total: neverSurfacedTotal,
			would_create: regeneratedCount,
			created: regeneratedCount,
			sample: noveltySample,
			sample_truncated_to: noveltySample.length
		};
		console.log(`Daemon [${tenant}]: ${noveltyTexturesToUpdate.length} novelty regenerations (${neverSurfacedTotal} never-surfaced in population)`);
	});

	// One-time backfill: generate summaries for existing observations.
	await runStage(heartbeat, tenant, "summary-backfill", async () => {
		const backfillDone = await storage.readBackfillFlag("v4");
		if (!backfillDone) {
			const backfillUpdates: { territory: string; obs: Observation }[] = [];

			for (const { territory, observations } of territoryData) {
				for (const obs of observations) {
					if (!obs.summary) {
						obs.summary = generateSummary(obs);
						backfillUpdates.push({ territory, obs });
					}
				}
			}

			// BUDGET RISK: unbounded fan-out — one subrequest per observation with
			// no summary. It is gated behind the "v4" backfill flag so it normally
			// runs never, but if that flag is ever cleared on a large tenant this
			// single line can blow the whole invocation's subrequest budget and
			// kill every stage after it. Needs chunking before it is re-enabled.
			await Promise.all(backfillUpdates.map(({ territory, obs }) =>
				storage.appendToTerritory(territory, obs)
			));

			await storage.writeBackfillFlag("v4", { completed: getTimestamp(), count: backfillUpdates.length });
			console.log(`Daemon [${tenant}]: backfilled ${backfillUpdates.length} summaries`);
		}
	});

	// Generate territory overviews + iron-grip index (every cron cycle)
	await runStage(heartbeat, tenant, "overviews", async () => {
		const now = Date.now();
		const cutoff48h = now - (48 * 60 * 60 * 1000);
		const overviews: TerritoryOverview[] = [];
		const ironIndex: IronGripEntry[] = [];

		for (const { territory, observations } of territoryData) {
			const charges: Record<string, number> = {};
			let ironCount = 0;
			const ironIds: string[] = [];
			let recentCount = 0;
			let maxTime = "";

			for (const o of observations) {
				for (const c of o.texture?.charge || []) charges[c] = (charges[c] || 0) + 1;
				if (o.texture?.grip === "iron") {
					ironCount++;
					ironIds.push(o.id);
					ironIndex.push({
						id: o.id,
						territory,
						summary: o.summary || generateSummary(o),
						charges: o.texture?.charge || [],
						pull: calculatePullStrength(o),
						updated: getTimestamp()
					});
				}
				try {
					if (new Date(o.created).getTime() > cutoff48h) recentCount++;
				} catch {}
				if (o.created && o.created > maxTime) maxTime = o.created;
			}

			const topCharges = Object.entries(charges).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
			const topGrip = ironCount > 0 ? "iron"
				: observations.some(o => o.texture?.grip === "strong") ? "strong" : "present";

			overviews.push({
				territory,
				observation_count: observations.length,
				top_charges: topCharges,
				top_grip: topGrip,
				recent_count: recentCount,
				iron_count: ironCount,
				iron_ids: ironIds,
				last_activity: maxTime || getTimestamp(),
				theme_summary: `${territory}: ${observations.length} obs, ${ironCount} iron, ${recentCount} recent`,
				generated_at: getTimestamp()
			});
		}

		await Promise.all([
			storage.writeOverviews(overviews),
			storage.writeIronGripIndex(ironIndex)
		]);

		console.log(`Daemon [${tenant}]: overviews generated (${overviews.length} territories, ${ironIndex.length} iron grip)`);
	});

	// Embedding backfill — drain unembedded observations each cycle.
	// Cap at 500 per run: enough to clear ~2 days of heavy intake or drain a
	// backlog in a few nights, without hammering the AI provider in one shot.
	// The resilient embedBackfillBatch helper (chunk-50, per-row fallback)
	// ensures a single bad row never poisons its chunk-mates.
	await runStage(heartbeat, tenant, "embedding-backfill", async () => {
		if (!ai) return;
		const provider = createEmbeddingProvider(ai);

		const rows = await storage.queryUnembedded(500);

		if (rows.length > 0) {
			const { embedded, skipped } = await embedBackfillBatch(provider, rows);

			if (embedded.length > 0) {
				await storage.bulkUpdateEmbeddings(embedded);
			}
			if (skipped.length > 0) {
				console.warn(`Daemon [${tenant}]: embedding backfill skipped ${skipped.length} rows`, skipped.map(s => s.id));
			}

			const remainingCount = await storage.countUnembedded();
			console.log(`Daemon [${tenant}]: backfilled ${embedded.length} embeddings (${remainingCount} remaining)`);
		}
	});

	// Best-effort: how many orphans this exact run drained (moved to rescued/archived)
	// and how many it newly detected (Phase 1 inserts) — read by
	// brain_health.janitor.orphans.{drained_last_night,detected_last_night}
	// (tools-v2/wake.ts). Both come from the SAME before/after getOrphanStats()
	// pair, no extra query — detected is the total row-count delta
	// (orphaned+rescued+archived; orphan_observations rows are never deleted, only
	// re-statused, so this can only grow via markOrphans' INSERT this run), drained
	// is the rescued+archived delta. Folded into the THIRD heartbeat write below
	// (never a separate daemon_config write) — daemon-cycle-order.spec.ts pins
	// daemon_config to exactly 3 writes per tenant per cycle, and a 4th write here
	// would both violate that seam and, for a storage mock lacking getOrphanStats,
	// throw outside any catch.
	let lastOrphanDrain: { count: number; at: string } | undefined;
	let lastOrphanDetect: { count: number; at: string } | undefined;
	try {
		const orphanStatsAfterRun = typeof storage.getOrphanStats === "function"
			? await storage.getOrphanStats()
			: orphanStatsBeforeRun;
		const drained = Math.max(0,
			(orphanStatsAfterRun.rescued + orphanStatsAfterRun.archived) -
			(orphanStatsBeforeRun.rescued + orphanStatsBeforeRun.archived)
		);
		const detected = Math.max(0,
			(orphanStatsAfterRun.orphaned + orphanStatsAfterRun.rescued + orphanStatsAfterRun.archived) -
			(orphanStatsBeforeRun.orphaned + orphanStatsBeforeRun.rescued + orphanStatsBeforeRun.archived)
		);
		lastOrphanDrain = { count: drained, at: getTimestamp() };
		lastOrphanDetect = { count: detected, at: getTimestamp() };
	} catch (err) {
		console.error(`Daemon [${tenant}]: failed to compute orphan drain/detect breadcrumbs:`, err instanceof Error ? err.message : err);
	}

	// Third (and final) heartbeat write — stamps finished_at, plus the
	// drain/detect breadcrumbs and the regrade/dedup/paradox/novelty scan
	// records, whichever of these exist.
		await heartbeat.finish(getTimestamp(), {
			...(lastOrphanDrain ? { last_orphan_drain: lastOrphanDrain } : {}),
			...(lastOrphanDetect ? { last_orphan_detect: lastOrphanDetect } : {}),
			...(regradeScan ? { last_regrade_scan: regradeScan } : {}),
			...(dedupScan ? { last_dedup_scan: dedupScan } : {}),
			...(paradoxScan ? { last_paradox_scan: paradoxScan } : {}),
			...(noveltyScan ? { last_novelty_scan: noveltyScan } : {}),
			...(valenceFloorResult ? { valence_floor: valenceFloorResult } : {})
		});
		console.log(`Daemon [${tenant}]: ${decayChanges} decay changes`);
		return { decayChanges, noveltyChanges, fatal: false, ok: true };
	} catch (e) {
		console.error(`Daemon [${tenant}]: fatal`, e);
		await heartbeat.fail(e instanceof Error ? e.message : String(e), getTimestamp());
		return { decayChanges, noveltyChanges, fatal: true, ok: false };
	}
}
