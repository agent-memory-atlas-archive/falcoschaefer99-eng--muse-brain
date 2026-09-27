// ops/ADR-JANITOR.md §5, §8 — runSalienceRegradeTask. Commit 7b's invariant: "a
// tombstone may only record a decision that could have gone the other way," so
// shadow mode now creates ZERO proposals (not one-per-candidate tagged
// shadow:true, commit 7's bug — every night-1 candidate got permanently
// excluded from ever becoming a real, acceptable proposal, on night 1, before
// shadow ever lifted). This file tests the TASK's own logic (config read,
// ordering, WIP-cap throughput, scan record, proposal creation) against a
// hand-rolled mock storage, mirroring orphan-batch-marking.spec.ts /
// absorption-daemon.spec.ts's style. The storage-layer candidate query's
// protection list is tested separately, end to end against the real sqlite
// backend, in salience-regrade-candidates.spec.ts.
import { describe, expect, it, vi } from "vitest";
import {
	runSalienceRegradeTask,
	REGRADE_WIP_CAP_EARLY,
	REGRADE_WIP_CAP,
	REGRADE_RAMP_REVIEWED
} from "../src/daemon/tasks/salience-regrade";
import type { Observation } from "../src/types";
// DaemonTaskResult.scan is a union (RegradeSample | DedupSample, ops/ADR-JANITOR.md
// §6 commit 8) — this file only ever exercises runSalienceRegradeTask, so every
// scan.sample element here is provably a RegradeSample; narrow at the two spots
// below rather than widen every assertion to handle a shape this file never produces.
import type { RegradeSample } from "../src/daemon/types";

function candidate(id: string, overrides: Partial<Observation["texture"]> = {}, accessCount = 0): Observation {
	return {
		id,
		content: `foundational memory ${id}`,
		territory: "craft",
		created: "2025-01-01T00:00:00.000Z",
		texture: {
			salience: "foundational",
			vividness: "vivid",
			charge: [],
			grip: "iron",
			...overrides
		},
		access_count: accessCount
	};
}

type ProposalStats = Record<string, { total: number; accepted: number; rejected: number; ratio: number }>;

function makeStorage(overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: {} })),
		findSalienceRegradeCandidates: vi.fn(async () => [] as Observation[]),
		createProposal: vi.fn(async () => undefined),
		countFoundationalObservations: vi.fn(async () => 0),
		getProposalStats: vi.fn(async () => ({} as ProposalStats)),
		...overrides
	};
}

function shadowOffConfig(extra: Record<string, unknown> = {}) {
	return vi.fn(async () => ({
		tenant_id: "rook", link_proposal_threshold: 0.75,
		data: { salience_regrade_shadow: false, ...extra }
	}));
}

describe("runSalienceRegradeTask", () => {
	it("returns a zeroed result and never reads daemon_config when the storage backend predates this optional method", async () => {
		const storage = { getTenant: () => "rook" }; // no findSalienceRegradeCandidates at all

		const result = await runSalienceRegradeTask(storage as any);

		expect(result).toEqual({ task: "salience-regrade", changes: 0, proposals_created: 0 });
	});

	it("returns a zeroed result with a zeroed scan when zero candidates are found — no createProposal calls", async () => {
		const storage = makeStorage();

		const result = await runSalienceRegradeTask(storage as any);

		expect(result.changes).toBe(0);
		expect(result.proposals_created).toBe(0);
		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.scan).toMatchObject({ candidates_total: 0, would_create: 0, sample: [], sample_truncated_to: 0 });
	});

	describe("shadow mode — commit 7b: creates NOTHING, ever", () => {
		it("creates zero proposals while shadow is on (absent key = default on), and returns a scan record instead", async () => {
			const storage = makeStorage({
				findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_a"), candidate("obs_b")])
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();
			expect(result.scan).toMatchObject({ candidates_total: 2, would_create: 2 });
		});

		it("ops/ADR-JANITOR.md §2.1 instance nine (commit 7c): scan.created is 0 under shadow even though would_create is nonzero on a non-empty pool — the exact bug wake.ts used to have", async () => {
			const storage = makeStorage({
				findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_a"), candidate("obs_b")])
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.scan?.would_create).toBeGreaterThan(0);
			expect(result.scan?.created).toBe(0);
		});

		it("round-trip: the SAME candidates are still eligible once shadow lifts, and now receive real proposals — the exact regression commit 7 shipped", async () => {
			const candidates = [candidate("obs_x"), candidate("obs_y")];
			// A real backend would keep returning these two forever under shadow,
			// because nothing was ever created against them (no prior-proposal
			// exclusion clause can fire). This mock models that literally: the same
			// fixed list, regardless of what the daemon_config read returns.
			const findSalienceRegradeCandidates = vi.fn(async () => candidates);
			const storage = makeStorage({ findSalienceRegradeCandidates });

			const shadowOnResult = await runSalienceRegradeTask(storage as any);
			expect(shadowOnResult.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();

			storage.readDaemonConfig = shadowOffConfig();
			const shadowOffResult = await runSalienceRegradeTask(storage as any);

			expect(shadowOffResult.proposals_created).toBe(2);
			expect(storage.createProposal).toHaveBeenCalledTimes(2);
			const createdSourceIds = (storage.createProposal as any).mock.calls.map((call: any[]) => call[0].source_id);
			expect(createdSourceIds).toEqual(expect.arrayContaining(["obs_x", "obs_y"]));
		});

		it("never puts metadata.shadow on a created proposal — the field has exactly one reachable value now, so it's gone entirely", async () => {
			const storage = makeStorage({
				readDaemonConfig: shadowOffConfig(),
				findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_c")])
			});

			await runSalienceRegradeTask(storage as any);

			const call = (storage.createProposal as any).mock.calls[0][0];
			expect(call.metadata).toEqual({ action: "demote_to_active" });
			expect(call.metadata).not.toHaveProperty("shadow");
		});
	});

	describe("WIP cap — ops/ADR-JANITOR.md §5.2/§5.3's ramp, as a pending-queue ceiling", () => {
		function pool(n: number): Observation[] {
			return Array.from({ length: n }, (_, i) => candidate(`obs_${i}`, {}, i));
		}

		it("pool of 40, zero reviewed yet, zero pending: caps creation at REGRADE_WIP_CAP_EARLY (10)", async () => {
			const storage = makeStorage({
				readDaemonConfig: shadowOffConfig(),
				findSalienceRegradeCandidates: vi.fn(async () => pool(40))
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.proposals_created).toBe(REGRADE_WIP_CAP_EARLY);
			expect(storage.createProposal).toHaveBeenCalledTimes(REGRADE_WIP_CAP_EARLY);
			expect(result.scan?.would_create).toBe(REGRADE_WIP_CAP_EARLY);
			expect(result.scan?.created).toBe(REGRADE_WIP_CAP_EARLY);
			expect(result.scan?.candidates_total).toBe(40);
		});

		it("re-run with 10 already pending: headroom is exhausted, creates zero more", async () => {
			const storage = makeStorage({
				readDaemonConfig: shadowOffConfig(),
				findSalienceRegradeCandidates: vi.fn(async () => pool(40)),
				getProposalStats: vi.fn(async () => ({
					salience_regrade: { total: 10, accepted: 0, rejected: 0, ratio: 0 }
				} as ProposalStats))
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();
		});

		it("once 30 total reviews have accumulated (accepted+rejected), the cap widens to REGRADE_WIP_CAP (25)", async () => {
			const storage = makeStorage({
				readDaemonConfig: shadowOffConfig(),
				findSalienceRegradeCandidates: vi.fn(async () => pool(40)),
				getProposalStats: vi.fn(async () => ({
					salience_regrade: { total: REGRADE_RAMP_REVIEWED, accepted: 20, rejected: 10, ratio: 0.66 }
				} as ProposalStats))
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.proposals_created).toBe(REGRADE_WIP_CAP);
			expect(storage.createProposal).toHaveBeenCalledTimes(REGRADE_WIP_CAP);
		});

		it("headroom accounts for BOTH the cap tier and currently-pending rows (partial headroom)", async () => {
			const storage = makeStorage({
				readDaemonConfig: shadowOffConfig(),
				findSalienceRegradeCandidates: vi.fn(async () => pool(40)),
				getProposalStats: vi.fn(async () => ({
					salience_regrade: { total: 4, accepted: 0, rejected: 0, ratio: 0 } // 4 pending, cap 10 => headroom 6
				} as ProposalStats))
			});

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.proposals_created).toBe(6);
		});
	});

	it("breaks the create loop on context.deadlineAt, matching orphans.ts's per-item deadline discipline, and reports truncated_by_deadline", async () => {
		const storage = makeStorage({
			readDaemonConfig: shadowOffConfig(),
			findSalienceRegradeCandidates: vi.fn(async () => [
				candidate("obs_first", {}, 0),
				candidate("obs_second", {}, 1),
				candidate("obs_third", {}, 2)
			])
		});

		// Deadline already passed — the very first iteration must break immediately.
		const result = await runSalienceRegradeTask(storage as any, { deadlineAt: Date.now() - 1 });

		expect(result.proposals_created).toBe(0);
		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.truncated_by_deadline).toBe(true);
		// ops/ADR-JANITOR.md §2.1 instance nine — the one case where scan.created
		// is expected to fall short of would_create: the cap said 3 were allowed
		// (headroom exceeds the 3-candidate pool), but the deadline broke the
		// loop before any insert happened.
		expect(result.scan?.would_create).toBe(3);
		expect(result.scan?.created).toBe(0);
	});

	it("proposes the least-alive candidate first (ascending calculatePullStrength), not storage order", async () => {
		// Higher charge count + more recent access => higher pull strength.
		const highPull = candidate("obs_high_pull", { charge: ["grief", "pride", "awe"] }, 5);
		const lowPull = candidate("obs_low_pull", { charge: [] }, 0);

		const storage = makeStorage({
			readDaemonConfig: shadowOffConfig(),
			// Storage returns them in the "wrong" order on purpose — the task must re-sort.
			findSalienceRegradeCandidates: vi.fn(async () => [highPull, lowPull])
		});

		await runSalienceRegradeTask(storage as any);

		const createdSourceIds = (storage.createProposal as any).mock.calls.map(
			(call: any[]) => call[0].source_id
		);
		expect(createdSourceIds).toEqual(["obs_low_pull", "obs_high_pull"]);
	});

	it("creates one proposal per candidate returned (within headroom), with a rationale mentioning access_count", async () => {
		const storage = makeStorage({
			readDaemonConfig: shadowOffConfig(),
			findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_c", {}, 1)])
		});

		await runSalienceRegradeTask(storage as any);

		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			rationale: expect.stringContaining("access_count 1")
		}));
	});

	describe("scan record", () => {
		it("population_total comes from countFoundationalObservations, falling back to 0 when the method is absent", async () => {
			const withCount = makeStorage({
				countFoundationalObservations: vi.fn(async () => 515),
				findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_a")])
			});
			const result = await runSalienceRegradeTask(withCount as any);
			expect(result.scan?.population_total).toBe(515);

			const withoutCount: Record<string, unknown> = makeStorage({
				findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_a")])
			});
			delete withoutCount.countFoundationalObservations;
			const resultNoCount = await runSalienceRegradeTask(withoutCount as any);
			expect(resultNoCount.scan?.population_total).toBe(0);
		});

		it("caps the sample at 25 items and reports sample_truncated_to accurately", async () => {
			const many = Array.from({ length: 40 }, (_, i) => candidate(`obs_${i}`, {}, i));
			const storage = makeStorage({ findSalienceRegradeCandidates: vi.fn(async () => many) });

			const result = await runSalienceRegradeTask(storage as any);

			expect(result.scan?.sample).toHaveLength(25);
			expect(result.scan?.sample_truncated_to).toBe(25);
			expect(result.scan?.candidates_total).toBe(40);
		});

		it("each sample item's summary is truncated to <=120 chars and includes id/created/access_count/pull_strength/rationale", async () => {
			const longContent = "x".repeat(300);
			const obs: Observation = {
				...candidate("obs_long", {}, 3),
				content: longContent
			};
			const storage = makeStorage({ findSalienceRegradeCandidates: vi.fn(async () => [obs]) });

			const result = await runSalienceRegradeTask(storage as any);
			const sample = result.scan?.sample[0] as RegradeSample | undefined;

			expect(sample?.id).toBe("obs_long");
			expect(sample?.summary.length).toBeLessThanOrEqual(120);
			expect(sample?.access_count).toBe(3);
			expect(typeof sample?.pull_strength).toBe("number");
			expect(sample?.rationale).toContain("access_count 3");
		});

		it("ops/ADR-JANITOR.md §2.1 instance nine (commit 7c): last_surfaced_at round-trips a real value from the candidate Observation into the sample — reads Observation.last_surfaced_at, NOT Observation.texture.last_surfaced_at (which is structurally always undefined)", async () => {
			const surfacedAt = "2026-01-01T00:00:00.000Z";
			const obs: Observation = { ...candidate("obs_surfaced", {}, 1), last_surfaced_at: surfacedAt };
			const storage = makeStorage({ findSalienceRegradeCandidates: vi.fn(async () => [obs]) });

			const result = await runSalienceRegradeTask(storage as any);

			// Proves this isn't passing because both sides are null: a real,
			// non-null value must survive the Observation -> sample mapping.
			expect((result.scan?.sample[0] as RegradeSample | undefined)?.last_surfaced_at).toBe(surfacedAt);
		});

		it("last_surfaced_at falls back to null on the sample when the candidate never had one", async () => {
			const storage = makeStorage({ findSalienceRegradeCandidates: vi.fn(async () => [candidate("obs_never_surfaced")]) });

			const result = await runSalienceRegradeTask(storage as any);

			expect((result.scan?.sample[0] as RegradeSample | undefined)?.last_surfaced_at).toBeNull();
		});
	});
});
