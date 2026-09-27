// cross-agent.ts (daemon/tasks/cross-agent.ts) stages a pending
// ConsolidationCandidate (suggested_type: "synthesis") AND a "cross_agent"
// daemon_proposal in the same loop iteration, from the same sourceObsIds —
// but propose.ts's review handler had no branch for either accept OR reject
// of the "cross_agent" proposal_type itself, so accepting one fell through
// to the generic "unknown type" return (action_taken: "none"). This file
// pins the accept branch that fixes that, plus the constraints it must hold
// alongside it: sources stay live (never metabolized — different agents,
// not one agent's redundant history), the staged candidate is closed when
// found, and a hand-edited/corrupted metadata shape fails safely instead of
// throwing.
import { describe, expect, it, vi } from "vitest";
import { handleTool as handleProposeTool } from "../src/tools-v2/propose";
import type { ConsolidationCandidate, DaemonProposal } from "../src/types";

function makeProposal(overrides: Partial<DaemonProposal> = {}): DaemonProposal {
	return {
		id: overrides.id ?? "proposal_cross_agent_1",
		tenant_id: overrides.tenant_id ?? "rook",
		proposal_type: "cross_agent",
		source_id: overrides.source_id ?? "entity_muse_brain",
		target_id: overrides.target_id ?? "entity_muse_brain",
		confidence: overrides.confidence ?? 0.8,
		rationale: overrides.rationale ?? "Agents June, Reeve have convergent observations about the same entity — synthesis opportunity",
		metadata: overrides.metadata ?? {
			target_entity_id: "entity_muse_brain",
			agents: [
				{ agent_id: "agent_june", agent_name: "June", obs_id: "obs_june_1" },
				{ agent_id: "agent_reeve", agent_name: "Reeve", obs_id: "obs_reeve_1" }
			],
			observation_count: 2
		},
		status: overrides.status ?? "pending",
		proposed_at: overrides.proposed_at ?? "2026-09-06T03:00:00.000Z"
	};
}

function makeCandidate(overrides: Partial<ConsolidationCandidate> = {}): ConsolidationCandidate {
	return {
		id: overrides.id ?? "candidate_1",
		tenant_id: overrides.tenant_id ?? "rook",
		source_observation_ids: overrides.source_observation_ids ?? ["obs_june_1", "obs_reeve_1"],
		pattern_description: overrides.pattern_description ?? "June, Reeve independently have findings about entity entity_muse_brain",
		suggested_type: overrides.suggested_type ?? "synthesis",
		status: overrides.status ?? "pending",
		created_at: overrides.created_at ?? "2026-09-06T02:00:00.000Z"
	};
}

function makeStorage(proposal: DaemonProposal, candidates: ConsolidationCandidate[], overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		getProposalById: vi.fn(async () => proposal),
		reviewProposal: vi.fn(async (id: string, status: string, note?: string) => ({
			...proposal,
			status,
			feedback_note: note,
			reviewed_at: "2026-09-06T04:00:00.000Z"
		})),
		listConsolidationCandidates: vi.fn(async () => candidates),
		reviewConsolidationCandidate: vi.fn(async (id: string, status: string) => ({
			...(candidates.find(c => c.id === id) ?? makeCandidate({ id })),
			status
		})),
		appendToTerritory: vi.fn(async () => undefined),
		forTenant: vi.fn(() => {
			throw new Error("forTenant must never be called by cross_agent's accept branch — the whole proposal is same-tenant");
		}),
		...overrides
	};
}

describe("mind_propose action=review — cross_agent", () => {
	it("accepting creates a synthesis observation, closes the staged candidate, and never metabolizes the contributing observations", async () => {
		const proposal = makeProposal();
		const candidate = makeCandidate();
		const storage = makeStorage(proposal, [candidate]);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "accepted", undefined);
		expect(storage.reviewConsolidationCandidate).toHaveBeenCalledWith(candidate.id, "accepted");

		expect(storage.appendToTerritory).toHaveBeenCalledTimes(1);
		const [territory, obs] = (storage.appendToTerritory as any).mock.calls[0];
		expect(territory).toBe("craft");
		expect(obs.type).toBe("synthesis");
		expect(obs.entity_id).toBe("entity_muse_brain");
		expect(obs.source_observations).toEqual(["obs_june_1", "obs_reeve_1"]);
		// updateObservationTexture would be how a source gets metabolized —
		// it must never be called for either contributing observation.
		expect((storage as any).updateObservationTexture).toBeUndefined();

		expect(result.action_taken).toBe("created_synthesis_observation");
		expect(result.synthesis_observation_id).toBe(obs.id);
		expect(result.entity_id).toBe("entity_muse_brain");
		expect(result.contributing_observation_ids).toEqual(["obs_june_1", "obs_reeve_1"]);
		expect(result.candidate_id).toBe(candidate.id);

		// Tenant scoping: everything above ran through the single storage handle
		// passed in — forTenant() (which the mock wires to throw) was never called.
		expect((storage as any).forTenant).not.toHaveBeenCalled();
	});

	it("still creates the synthesis observation when no matching candidate exists — the candidate is a cross-reference, not a dependency", async () => {
		const proposal = makeProposal();
		const storage = makeStorage(proposal, []); // no candidates at all

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewConsolidationCandidate).not.toHaveBeenCalled();
		expect(storage.appendToTerritory).toHaveBeenCalledTimes(1);
		expect(result.action_taken).toBe("created_synthesis_observation");
		expect(result.candidate_id).toBeUndefined();
	});

	it("does not match a candidate whose source_observation_ids only partially overlaps", async () => {
		const proposal = makeProposal();
		// Same two IDs plus a third — not an exact set match, must not be treated as staged for this proposal.
		const nearMiss = makeCandidate({ id: "candidate_near_miss", source_observation_ids: ["obs_june_1", "obs_reeve_1", "obs_extra"] });
		const storage = makeStorage(proposal, [nearMiss]);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.reviewConsolidationCandidate).not.toHaveBeenCalled();
		expect(result.candidate_id).toBeUndefined();
	});

	it("reports invalid_metadata and creates nothing when fewer than 2 obs IDs are present — the daemon task never proposes cross_agent below 2 agents", async () => {
		const proposal = makeProposal({
			metadata: {
				target_entity_id: "entity_muse_brain",
				agents: [{ agent_id: "agent_june", agent_name: "June", obs_id: "obs_june_1" }],
				observation_count: 1
			}
		});
		const storage = makeStorage(proposal, []);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "accepted"
		}, { storage: storage as any });

		expect(storage.appendToTerritory).not.toHaveBeenCalled();
		expect(storage.reviewConsolidationCandidate).not.toHaveBeenCalled();
		expect(result.action_taken).toBe("invalid_metadata");
	});

	it("rejecting creates a tombstone and no synthesis observation — reviewProposal marks it rejected, appendToTerritory never called", async () => {
		const proposal = makeProposal();
		const candidate = makeCandidate();
		const storage = makeStorage(proposal, [candidate]);

		const result = await handleProposeTool("mind_propose", {
			action: "review",
			proposal_id: proposal.id,
			decision: "rejected"
		}, { storage: storage as any });

		expect(storage.reviewProposal).toHaveBeenCalledWith(proposal.id, "rejected", undefined);
		expect(storage.appendToTerritory).not.toHaveBeenCalled();
		expect(storage.reviewConsolidationCandidate).not.toHaveBeenCalled();
		expect(result.reviewed).toBe(true);
		expect(result.decision).toBe("rejected");
		expect(result.action_taken).toBe("rejected");
	});
});
