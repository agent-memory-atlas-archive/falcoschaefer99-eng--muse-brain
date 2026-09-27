// cross_tenant is the one proposal_type this pass deliberately leaves without
// an accept branch. Its source_id/target_id are two real observation IDs, one
// per tenant — structurally the same shape "link" and "dedup" use, and the
// honest accept action that shape implies (a genuinely bidirectional link, so
// BOTH tenants can surface the convergence) requires writing the reverse link
// into the OTHER tenant's storage. ADR-JANITOR.md §8's "never automatic" list,
// item 5, names any cross-tenant action as the sovereignty boundary — building
// that write without Eli's sign-off would be inferring a design decision from
// the proposal's shape, which is exactly what was asked not to do.
//
// This file pins that the deferral is deliberate and unchanged by this
// commit — not a regression, not an oversight rediscovered later — and that
// no cross-tenant write of ANY kind happens on accept or reject.
import { describe, expect, it, vi } from "vitest";
import { handleTool as handleProposeTool } from "../src/tools-v2/propose";
import type { DaemonProposal } from "../src/types";

function makeProposal(overrides: Partial<DaemonProposal> = {}): DaemonProposal {
	return {
		id: overrides.id ?? "proposal_cross_tenant_1",
		tenant_id: overrides.tenant_id ?? "rook",
		proposal_type: "cross_tenant",
		source_id: overrides.source_id ?? "obs_rook_1",
		target_id: overrides.target_id ?? "obs_rainer_1",
		confidence: overrides.confidence ?? 0.8,
		rationale: overrides.rationale ?? "Cross-tenant convergence: rook and rainer both have observations about the same entity in shared territory 'craft'",
		metadata: overrides.metadata ?? {
			tenant_a: "rook",
			tenant_b: "rainer",
			obs_a: "obs_rook_1",
			obs_b: "obs_rainer_1",
			territory: "craft",
			entity_id: "entity_shared"
		},
		status: overrides.status ?? "pending",
		proposed_at: overrides.proposed_at ?? "2026-09-06T03:00:00.000Z"
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
			reviewed_at: "2026-09-06T04:00:00.000Z"
		})),
		forTenant: vi.fn(() => {
			throw new Error("forTenant must never be called by mind_propose review — cross_tenant accept is unbuilt");
		}),
		appendLink: vi.fn(async () => undefined),
		appendToTerritory: vi.fn(async () => undefined),
		...overrides
	};
}

describe("mind_propose action=review — cross_tenant (deliberately deferred)", () => {
	it("accepting is a no-op — same action_taken as before this commit, no write of any kind, no forTenant call", async () => {
		const proposal = makeProposal();
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "accepted", undefined);
		expect(storage.forTenant).not.toHaveBeenCalled();
		expect(storage.appendLink).not.toHaveBeenCalled();
		expect(storage.appendToTerritory).not.toHaveBeenCalled();
		expect(result.action_taken).toBe("none");
	});

	it("rejecting creates a plain tombstone — no forTenant call, no write", async () => {
		const proposal = makeProposal();
		const storage = makeStorage(proposal);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "rejected"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "rejected", undefined);
		expect(storage.forTenant).not.toHaveBeenCalled();
		expect(storage.appendLink).not.toHaveBeenCalled();
		expect(result.action_taken).toBe("rejected");
	});
});
