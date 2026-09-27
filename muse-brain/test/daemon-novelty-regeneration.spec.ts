// fix(brain): novelty exists as a dimension again — B2/B3.
// Drives the REAL runTenantCycle() (src/daemon/cycle.ts), same seam as
// test/daemon-cycle-order.spec.ts, with a storage mock that returns actual
// territory data instead of an empty corpus — daemon-cycle-order.spec.ts's own
// makeStorage() always returns `readAllTerritories: vi.fn(async () => [])`, so
// it structurally cannot exercise the novelty stage's per-observation logic.
//
// B2's defect: cycle.ts used to read `o.texture.last_surfaced_at`, a texture
// key no writer ever sets (types.ts's Texture.last_surfaced_at is
// @deprecated/dead). The real value lives on Observation.last_surfaced_at, a
// plain column mapped through by both backends' row-mappers. The second test
// below proves the OLD read source stays dead even after the fix — a
// regression test that would NOT have failed before B2 (both fields were being
// read from texture) is worthless here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Observation } from "../src/types";

const hoisted = vi.hoisted(() => ({
	daemonConfigWrites: [] as Array<{ tenant: string; data: Record<string, unknown> }>,
	bulkReplaceCalls: [] as Array<{ id: string; texture: Observation["texture"] }[]>
}));

function makeStorage(tenant: string, observations: Observation[]) {
	return {
		getTenant: () => tenant,
		readDaemonConfig: vi.fn(async () => ({ tenant_id: tenant, link_proposal_threshold: 0.87, data: {} })),
		updateDaemonConfigData: vi.fn(async (data: Record<string, unknown>) => {
			hoisted.daemonConfigWrites.push({ tenant, data });
		}),
		readAllTerritories: vi.fn(async () => [{ territory: "episodic", observations }]),
		bulkReplaceTexture: vi.fn(async (updates: { id: string; texture: Observation["texture"] }[]) => {
			hoisted.bulkReplaceCalls.push(updates);
		}),
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

vi.mock("../src/daemon/ai-review", () => ({
	runAiProposalReview: vi.fn(async () => ({ reviewed: 0, truncatedByDeadline: false }))
}));

vi.mock("../src/daemon/index", () => ({
	runDaemonTasks: vi.fn(async () => [])
}));

vi.mock("../src/tools-v2/index", () => ({
	TOOL_DEFS: [],
	executeTool: vi.fn(async () => ({}))
}));

import { runTenantCycle } from "../src/daemon/cycle";

function daysAgoIso(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function staleObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: "obs_stale",
		content: "an old, unsurfaced memory",
		territory: "episodic",
		created: daysAgoIso(60),
		texture: {
			salience: "active",
			vividness: "vivid",
			charge: [],
			grip: "present",
			charge_phase: "processing",
			novelty_score: 0.5
		},
		access_count: 3,
		last_surfaced_at: daysAgoIso(35),
		...overrides
	};
}

const env = { STORAGE_BACKEND: "sqlite", SQLITE_PATH: "/tmp/muse-brain-novelty-regen-test.sqlite" } as any;

describe("daemon/cycle.ts novelty regeneration", () => {
	beforeEach(() => {
		hoisted.daemonConfigWrites.length = 0;
		hoisted.bulkReplaceCalls.length = 0;
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("boosts novelty_score for an observation unsurfaced 30+ days, reading Observation.last_surfaced_at (the real field)", async () => {
		const storage = makeStorage("companion", [staleObservation()]) as any;

		const result = await runTenantCycle(storage, "companion", env);

		expect(result.noveltyChanges).toBeGreaterThan(0);
		const allUpdates = hoisted.bulkReplaceCalls.flat();
		expect(allUpdates).toHaveLength(1);
		expect(allUpdates[0].id).toBe("obs_stale");
		expect(allUpdates[0].texture!.novelty_score).toBeGreaterThan(0.5);
	});

	it("does NOT read the dead texture.last_surfaced_at key as a surfacing signal — a real never-surfaced observation falls back to created_at, not the texture key", async () => {
		// Before B4, a real-field-null observation was simply skipped (not a
		// candidate at all), so this test's fixture didn't need to care what
		// `created` was — noveltyChanges: 0 either way. B4 makes a real-field-null
		// observation fall back to `created_at`, so this fixture now needs `created`
		// recent enough (5 days) that the CORRECT fallback is NOT a candidate,
		// while the dead texture key (35 days, stale) WOULD wrongly trigger a boost
		// if the code regressed to reading it — same diagnostic power as before,
		// under the new correct behavior.
		const observationWithOnlyDeadField = staleObservation({
			created: daysAgoIso(5),
			last_surfaced_at: undefined,
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: [],
				grip: "present",
				charge_phase: "processing",
				novelty_score: 0.5,
				last_surfaced_at: daysAgoIso(35) // the dead texture key — must be ignored
			}
		});
		const storage = makeStorage("companion", [observationWithOnlyDeadField]) as any;

		const result = await runTenantCycle(storage, "companion", env);

		expect(result.noveltyChanges).toBe(0);
		expect(hoisted.bulkReplaceCalls.flat()).toHaveLength(0);
	});

	it("does not boost an observation surfaced within the last 30 days", async () => {
		const recentObservation = staleObservation({ id: "obs_recent", last_surfaced_at: daysAgoIso(2) });
		const storage = makeStorage("companion", [recentObservation]) as any;

		const result = await runTenantCycle(storage, "companion", env);

		expect(result.noveltyChanges).toBe(0);
	});

	// fix(brain): novelty regeneration skips every memory that was never surfaced
	// — B4. `last_surfaced_at` is NULL for any row `updateSurfacingEffects` has
	// never touched (never written at INSERT — no schema DEFAULT). B2's fix (the
	// two tests above) corrected WHICH field cycle.ts reads but kept the old
	// `else if (o.last_surfaced_at)` branch, which still treats NULL as "not a
	// candidate" — structurally excluding the exact population this stage exists
	// to lift. Verified live 2026-09-06: 92.8%/95.6% of two tenants' corpora had
	// never been surfaced, so this was the dominant case, not an edge case.
	describe("B4 — never-surfaced observations", () => {
		it("boosts a NEVER-surfaced observation older than 30 days, falling back to created_at as the reference point", async () => {
			const neverSurfaced = staleObservation({
				id: "obs_never_surfaced",
				created: daysAgoIso(45),
				last_surfaced_at: undefined
			});
			const storage = makeStorage("companion", [neverSurfaced]) as any;

			const result = await runTenantCycle(storage, "companion", env);

			expect(result.noveltyChanges).toBeGreaterThan(0);
			const allUpdates = hoisted.bulkReplaceCalls.flat();
			expect(allUpdates).toHaveLength(1);
			expect(allUpdates[0].id).toBe("obs_never_surfaced");
			expect(allUpdates[0].texture!.novelty_score).toBeGreaterThan(0.5);
		});

		it("does not boost a never-surfaced observation created less than 30 days ago", async () => {
			const tooYoung = staleObservation({
				id: "obs_never_surfaced_young",
				created: daysAgoIso(5),
				last_surfaced_at: undefined
			});
			const storage = makeStorage("companion", [tooYoung]) as any;

			const result = await runTenantCycle(storage, "companion", env);

			expect(result.noveltyChanges).toBe(0);
		});

		it("does not boost an observation surfaced yesterday", async () => {
			const surfacedYesterday = staleObservation({ id: "obs_surfaced_yesterday", last_surfaced_at: daysAgoIso(1) });
			const storage = makeStorage("companion", [surfacedYesterday]) as any;

			const result = await runTenantCycle(storage, "companion", env);

			expect(result.noveltyChanges).toBe(0);
		});

		it("still boosts an observation surfaced exactly 31 days ago — no regression on the already-working path", async () => {
			const surfaced31DaysAgo = staleObservation({ id: "obs_surfaced_31d", last_surfaced_at: daysAgoIso(31) });
			const storage = makeStorage("companion", [surfaced31DaysAgo]) as any;

			const result = await runTenantCycle(storage, "companion", env);

			expect(result.noveltyChanges).toBeGreaterThan(0);
		});

		it("never_surfaced_total on the scan record counts observations with no last_surfaced_at, independent of the 30-day candidate gate (deliberately distinct values — blind-spot guard)", async () => {
			const neverSurfacedOld = staleObservation({ id: "obs_never_old", created: daysAgoIso(45), last_surfaced_at: undefined });
			const neverSurfacedYoung = staleObservation({ id: "obs_never_young", created: daysAgoIso(5), last_surfaced_at: undefined });
			const surfacedStale = staleObservation({ id: "obs_surfaced_stale", last_surfaced_at: daysAgoIso(40) });
			const storage = makeStorage("companion", [neverSurfacedOld, neverSurfacedYoung, surfacedStale]) as any;

			await runTenantCycle(storage, "companion", env);

			const finalWrite = hoisted.daemonConfigWrites[hoisted.daemonConfigWrites.length - 1];
			const scan = finalWrite.data.last_novelty_scan as { candidates_total: number; never_surfaced_total: number };

			// never_surfaced_total counts BOTH never-surfaced rows (old and young) —
			// it is not gated by the 30-day threshold.
			expect(scan.never_surfaced_total).toBe(2);
			// candidates_total only counts rows >= 30 days from their reference point:
			// neverSurfacedOld (45d) and surfacedStale (40d), not neverSurfacedYoung (5d).
			expect(scan.candidates_total).toBe(2);
		});
	});

	it("skips foundational observations entirely, even when stale", async () => {
		const foundational = staleObservation({
			id: "obs_foundational",
			texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "iron", charge_phase: "processing", novelty_score: 0.5 }
		});
		const storage = makeStorage("companion", [foundational]) as any;

		const result = await runTenantCycle(storage, "companion", env);

		expect(result.noveltyChanges).toBe(0);
	});

	it("B3: folds a novelty ScanRecord into the third (finish) heartbeat write, never a fourth", async () => {
		const storage = makeStorage("companion", [staleObservation()]) as any;

		await runTenantCycle(storage, "companion", env);

		expect(hoisted.daemonConfigWrites).toHaveLength(3); // unchanged — still exactly 3, not 4

		const finalWrite = hoisted.daemonConfigWrites[hoisted.daemonConfigWrites.length - 1];
		const scan = finalWrite.data.last_novelty_scan as
			{ population_total: number; candidates_total: number; never_surfaced_total: number; created: number; would_create: number; sample: unknown[] } | undefined;

		expect(scan).toBeDefined();
		expect(scan!.population_total).toBe(1); // one non-foundational observation
		expect(scan!.candidates_total).toBe(1); // one observation unsurfaced >= 30 days
		expect(scan!.never_surfaced_total).toBe(0); // staleObservation() was surfaced 35 days ago, not never
		expect(scan!.created).toBe(1);
		expect(scan!.would_create).toBe(1);
		expect(scan!.sample.length).toBe(1);
		expect(finalWrite.data.last_daemon_run).toBeDefined();
	});
});
