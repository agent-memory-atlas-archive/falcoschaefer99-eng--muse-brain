// Pins the production seam of the nightly metabolism cycle: the REAL
// runTenantCycle() in src/daemon/cycle.ts, not a re-creation of it in the spec.
// This is the seam `daemon-runner/main.ts` calls once per tenant on the box
// (systemd timer). Before 2026-09-04 the Cloudflare Worker's scheduled() handler
// also called this same seam on its own cron trigger — that trigger is gone now
// (see wrangler.jsonc), so this file drives runTenantCycle directly instead of
// through the (now no-op) worker.scheduled(). See test/worker-scheduled-noop.spec.ts
// for the pin that the Worker itself no longer runs this cycle.
//
// Two of the three things this file asserts have already gone wrong in
// production and nothing pinned them:
//   - runAiProposalReview must run BEFORE runDaemonTasks. On the 2026-07-28 live
//     night the task sweep exhausted the invocation's subrequest budget and the
//     AI reviewer never executed at all. A budget kill is uncatchable, so the
//     failure logged NOTHING; it took a manual SQL dig to find.
//   - the heartbeat must actually be wired into the cycle. A heartbeat that is
//     only exercised through its own class in a unit test proves nothing about
//     whether runTenantCycle() calls it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	callOrder: [] as string[],
	daemonConfigWrites: [] as Array<{ tenant: string; data: Record<string, unknown> }>,
	readDaemonConfigImpl: null as null | (() => Promise<unknown>),
	initialLastDaemonRun: null as Record<string, unknown> | null,
	storageData: new Map<string, Record<string, unknown>>()
}));

/** Minimal storage surface runTenantCycle() touches, per tenant. */
function makeStorage(tenant: string) {
	const state: { data: Record<string, unknown> } = {
		data: hoisted.storageData.get(tenant)
			?? (hoisted.initialLastDaemonRun ? { last_daemon_run: hoisted.initialLastDaemonRun } : {})
	};
	hoisted.storageData.set(tenant, state.data);
	return {
		getTenant: () => tenant,
		readDaemonConfig: vi.fn(async () => {
			if (hoisted.readDaemonConfigImpl) return hoisted.readDaemonConfigImpl();
			return { tenant_id: tenant, link_proposal_threshold: 0.87, data: state.data };
		}),
		updateDaemonConfigData: vi.fn(async (data: Record<string, unknown>) => {
			state.data = data;
			hoisted.storageData.set(tenant, data);
			hoisted.daemonConfigWrites.push({ tenant, data });
		}),
		readAllTerritories: vi.fn(async () => []),
		bulkReplaceTexture: vi.fn(async () => undefined),
		readBackfillFlag: vi.fn(async () => ({ completed: "done" })),
		writeBackfillFlag: vi.fn(async () => undefined),
		appendToTerritory: vi.fn(async () => undefined),
		writeOverviews: vi.fn(async () => undefined),
		writeIronGripIndex: vi.fn(async () => undefined),
		queryUnembedded: vi.fn(async () => []),
		countUnembedded: vi.fn(async () => 0),
		bulkUpdateEmbeddings: vi.fn(async () => undefined),
		getOrphanStats: vi.fn(async () => ({ orphaned: 0, rescued: 0, archived: 0, oldest_days: 0 }))
	};
}

vi.mock("../src/storage/index", () => ({
	createStorage: vi.fn((_config: unknown, tenant: string) => makeStorage(tenant))
}));

vi.mock("../src/daemon/ai-review", () => ({
	runAiProposalReview: vi.fn(async () => {
		hoisted.callOrder.push("ai-review");
		return 0;
	})
}));

vi.mock("../src/daemon/index", () => ({
	runDaemonTasks: vi.fn(async () => {
		hoisted.callOrder.push("daemon-tasks");
		return [];
	})
}));

vi.mock("../src/tools-v2/index", () => ({
	TOOL_DEFS: [],
	executeTool: vi.fn(async () => ({}))
}));

// ops/ADR-VALENCE-FLOOR.md, slice 0 — neither is a runDaemonTasks() task (see
// their own header comments); both are cycle.ts stages, same as ai-review, so
// they belong in THIS file's ordering seam, not daemon-orchestrator-order.spec.ts.
vi.mock("../src/daemon/tasks/valence-lexicon", () => ({
	runValenceLexiconTask: vi.fn(async () => {
		hoisted.callOrder.push("valence-lexicon");
		return { distinct_charges_total: 0, classified_this_run: 0, unparseable_this_run: 0, unclassified_remaining: 0 };
	})
}));

vi.mock("../src/daemon/tasks/valence-floor", () => ({
	runValenceFloorTask: vi.fn(async () => {
		hoisted.callOrder.push("valence-floor");
		return {
			seats: 0, reason: "no foundational memories exist yet", classified: 0, eligible: 0,
			eligible_share: null, simulated_eligible_in_lane: 0, eligible_supply_after_cut: 0,
			lexicon_rows: 0, lexicon_coverage_pct: null, unclassified_charge_count: 0,
			computed_at: "2026-09-21T00:00:00.000Z"
		};
	})
}));

import { createStorage } from "../src/storage/index";
import { runTenantCycle, JANITOR_BUDGET_MS } from "../src/daemon/cycle";
import { runAiProposalReview } from "../src/daemon/ai-review";
import { runDaemonTasks } from "../src/daemon/index";
import { runValenceLexiconTask } from "../src/daemon/tasks/valence-lexicon";
import { runValenceFloorTask } from "../src/daemon/tasks/valence-floor";
import { CHECKPOINT_STAGES } from "../src/daemon/heartbeat";
import { resolveAllowedTenants } from "../src/tenant-config";

const env = { STORAGE_BACKEND: "sqlite", SQLITE_PATH: "/tmp/muse-brain-scheduled-order.sqlite" } as any;

// Mirrors daemon-runner/main.ts's own loop: one runTenantCycle() call per
// allowed tenant. This IS the box-runner seam, not a re-implementation of it —
// the storage/ai-review/daemon-tasks mocks above are the only stand-ins.
async function runNightly() {
	for (const tenant of resolveAllowedTenants(env)) {
		const storage = createStorage({} as any, tenant);
		await runTenantCycle(storage as any, tenant, env);
	}
}

function tracesFor(tenant: string) {
	return hoisted.daemonConfigWrites
		.filter(write => write.tenant === tenant)
		.map(write => write.data.last_daemon_run as {
			started_at: string;
			completed_stages: string[];
			finished_at: string | null;
			error?: string;
		});
}

describe("runTenantCycle() nightly wiring", () => {
	beforeEach(() => {
		hoisted.callOrder.length = 0;
		hoisted.daemonConfigWrites.length = 0;
	hoisted.readDaemonConfigImpl = null;
	hoisted.initialLastDaemonRun = null;
	hoisted.storageData.clear();
		vi.clearAllMocks();
		// runTenantCycle() logs a line per stage per tenant — useful in production, noise here
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("runs the AI proposal review BEFORE the daemon task sweep", async () => {
		await runNightly();

		expect(runAiProposalReview).toHaveBeenCalled();
		expect(runDaemonTasks).toHaveBeenCalled();
		// two tenants, review first each time — never review-after-sweep
		expect(hoisted.callOrder).toEqual([
			"ai-review", "daemon-tasks", "valence-lexicon", "valence-floor",
			"ai-review", "daemon-tasks", "valence-lexicon", "valence-floor"
		]);
		expect(hoisted.callOrder.indexOf("ai-review")).toBeLessThan(hoisted.callOrder.indexOf("daemon-tasks"));
	});

	it("runs the valence lexicon BEFORE the valence floor — ops/ADR-VALENCE-FLOOR.md: floor reads what lexicon just wrote this same cycle", async () => {
		await runNightly();

		expect(runValenceLexiconTask).toHaveBeenCalled();
		expect(runValenceFloorTask).toHaveBeenCalled();
		expect(hoisted.callOrder.indexOf("valence-lexicon")).toBeLessThan(hoisted.callOrder.indexOf("valence-floor"));
		// both run after daemon-tasks in this cycle's stage order — not asserting
		// WHY (that's this file's structural position, not a contract), only that
		// lexicon-before-floor holds every time.
		expect(hoisted.callOrder.filter(c => c === "valence-lexicon").length)
			.toBe(hoisted.callOrder.filter(c => c === "valence-floor").length);
	});

	it("writes the heartbeat exactly three times per tenant", async () => {
		await runNightly();

		const tenants = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
		expect(tenants.length).toBeGreaterThan(0);
		for (const tenant of tenants) {
			expect(tracesFor(tenant)).toHaveLength(3);
		}
	});

	it("folds the valence-floor result into the SAME third write — no fourth daemon_config write", async () => {
		await runNightly();

		const [tenant] = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
		const writesForTenant = hoisted.daemonConfigWrites.filter(w => w.tenant === tenant);
		expect(writesForTenant).toHaveLength(3); // unchanged — still exactly 3, not 4
		const finalWrite = writesForTenant.at(-1)!.data;
		expect(finalWrite.valence_floor).toEqual({
			seats: 0,
			reason: "no foundational memories exist yet",
			classified: 0,
			eligible: 0,
			eligible_share: null,
			simulated_eligible_in_lane: 0,
			eligible_supply_after_cut: 0,
			lexicon_rows: 0,
			lexicon_coverage_pct: null,
			unclassified_charge_count: 0,
			computed_at: "2026-09-21T00:00:00.000Z"
		});
	});

	it("records the stages the real handler emits, in order, and closes the run", async () => {
		await runNightly();

		const [tenant] = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
		const [first, checkpoint, final] = tracesFor(tenant);

		// Expectations derived FROM the run, not from a hand-copied stage list that
		// drifts the moment someone adds or reorders a stage in runTenantCycle().
		expect(first.completed_stages).toEqual(["ai-review"]);
		expect(first.finished_at).toBeNull();

		expect(checkpoint.completed_stages.at(-1)).toBe("daemon-tasks");
		expect(checkpoint.finished_at).toBeNull();

		// the checkpoint stage set is a prefix of the final stage list
		expect(final.completed_stages.slice(0, checkpoint.completed_stages.length))
			.toEqual(checkpoint.completed_stages);
		expect(final.completed_stages[0]).toBe("ai-review");
		expect(new Set(final.completed_stages).size).toBe(final.completed_stages.length);
		for (const stage of CHECKPOINT_STAGES) {
			expect(final.completed_stages).toContain(stage);
		}
		expect(final.finished_at).toBeTruthy();
		expect(final).not.toHaveProperty("error");
	});

	it("completes every tenant even when one tenant's storage keeps failing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { createStorage } = await import("../src/storage/index");
		(createStorage as any).mockImplementation((_config: unknown, tenant: string) => {
			const storage = makeStorage(tenant);
			if (tenant === "companion") {
				storage.readAllTerritories = vi.fn(async () => { throw new Error("hyperdrive down"); });
			}
			return storage;
		});

		await expect(runNightly()).resolves.toBeUndefined();

		// the failing tenant did not abort the loop
		expect(hoisted.callOrder.filter(c => c === "daemon-tasks")).toHaveLength(2);
		const tenants = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
		expect(tenants).toContain("rainer");
		errorSpy.mockRestore();
	});

	it("keeps the cycle running when the decay stage throws, recording it in failed_stages but not aborting later stages", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { createStorage } = await import("../src/storage/index");
		(createStorage as any).mockImplementation((_config: unknown, tenant: string) => {
			const storage = makeStorage(tenant);
			if (tenant === "companion") {
				(storage as any).runDecay = vi.fn(async () => { throw new Error("decay backend unreachable"); });
			}
			return storage;
		});

		await expect(runNightly()).resolves.toBeUndefined();

		const companionTraces = tracesFor("companion");
		const final = companionTraces[companionTraces.length - 1] as {
			completed_stages: string[];
			failed_stages?: string[];
			finished_at: string | null;
			error?: string;
		};

		// reached (still in completed_stages) but did NOT succeed (also in failed_stages)
		expect(final.completed_stages).toContain("decay");
		expect(final.failed_stages).toContain("decay");
		expect(final.error).toContain("decay: decay backend unreachable");
		// the cycle continued past the throw — later stages still ran and closed out
		expect(final.completed_stages).toContain("overviews");
		expect(final.completed_stages).toContain("embedding-backfill");
		expect(final.finished_at).toBeTruthy();

		errorSpy.mockRestore();
	});

	it("still runs the task sweep when every heartbeat write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		hoisted.readDaemonConfigImpl = async () => { throw new Error("daemon_config unreachable"); };

		await expect(runNightly()).resolves.toBeUndefined();

		// instrumentation must never be load-bearing
		expect(runDaemonTasks).toHaveBeenCalledTimes(2);
		expect(hoisted.daemonConfigWrites).toHaveLength(0);
		errorSpy.mockRestore();
	});

	it("does not advance the previous-green boundary after a task result error", async () => {
		const previousStartedAt = "2026-07-31T03:00:00.000Z";
		hoisted.initialLastDaemonRun = {
			started_at: previousStartedAt,
			completed_stages: ["ai-review", "daemon-tasks", "decay"],
			finished_at: "2026-07-31T03:01:00.000Z"
		};
		const contexts: Array<{ arrivalBoundary?: string }> = [];
		const taskMock = runDaemonTasks as any;
		const defaultImplementation = taskMock.getMockImplementation();
		const { createStorage } = await import("../src/storage/index");
		(createStorage as any).mockImplementation((_config: unknown, tenant: string) => makeStorage(tenant));
		taskMock.mockImplementation(async (_storage: unknown, context: { arrivalBoundary?: string }) => {
			contexts.push(context);
			return contexts.length <= 2
				? [{ task: "failed-task", changes: 0, proposals_created: 0, error: "task failed" }]
				: [];
		});

		try {
			await runNightly();
			await runNightly();

			expect(contexts.slice(0, 2).map(context => context.arrivalBoundary))
				.toEqual([previousStartedAt, previousStartedAt]);
			expect(contexts.slice(2).map(context => context.arrivalBoundary))
				.toEqual([undefined, undefined]);
		} finally {
			taskMock.mockImplementation(defaultImplementation);
			(createStorage as any).mockImplementation((_config: unknown, tenant: string) => makeStorage(tenant));
		}
	});

	it("threads a deadlineAt roughly JANITOR_BUDGET_MS ahead of now into DaemonRunContext", async () => {
		const before = Date.now();
		await runNightly();
		const after = Date.now();

		const contexts = (runDaemonTasks as any).mock.calls.map((call: unknown[]) => call[1] as { deadlineAt?: number });
		expect(contexts.length).toBeGreaterThan(0);
		for (const context of contexts) {
			expect(context.deadlineAt).toBeGreaterThanOrEqual(before + JANITOR_BUDGET_MS);
			expect(context.deadlineAt).toBeLessThanOrEqual(after + JANITOR_BUDGET_MS);
		}
	});

	it("folds the orphan-drain AND orphan-detect breadcrumbs into the third (finish) write, never a fourth", async () => {
		const { createStorage } = await import("../src/storage/index");
		(createStorage as any).mockImplementation((_config: unknown, tenant: string) => {
			const storage = makeStorage(tenant);
			// simulate 3 orphans rescued/archived AND 5 newly detected during this
			// exact run: before = 10 total (10 orphaned, 0/0); after = 15 total
			// (12 orphaned + 2 rescued + 1 archived) — drained = (2+1)-(0+0) = 3,
			// detected = 15-10 = 5. Deliberately distinct nonzero values (blind-spot
			// guard) so a wiring regression that swapped or dropped one field would
			// fail this test, not just pass by coincidence.
			let call = 0;
			storage.getOrphanStats = vi.fn(async () => {
				call++;
				return call === 1
					? { orphaned: 10, rescued: 0, archived: 0, oldest_days: 5 }
					: { orphaned: 12, rescued: 2, archived: 1, oldest_days: 5 };
			});
			return storage;
		});

		await runNightly();

		const [tenant] = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
		expect(tracesFor(tenant)).toHaveLength(3); // unchanged — still exactly 3, not 4

		const writesForTenant = hoisted.daemonConfigWrites.filter(w => w.tenant === tenant);
		const finalWrite = writesForTenant[writesForTenant.length - 1];
		expect(finalWrite.data.last_orphan_drain).toEqual({ count: 3, at: expect.any(String) });
		expect(finalWrite.data.last_orphan_detect).toEqual({ count: 5, at: expect.any(String) });
		expect(finalWrite.data.last_daemon_run).toBeDefined();
	});

	it("folds dedup's scan record into the third (finish) write by task name, never a fourth write (ops/ADR-JANITOR.md §6 commit 8, same seam as last_regrade_scan)", async () => {
		const dedupScan = {
			at: "2026-09-06T03:00:00.000Z",
			population_total: 50,
			candidates_total: 3,
			would_create: 0,
			created: 0,
			sample: [{ source_id: "obs_a", target_id: "obs_b", source_summary: "a", target_summary: "b", similarity: 0.71 }],
			sample_truncated_to: 1
		};
		const taskMock = runDaemonTasks as any;
		const defaultImplementation = taskMock.getMockImplementation();
		taskMock.mockImplementation(async () => {
			hoisted.callOrder.push("daemon-tasks");
			return [{ task: "dedup", changes: 0, proposals_created: 0, scan: dedupScan }];
		});

		try {
			await runNightly();

			const [tenant] = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
			expect(tracesFor(tenant)).toHaveLength(3); // unchanged — still exactly 3, not 4

			const writesForTenant = hoisted.daemonConfigWrites.filter(w => w.tenant === tenant);
			const finalWrite = writesForTenant[writesForTenant.length - 1];
			expect(finalWrite.data.last_dedup_scan).toEqual(dedupScan);
			expect(finalWrite.data.last_regrade_scan).toBeUndefined();
			expect(finalWrite.data.last_daemon_run).toBeDefined();
		} finally {
			taskMock.mockImplementation(defaultImplementation);
		}
	});

	it("folds paradox-detection's scan record into the third (finish) write by task name, never a fourth write (same seam as last_regrade_scan/last_dedup_scan)", async () => {
		const paradoxScan = {
			at: "2026-09-06T03:00:00.000Z",
			population_total: 41,
			candidates_total: 0,
			would_create: 0,
			created: 0,
			sample: [],
			sample_truncated_to: 0
		};
		const taskMock = runDaemonTasks as any;
		const defaultImplementation = taskMock.getMockImplementation();
		taskMock.mockImplementation(async () => {
			hoisted.callOrder.push("daemon-tasks");
			return [{ task: "paradox-detection", changes: 0, proposals_created: 0, scan: paradoxScan }];
		});

		try {
			await runNightly();

			const [tenant] = [...new Set(hoisted.daemonConfigWrites.map(w => w.tenant))];
			expect(tracesFor(tenant)).toHaveLength(3); // unchanged — still exactly 3, not 4

			const writesForTenant = hoisted.daemonConfigWrites.filter(w => w.tenant === tenant);
			const finalWrite = writesForTenant[writesForTenant.length - 1];
			expect(finalWrite.data.last_paradox_scan).toEqual(paradoxScan);
			expect(finalWrite.data.last_dedup_scan).toBeUndefined();
			expect(finalWrite.data.last_regrade_scan).toBeUndefined();
			expect(finalWrite.data.last_daemon_run).toBeDefined();
		} finally {
			taskMock.mockImplementation(defaultImplementation);
		}
	});
});
