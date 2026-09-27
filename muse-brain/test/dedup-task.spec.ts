// ops/ADR-JANITOR.md §6, §9 commit 8 — runDedupTask. §5.0's canonical shadow
// definition applies verbatim: the task runs its full candidate scan, writes a
// bounded ScanRecord to daemon_config.data, and creates ZERO rows in
// daemon_proposals. Dedup's own "shadow" is the ABSENCE of a configured
// `dedup_similarity_threshold` (§6.3 — no default, ever) rather than a separate
// boolean flag the way salience_regrade_shadow/backlog_mode work — §3's "do not
// unify the two safety mechanisms" is asserted directly below.
import { describe, expect, it, vi } from "vitest";
import { runDedupTask } from "../src/daemon/tasks/dedup";
import type { Observation, Anchor } from "../src/types";
// DaemonTaskResult.scan is a union (RegradeSample | DedupSample) — this file
// only ever exercises runDedupTask, so every scan.sample element here is
// provably a DedupSample; narrow at the one spot below rather than widen
// every assertion to handle a shape this file never produces.
import type { DedupSample } from "../src/daemon/types";

function obs(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `memory ${id}`,
		territory: "craft",
		created: "2026-08-01T00:00:00.000Z",
		texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", charge_phase: "active" },
		access_count: 0,
		...overrides
	};
}

function pair(id: string, similarity: number, overrides: Partial<Observation> = {}) {
	return { observation: obs(id, overrides), territory: "craft", similarity };
}

function anchor(triggersMemoryId: string): Anchor {
	return {
		id: `anchor_${triggersMemoryId}`,
		type: "anchor",
		anchor_type: "context",
		content: "anchor",
		charge: [],
		triggers_memory_id: triggersMemoryId,
		created: "2026-01-01T00:00:00.000Z",
		activation_count: 0
	};
}

function makeStorage(overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: {} })),
		readAnchors: vi.fn(async () => [] as Anchor[]),
		queryObservations: vi.fn(async () => [] as Array<{ observation: Observation; territory: string }>),
		findSimilarByEmbedding: vi.fn(async () => [] as ReturnType<typeof pair>[]),
		proposalExists: vi.fn(async () => false),
		createProposal: vi.fn(async () => undefined),
		...overrides
	};
}

describe("runDedupTask", () => {
	it("returns a zeroed result and touches nothing else when the storage backend predates findSimilarByEmbedding", async () => {
		const storage = { getTenant: () => "rook" }; // no findSimilarByEmbedding at all

		const result = await runDedupTask(storage as any);

		expect(result).toEqual({ task: "dedup", changes: 0, proposals_created: 0 });
	});

	it("returns a zeroed scan when the scanned slice finds nothing", async () => {
		const storage = makeStorage();

		const result = await runDedupTask(storage as any);

		expect(result.proposals_created).toBe(0);
		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.scan).toMatchObject({ population_total: 0, candidates_total: 0, would_create: 0, created: 0, sample: [] });
	});

	describe("shadow — no configured threshold: creates NOTHING, ever", () => {
		it("runs the full scan and records candidates_total, but creates zero proposals and reports would_create: 0", async () => {
			const storage = makeStorage({
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			const result = await runDedupTask(storage as any);

			expect(result.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();
			// would_create is 0 under shadow even though a high-cosine pair exists —
			// there is no gate to preview passing without a configured threshold
			// (§6.3: no default, ever — distinct from salience_regrade's would_create,
			// which previews a WIP-cap headroom that exists independent of shadow).
			expect(result.scan).toMatchObject({ population_total: 1, candidates_total: 1, would_create: 0, created: 0 });
			expect(result.scan?.sample[0]).toMatchObject({ source_id: "obs_a", target_id: "obs_b", similarity: 0.9 });
		});

		it("never calls proposalExists or createProposal while shadow is on", async () => {
			const storage = makeStorage({
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			await runDedupTask(storage as any);

			expect(storage.proposalExists).not.toHaveBeenCalled();
			expect(storage.createProposal).not.toHaveBeenCalled();
		});
	});

	describe("live — a configured threshold creates proposals", () => {
		it("creates a dedup proposal with resonance_type 'duplicate' for a pair at or above the configured threshold", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.85)])
			});

			const result = await runDedupTask(storage as any);

			expect(result.proposals_created).toBe(1);
			expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
				proposal_type: "dedup",
				source_id: "obs_a",
				target_id: "obs_b",
				similarity: 0.85,
				resonance_type: "duplicate",
				status: "pending"
			}));
			expect(result.scan).toMatchObject({ would_create: 1, created: 1 });
		});

		it("does not create a proposal for a pair below the configured threshold, but still counts it in candidates_total", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.9 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.85)])
			});

			const result = await runDedupTask(storage as any);

			expect(result.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();
			expect(result.scan).toMatchObject({ candidates_total: 1, would_create: 0, created: 0 });
		});

		it("skips a pair that already has a proposal (proposalExists) without erroring or double-counting", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.85)]),
				proposalExists: vi.fn(async () => true)
			});

			const result = await runDedupTask(storage as any);

			expect(result.proposals_created).toBe(0);
			expect(storage.createProposal).not.toHaveBeenCalled();
		});
	});

	describe("protection list (§6.4 point 4 / §5.2's eighth clause) — every clause must actually exclude a row", () => {
		it("excludes a foundational source from being scanned at all", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_foundational", { texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "iron", charge_phase: "active" } }), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			const result = await runDedupTask(storage as any);

			expect(storage.findSimilarByEmbedding).not.toHaveBeenCalled();
			expect(result.scan).toMatchObject({ population_total: 0, candidates_total: 0 });
		});

		it("excludes a territory='self' source from being scanned at all", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_self", { territory: "self" }), territory: "self" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			const result = await runDedupTask(storage as any);

			expect(storage.findSimilarByEmbedding).not.toHaveBeenCalled();
			expect(result.scan?.population_total).toBe(0);
		});

		it("excludes a metabolized source from being scanned at all", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_metabolized", { texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", charge_phase: "metabolized" } }), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			const result = await runDedupTask(storage as any);

			expect(storage.findSimilarByEmbedding).not.toHaveBeenCalled();
			expect(result.scan?.population_total).toBe(0);
		});

		it("excludes an anchor's triggers_memory_id target from being scanned as a source", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				readAnchors: vi.fn(async () => [anchor("obs_anchored")]),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_anchored"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [pair("obs_b", 0.9)])
			});

			const result = await runDedupTask(storage as any);

			expect(storage.findSimilarByEmbedding).not.toHaveBeenCalled();
			expect(result.scan?.population_total).toBe(0);
		});

		it("excludes a protected CANDIDATE (target side) even when the source is unprotected — a foundational candidate is dropped from the pair", async () => {
			const storage = makeStorage({
				readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
				queryObservations: vi.fn(async () => [{ observation: obs("obs_a"), territory: "craft" }]),
				findSimilarByEmbedding: vi.fn(async () => [
					pair("obs_foundational_target", 0.95, { texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "iron", charge_phase: "active" } }),
					pair("obs_clean_target", 0.85)
				])
			});

			const result = await runDedupTask(storage as any);

			expect(result.scan?.candidates_total).toBe(1);
			expect((result.scan?.sample[0] as DedupSample | undefined)?.target_id).toBe("obs_clean_target");
			expect(storage.createProposal).toHaveBeenCalledTimes(1);
			expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({ target_id: "obs_clean_target" }));
		});
	});

	it("stores source_id/target_id in canonical (sorted) order regardless of which side was scanned first — so the same pair can't be stored reversed across separate runs", async () => {
		const storage = makeStorage({
			readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: { dedup_similarity_threshold: 0.8 } })),
			// "obs_z" is scanned as the SOURCE and finds "obs_a" as a candidate —
			// alphabetically obs_a < obs_z, so canonical order must flip them.
			queryObservations: vi.fn(async () => [{ observation: obs("obs_z"), territory: "craft" }]),
			findSimilarByEmbedding: vi.fn(async () => [pair("obs_a", 0.9)])
		});

		const result = await runDedupTask(storage as any);

		expect(result.scan?.sample[0]).toMatchObject({ source_id: "obs_a", target_id: "obs_z" });
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({ source_id: "obs_a", target_id: "obs_z" }));
	});

	it("deduplicates a pair found in both directions into a single candidate", async () => {
		const storage = makeStorage({
			queryObservations: vi.fn(async () => [
				{ observation: obs("obs_a"), territory: "craft" },
				{ observation: obs("obs_b"), territory: "craft" }
			]),
			findSimilarByEmbedding: vi.fn(async (sourceId: string) =>
				sourceId === "obs_a" ? [pair("obs_b", 0.9)] : [pair("obs_a", 0.9)]
			)
		});

		const result = await runDedupTask(storage as any);

		expect(result.scan?.candidates_total).toBe(1);
	});

	it("checks context.deadlineAt at the top of the scan loop and stops cleanly mid-batch", async () => {
		const storage = makeStorage({
			queryObservations: vi.fn(async () => [
				{ observation: obs("obs_a"), territory: "craft" },
				{ observation: obs("obs_b"), territory: "craft" }
			]),
			findSimilarByEmbedding: vi.fn(async () => {
				await new Promise(resolve => setTimeout(resolve, 20));
				return [];
			})
		});

		const result = await runDedupTask(storage as any, { deadlineAt: Date.now() + 10 });

		expect(result.truncated_by_deadline).toBe(true);
		expect(storage.findSimilarByEmbedding).toHaveBeenCalledTimes(1);
	});
});
