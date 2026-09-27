import { describe, expect, it, vi } from "vitest";

import { extractPreviousSuccessfulRunStartedAt, readCrossTenantBoundary, readDaemonRunContext } from "../src/daemon/context";
import type { ArrivalBoundary, StateWindow } from "../src/daemon/types";
import { runCascadeTask } from "../src/daemon/tasks/cascade";
import { runCrossAgentTask } from "../src/daemon/tasks/cross-agent";
import { runCrossTenantTask } from "../src/daemon/tasks/cross-tenant";
import { runKitHygieneTask } from "../src/daemon/tasks/kit-hygiene";
import { runOrphanTask } from "../src/daemon/tasks/orphans";
import { runParadoxDetectionTask } from "../src/daemon/tasks/paradox-detection";
import { createStorage } from "../src/storage/factory";

const WINDOW = "2026-07-30T03:00:00.000Z";

describe("daemon dailies window", () => {
	it("advances only from a valid completed previous heartbeat", async () => {
		expect(extractPreviousSuccessfulRunStartedAt({
			last_daemon_run: { started_at: WINDOW, finished_at: "2026-07-30T03:04:00.000Z" }
		})).toBe(WINDOW);
		expect(extractPreviousSuccessfulRunStartedAt({
			last_daemon_run: { started_at: WINDOW, finished_at: null }
		})).toBeUndefined();
		expect(extractPreviousSuccessfulRunStartedAt({
			last_daemon_run: { started_at: WINDOW, finished_at: "2026-07-30T03:04:00.000Z", error: "stage failed" }
		})).toBeUndefined();
		expect(extractPreviousSuccessfulRunStartedAt({
			last_daemon_run: { started_at: "not-a-date", finished_at: "2026-07-30T03:04:00.000Z" }
		})).toBeUndefined();

		const storage = { readDaemonConfig: vi.fn(async () => ({ data: {
			last_daemon_run: { started_at: WINDOW, finished_at: "2026-07-30T03:04:00.000Z" }
		} })) } as any;
		expect(await readDaemonRunContext(storage)).toEqual({ arrivalBoundary: WINDOW });
		storage.readDaemonConfig.mockRejectedValueOnce(new Error("instrumentation unavailable"));
		expect(await readDaemonRunContext(storage)).toEqual({});
	});

	it("readCrossTenantBoundary structurally cannot leak the rest of daemon_config.data (Michael audit of 80673e5/369c128, MEDIUM 85)", async () => {
		// Wide blob shaped like a real cross-tenant clone's config: legitimate
		// arrivalBoundary/backlogMode inputs sitting alongside last_regrade_scan.sample
		// (up to 25 OTHER tenant's memory summaries) and other daemon_config keys
		// that must never reach a cross-tenant caller.
		const otherTenantStorage = { readDaemonConfig: vi.fn(async () => ({
			data: {
				last_daemon_run: { started_at: WINDOW, finished_at: "2026-07-30T03:04:00.000Z" },
				backlog_mode: true,
				last_regrade_scan: {
					sample: [{ id: "obs_1", summary: "a private memory from the other tenant" }]
				},
				last_dedup_scan: { sample: [{ id: "obs_2" }] }
			}
		})) } as any;

		const boundary = await readCrossTenantBoundary(otherTenantStorage);

		expect(boundary).toEqual({ arrivalBoundary: WINDOW, backlogMode: true });
		// The return type is the boundary: assert no other key survives, so a future
		// field added to daemon_config.data (or to DaemonRunContext) can't leak
		// through this accessor without an explicit, reviewed edit here.
		expect(Object.keys(boundary).sort()).toEqual(["arrivalBoundary", "backlogMode"]);
	});

	it("filters touched observations in SQLite, including access-only touches", async () => {
		const storage = createStorage({ backend: "sqlite", sqlitePath: `/tmp/muse-brain-window-${crypto.randomUUID()}.sqlite` }, "rainer");
		const base = {
			territory: "craft",
			texture: { charge: ["window"], charge_phase: "fresh" },
			access_count: 0,
			entity_id: "entity_window"
		};
		await storage.appendToTerritory("craft", { ...base, id: "old", content: "old", created: "2026-07-01T00:00:00.000Z" } as any);
		await storage.appendToTerritory("craft", { ...base, id: "accessed", content: "accessed", created: "2026-07-01T00:00:00.000Z", last_accessed: WINDOW } as any);
		await storage.appendToTerritory("craft", { ...base, id: "new", content: "new", created: "2026-07-31T00:00:00.000Z" } as any);
		await storage.appendToTerritory("craft", { ...base, id: "orphan-accessed", content: "orphan-accessed", entity_id: undefined, created: "2026-07-01T00:00:00.000Z", last_accessed: WINDOW } as any);

		const queried = await storage.queryObservations({ touched_after: WINDOW, limit: 20 });
		expect(queried.map(row => row.observation.id).sort()).toEqual(["accessed", "new", "orphan-accessed"]);
		const batched = await storage.batchGetEntityObservations(["entity_window"], 20, WINDOW);
		expect((batched.get("entity_window") ?? []).map(row => row.observation.id).sort()).toEqual(["accessed", "new"]);
		// cutoffDate (StateWindow) must sit AFTER arrival (ArrivalBoundary) or
		// assertArrivalNotAfterCutoff throws (ops/ADR-JANITOR.md §2.1 "instance
		// sixteen") — orphans.ts's real caller never passes arrival at all now; this
		// exercises the storage method's own filtering with a still-satisfiable pair
		// (arrival before cutoff, not after) to prove the guard doesn't break a
		// genuinely valid combination.
		const arrival = "2026-07-15T00:00:00.000Z" as ArrivalBoundary;
		const cutoff = "2026-07-20T00:00:00.000Z" as StateWindow;
		const orphans = await storage.findOrphanCandidates(cutoff, 20, arrival);
		expect(orphans.map(row => row.id)).toEqual(["orphan-accessed"]);

		// Prove the guard is actually WIRED into the real backend, not just
		// defined and unused (Blind-Spot Guard: test the seam, not only the pure
		// unit — see test/arrival-not-after-cutoff-invariant.spec.ts for the pure
		// function's own coverage). Same shape as orphans.ts's pre-C2 bug: an
		// arrival boundary chronologically after the age cutoff.
		await expect(storage.findOrphanCandidates(cutoff, 20, WINDOW as ArrivalBoundary)).rejects.toThrow(
			/arrival boundary.*after the state-window cutoff/
		);
	});

	it("passes the window to all six sustainability sweeps", async () => {
		const observation = (id: string, entityId?: string) => ({
			id, content: id, created: "2026-07-31T00:00:00.000Z", entity_id: entityId,
			texture: { charge: ["one", "two"], charge_phase: "fresh" }, access_count: 0
		});

		const cascadeStorage: any = {
			queryObservations: vi.fn(async () => [{ observation: observation("cascade") }, { observation: observation("cascade-2") }]),
			recordMemoryCascade: vi.fn(async () => undefined)
		};
		await runCascadeTask(cascadeStorage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		expect(cascadeStorage.queryObservations).toHaveBeenCalledWith(expect.objectContaining({ touched_after: WINDOW }));

		const orphanStorage: any = {
			findOrphanCandidates: vi.fn(async () => []), listOrphans: vi.fn(async () => []),
			markOrphans: vi.fn(async () => 0), batchProposalExists: vi.fn(async () => new Set()),
			incrementRescueAttempts: vi.fn(async () => 0), getTenant: () => "rainer"
		};
		await runOrphanTask(orphanStorage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		// ops/ADR-JANITOR.md §2.1 "instance sixteen": orphans.ts never passes an
		// arrival boundary into findOrphanCandidates at all (C2 fix) — a StateWindow
		// age check paired with a recent-arrival requirement is close to
		// self-defeating for a query whose whole population is "rows nobody has
		// touched." DETECT_LIMIT_STEADY is derived (6), unlike cross-agent below
		// (flat 100) — not part of Eli's §2.1 blast-radius list, found by running
		// the full suite. The other sweeps below use their own pre-existing caps
		// (kit-hygiene: 200/120) or no numeric window-cap param at all (cascade,
		// cross-tenant, paradox-detection).
		expect(orphanStorage.findOrphanCandidates).toHaveBeenCalledWith(expect.any(String), 6);

		const crossAgentStorage: any = {
			listEntities: vi.fn(async () => [{ id: "agent-a", name: "A" }, { id: "agent-b", name: "B" }]),
			batchGetEntityObservations: vi.fn(async () => new Map()),
			batchProposalExists: vi.fn(async () => new Set())
		};
		await runCrossAgentTask(crossAgentStorage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		expect(crossAgentStorage.batchGetEntityObservations).toHaveBeenCalledWith(["agent-a", "agent-b"], 100, WINDOW);

		const otherTenant: any = { queryObservations: vi.fn(async () => []) };
		const crossTenantStorage: any = {
			getTenant: () => "companion", getAllowedTenants: () => ["companion", "rainer"], forTenant: vi.fn(() => otherTenant),
			queryObservations: vi.fn(async () => [{ observation: observation("a", "entity") }])
		};
		otherTenant.readDaemonConfig = vi.fn(async () => ({ data: {
			last_daemon_run: { started_at: "2026-07-29T03:00:00.000Z", finished_at: "2026-07-29T03:04:00.000Z" }
		} }));
		await runCrossTenantTask(crossTenantStorage, { arrivalBoundary: WINDOW as ArrivalBoundary, allowedTenants: ["companion", "rainer"] });
		expect(crossTenantStorage.queryObservations).toHaveBeenCalledWith(expect.objectContaining({ touched_after: WINDOW }));
		expect(otherTenant.queryObservations).toHaveBeenCalledWith(expect.objectContaining({ touched_after: "2026-07-29T03:00:00.000Z" }));
		expect(otherTenant.queryObservations).not.toHaveBeenCalledWith(expect.objectContaining({ touched_after: WINDOW }));

		const kitStorage: any = {
			getTenant: () => "rainer",
			listEntities: vi.fn(async ({ entity_type }: any) => entity_type === "agent"
				? [{ id: "agent-a", name: "A" }]
				: [{ id: "project-a", name: "P" }]),
			listProposals: vi.fn(async () => []),
			batchGetEntityObservations: vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, []]))),
			batchProposalExists: vi.fn(async () => new Set()),
			listProjectDossiers: vi.fn(async () => [{ project_entity_id: "project-a", metadata: {} }]),
			listTaskChangesSince: vi.fn(async () => [])
		};
		await runKitHygieneTask(kitStorage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		// The agent-scoped, window-bound fetch this used to assert was dedup's own
		// (ops/ADR-JANITOR.md §0.4/§6.1 — moved to daemon/tasks/dedup.ts, which is
		// corpus-wide and takes no arrival-boundary window at all). kit-hygiene's only
		// remaining window-dependent behavior is project routing hygiene, below.
		expect(kitStorage.batchGetEntityObservations).toHaveBeenCalledWith(["project-a"], 120, WINDOW);
		expect(kitStorage.listTaskChangesSince).toHaveBeenCalledWith(WINDOW, 200, true);

		// paradox-detection is the one sweep here that does NOT gate on
		// arrivalBoundary (dedicated coverage: test/paradox-detection.spec.ts). It's
		// a state check over its own fixed 30-real-day window, not an incremental
		// scan of what changed since WINDOW — so its challenge dates are
		// relative-to-now (must fall inside its live 30-day cutoff regardless of
		// when this suite runs), not tied to the WINDOW literal used by the other
		// five sweeps above.
		const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
		const paradoxStorage: any = {
			getTenant: () => "rainer",
			readIdentityCores: vi.fn(async () => [{ id: "core", name: "Core", challenges: [
				{ description: "one", date: daysAgo(25) },
				{ description: "two", date: daysAgo(15) },
				{ description: "three", date: daysAgo(2) }
			] }]),
			readOpenLoops: vi.fn(async () => []), proposalExists: vi.fn(async () => false),
			createProposal: vi.fn(async () => undefined)
		};
		// arrivalBoundary is still passed through (parity with the other five
		// sweeps' call shape) and correctly ignored — it does not gate this task's
		// result.
		await runParadoxDetectionTask(paradoxStorage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		expect(paradoxStorage.createProposal).toHaveBeenCalledTimes(1);
	});

	it("keeps kit consolidation thresholds corpus-wide (SQL-side counts), independent of any per-agent observation fetch", async () => {
		const storage: any = {
			getTenant: () => "rainer",
			listEntities: vi.fn(async ({ entity_type }: any) => entity_type === "agent" ? [{ id: "agent-a", name: "A" }] : []),
			listProposals: vi.fn(async () => []),
			countEntityObservations: vi.fn(async () => new Map([["agent-a", { total: 51, metabolized: 0 }]])),
			batchGetEntityObservations: vi.fn(async () => new Map([["agent-a", []]])),
			batchProposalExists: vi.fn(async () => new Set()),
			createProposal: vi.fn(async () => undefined)
		};

		await runKitHygieneTask(storage, { arrivalBoundary: WINDOW as ArrivalBoundary });
		expect(storage.countEntityObservations).toHaveBeenCalledWith(["agent-a"]);
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			proposal_type: "consolidation",
			rationale: expect.stringContaining("51 total observations")
		}));
	});

	it("retains an explicit tenant allowlist across storage clones", () => {
		const storage = createStorage({
			backend: "sqlite",
			sqlitePath: `/tmp/muse-brain-tenant-scope-${crypto.randomUUID()}.sqlite`,
			allowedTenants: ["rook", "rainer"]
		}, "rook");

		expect(storage.getAllowedTenants()).toEqual(["rook", "rainer"]);
		expect(storage.forTenant("rainer").getAllowedTenants()).toEqual(["rook", "rainer"]);
		expect(() => storage.forTenant("companion")).toThrow("Invalid tenant");
	});
});
