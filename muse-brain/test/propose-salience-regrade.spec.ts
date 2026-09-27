// ops/ADR-JANITOR.md §5, §8 — mind_propose's salience_regrade accept path.
// Non-negotiable #2: no automatic accept path exists, ever — only this
// human-initiated action=review can apply a demotion, and only once shadow is
// off. Rejection must stay allowed regardless of shadow (§5.5's anti-nag
// tombstone is unconditional).
import { describe, expect, it, vi } from "vitest";
import { handleTool as handleProposeTool } from "../src/tools-v2/propose";
import type { DaemonProposal, Observation } from "../src/types";

function makeProposal(overrides: Partial<DaemonProposal> = {}): DaemonProposal {
	return {
		id: overrides.id ?? "proposal_regrade_1",
		tenant_id: overrides.tenant_id ?? "rook",
		proposal_type: "salience_regrade",
		source_id: overrides.source_id ?? "obs_old_foundational",
		target_id: overrides.target_id ?? "obs_old_foundational",
		confidence: overrides.confidence ?? 0.5,
		rationale: overrides.rationale ?? "Foundational, access_count 0, not surfaced in 60+ days.",
		metadata: overrides.metadata ?? { action: "demote_to_active", shadow: true },
		status: overrides.status ?? "pending",
		proposed_at: overrides.proposed_at ?? "2026-08-01T03:00:00.000Z"
	};
}

function makeObservation(id: string): Observation {
	return {
		id,
		content: `foundational memory ${id}`,
		territory: "craft",
		created: "2025-01-01T00:00:00.000Z",
		texture: {
			salience: "foundational",
			vividness: "vivid",
			charge: ["pride"],
			grip: "iron"
		},
		access_count: 0
	};
}

function makeStorage(proposal: DaemonProposal, overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		getProposalById: vi.fn(async () => proposal),
		reviewProposal: vi.fn(async (id: string, status: string, note?: string) => ({
			...proposal,
			status,
			feedback_note: note,
			reviewed_at: "2026-08-02T00:00:00.000Z"
		})),
		findObservation: vi.fn(async (id: string) => ({ territory: "craft", observation: makeObservation(id) })),
		updateObservationTexture: vi.fn(async () => undefined),
		...overrides
	};
}

describe("mind_propose action=review — salience_regrade", () => {
	it("refuses to accept a shadow-tagged proposal, and leaves it pending (reviewProposal never called)", async () => {
		const proposal = makeProposal({ metadata: { action: "demote_to_active", shadow: true } });
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(result.error).toMatch(/shadow mode/i);
		expect(storage.reviewProposal).not.toHaveBeenCalled();
		expect(storage.updateObservationTexture).not.toHaveBeenCalled();
	});

	it("still allows REJECTING a shadow-tagged proposal — rejection is always safe and permanent", async () => {
		const proposal = makeProposal({ metadata: { action: "demote_to_active", shadow: true } });
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "rejected"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "rejected", undefined);
		expect(storage.updateObservationTexture).not.toHaveBeenCalled();
		expect(result.reviewed).toBe(true);
		expect(result.decision).toBe("rejected");
	});

	it("demotes foundational to active on accept once shadow is false", async () => {
		const proposal = makeProposal({ metadata: { action: "demote_to_active", shadow: false } });
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "accepted", undefined);
		expect(storage.updateObservationTexture).toHaveBeenCalledWith(
			proposal.source_id,
			expect.objectContaining({ salience: "active" })
		);
		// One step, never two (ops/ADR-JANITOR.md §5.2) — every other texture
		// dimension survives the update untouched.
		expect(storage.updateObservationTexture).toHaveBeenCalledWith(
			proposal.source_id,
			expect.objectContaining({ grip: "iron", vividness: "vivid" })
		);
		expect(result.action_taken).toBe("demoted_to_active");
	});

	it("treats a missing metadata.shadow (undefined) as NOT shadow-blocked — only a literal true blocks accept", async () => {
		const proposal = makeProposal({ metadata: { action: "demote_to_active" } });
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(result.error).toBeUndefined();
		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "accepted", undefined);
	});
});
