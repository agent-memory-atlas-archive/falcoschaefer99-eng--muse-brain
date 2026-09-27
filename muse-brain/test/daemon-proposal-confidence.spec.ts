// ops/ADR-JANITOR.md §3, §9 commit 5 — the link-proposal confidence formula
// used to blend similarity/charge/entity as independently config-tunable
// weights, then re-gate that blend against the SAME threshold as the raw
// similarity gate. With zero charge overlap, max reachable confidence was
// 0.6 (default similarity_weight) — nothing could ever clear a threshold
// above 0.6, and a control loop (learning.ts) spent five weeks raising an
// unreachable threshold to its 0.95 ceiling chasing a formula that could
// never satisfy it (§0.3). This file pins the corrected behavior: similarity
// is the ONLY gate; charge overlap is a bonus that can raise confidence
// above similarity but never substitute for it.
import { describe, expect, it, vi } from "vitest";

import { runProposalTask } from "../src/daemon/tasks/proposals";

function observation(id: string, charges: string[] = []) {
	return {
		id,
		content: `observation ${id}`,
		territory: "general",
		created: "2026-09-01T00:00:00.000Z",
		texture: { salience: "present", vividness: "moderate", charge: charges, grip: "loose", charge_phase: "fresh" },
		access_count: 0
	};
}

function similarHit(id: string, similarity: number, charges: string[] = []) {
	return [{ observation: observation(id, charges), territory: "general", similarity }];
}

function makeStorage(overrides: Record<string, any> = {}) {
	return {
		expireStaleProposals: vi.fn(async () => 0),
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: {} })),
		queryObservations: vi.fn(async () => [{ observation: observation("obs_source"), territory: "general" }]),
		findSimilarUnlinked: vi.fn(async () => []),
		createProposal: vi.fn(async (p: any) => ({ ...p, id: "prop_1", proposed_at: new Date().toISOString() })),
		getTenant: () => "rook",
		...overrides
	};
}

describe("runProposalTask — confidence formula (ops/ADR-JANITOR.md §3)", () => {
	it("zero shared charges + similarity 0.80 CREATES a proposal at threshold 0.75 — the exact regression this commit fixes (the old formula's max confidence at zero charge overlap was 0.6, so this pair could never have cleared 0.75 before)", async () => {
		const storage = makeStorage({
			findSimilarUnlinked: vi.fn(async () => similarHit("obs_target", 0.8, []))
		});

		const result = await runProposalTask(storage as any);

		expect(storage.createProposal).toHaveBeenCalledTimes(1);
		const created = (storage.createProposal as any).mock.calls[0][0];
		expect(created.confidence).toBeCloseTo(0.8, 10);
		expect(created.similarity).toBe(0.8);
		expect(result.proposals_created).toBe(1);
	});

	it("charge overlap is a bonus on top of similarity, never a substitute — full charge overlap cannot rescue a below-threshold similarity", async () => {
		const storage = makeStorage({
			queryObservations: vi.fn(async () => [{ observation: observation("obs_source", ["grief"]), territory: "general" }]),
			findSimilarUnlinked: vi.fn(async () => similarHit("obs_target", 0.7, ["grief"]))
		});

		const result = await runProposalTask(storage as any);

		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.proposals_created).toBe(0);
	});

	it("charge overlap raises confidence above similarity for an already-eligible pair (can push it into absorption.ts's LINK_CONFIDENCE_THRESHOLD 0.92 auto-link band) without ever being what decided creation — that was similarity alone at the gate above", async () => {
		const storage = makeStorage({
			queryObservations: vi.fn(async () => [{ observation: observation("obs_source", ["grief"]), territory: "general" }]),
			findSimilarUnlinked: vi.fn(async () => similarHit("obs_target", 0.85, ["grief"]))
		});

		await runProposalTask(storage as any);

		const created = (storage.createProposal as any).mock.calls[0][0];
		// 0.85 + CHARGE_BONUS(0.10) * chargeRatio(1.0, full overlap)
		expect(created.confidence).toBeCloseTo(0.95, 10);
	});

	it("documents the mandatory runbook step (ops/ADR-JANITOR.md §9 commit 5): at the LIVE threshold of 0.95, the same 0.80-similarity zero-shared-charge pair from the first test still creates NOTHING — the formula fix is inert until a one-time updateProposalThreshold(0.75) runs", async () => {
		const storage = makeStorage({
			readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.95, data: {} })),
			findSimilarUnlinked: vi.fn(async () => similarHit("obs_target", 0.8, []))
		});

		const result = await runProposalTask(storage as any);

		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.proposals_created).toBe(0);
	});
});
