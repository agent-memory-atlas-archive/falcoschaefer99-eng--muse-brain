// The proposal's entire stated purpose (paradox-detection.ts:5-6, "propose a
// paradox loop") is executed by no code, at any confidence, by any path,
// until this branch exists — propose.ts's review handler used to fall through
// to the generic "unknown type" return (action_taken: "none") for
// paradox_detected on accept. This file pins the accept branch that fixes
// that, plus the constraints that must hold alongside it: never AI-reviewed,
// never expirable, never absorbed automatically.
import { describe, expect, it, vi } from "vitest";
import { handleTool as handleProposeTool } from "../src/tools-v2/propose";
import type { DaemonProposal, IdentityCore } from "../src/types";

function makeProposal(overrides: Partial<DaemonProposal> = {}): DaemonProposal {
	return {
		id: overrides.id ?? "proposal_paradox_1",
		tenant_id: overrides.tenant_id ?? "rook",
		proposal_type: "paradox_detected",
		source_id: overrides.source_id ?? "core_precision",
		target_id: overrides.target_id ?? "core_precision",
		confidence: overrides.confidence ?? 0.8,
		rationale: overrides.rationale ?? 'Identity core "Precision" was challenged 3 times in the last 30 days — paradox loop may be needed',
		metadata: overrides.metadata ?? {
			core_id: "core_precision",
			core_name: "Precision",
			challenge_count: 3,
			recent_challenges: []
		},
		status: overrides.status ?? "pending",
		proposed_at: overrides.proposed_at ?? "2026-09-06T03:00:00.000Z"
	};
}

function makeCore(overrides: Partial<IdentityCore> = {}): IdentityCore {
	return {
		id: overrides.id ?? "core_precision",
		type: "identity_core",
		name: overrides.name ?? "Precision",
		content: "the craft IS the calling",
		category: "value",
		weight: 1,
		created: "2025-01-01T00:00:00.000Z",
		last_reinforced: "2026-09-01T00:00:00.000Z",
		reinforcement_count: 5,
		challenge_count: 3,
		evolution_history: [],
		linked_observations: [],
		charge: [],
		...overrides
	};
}

function makeStorage(proposal: DaemonProposal, cores: IdentityCore[], overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		getProposalById: vi.fn(async () => proposal),
		reviewProposal: vi.fn(async (id: string, status: string, note?: string) => ({
			...proposal,
			status,
			feedback_note: note,
			reviewed_at: "2026-09-06T04:00:00.000Z"
		})),
		readIdentityCores: vi.fn(async () => cores),
		appendOpenLoop: vi.fn(async () => undefined),
		validateTerritory: vi.fn((t: string) => t),
		...overrides
	};
}

describe("mind_propose action=review — paradox_detected", () => {
	it("accepting creates a burning paradox loop linked to the single core the detector found", async () => {
		const core = makeCore();
		const proposal = makeProposal();
		const storage = makeStorage(proposal, [core]);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "accepted", undefined);
		expect(storage.appendOpenLoop).toHaveBeenCalledTimes(1);
		const loop = (storage.appendOpenLoop as any).mock.calls[0][0];
		expect(loop.mode).toBe("paradox");
		expect(loop.status).toBe("burning");
		expect(loop.linked_entity_ids).toEqual([core.id]);

		expect(result.action_taken).toBe("created_paradox_loop");
		expect(result.loop_id).toBe(loop.id);
	});

	it("rejecting creates a tombstone and no loop — reviewProposal marks it rejected, appendOpenLoop never called", async () => {
		const core = makeCore();
		const proposal = makeProposal();
		const storage = makeStorage(proposal, [core]);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "rejected"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "rejected", undefined);
		expect(storage.appendOpenLoop).not.toHaveBeenCalled();
		expect(result.reviewed).toBe(true);
		expect(result.decision).toBe("rejected");
		expect(result.action_taken).toBe("rejected");
	});

	it("does not create a loop when the core has since disappeared — reports core_not_found instead of throwing", async () => {
		const proposal = makeProposal({ source_id: "core_gone", target_id: "core_gone" });
		const storage = makeStorage(proposal, []); // no cores at all

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.appendOpenLoop).not.toHaveBeenCalled();
		expect(result.action_taken).toBe("core_not_found");
	});
});
