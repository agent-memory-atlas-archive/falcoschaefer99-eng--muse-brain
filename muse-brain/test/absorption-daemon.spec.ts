import { describe, expect, it, vi } from "vitest";
import { runAbsorptionTask } from "../src/daemon/tasks/absorption";

function makeStorage(overrides: Record<string, any> = {}) {
	return {
		listProposals: vi.fn(async () => []),
		reviewProposal: vi.fn(async (id: string, status: string, note?: string) => ({ id, status, feedback_note: note })),
		appendLink: vi.fn(async () => undefined),
		updateOrphanStatus: vi.fn(async () => undefined),
		updateObservationTexture: vi.fn(async () => undefined),
		findObservation: vi.fn(async () => null),
		getTenant: () => "rook",
		...overrides
	};
}

describe("daemon absorption task", () => {
	it("auto-accepts a link proposal at/above the 0.92 threshold", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_link_1",
				tenant_id: "rook",
				proposal_type: "link",
				source_id: "obs_a",
				target_id: "obs_b",
				confidence: 0.95,
				resonance_type: "semantic",
				metadata: {},
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.task).toBe("absorption");
		expect(result.changes).toBe(1);
		expect(result.proposals_created).toBe(0);
		expect(storage.appendLink).toHaveBeenCalledTimes(2);
		expect(storage.reviewProposal).toHaveBeenCalledWith("prop_link_1", "accepted", "auto-absorbed");
	});

	it("leaves a link proposal below the 0.92 threshold pending", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_link_2",
				tenant_id: "rook",
				proposal_type: "link",
				source_id: "obs_a",
				target_id: "obs_b",
				confidence: 0.91,
				metadata: {},
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(0);
		expect(storage.appendLink).not.toHaveBeenCalled();
		expect(storage.reviewProposal).not.toHaveBeenCalled();
	});

	it("auto-rescues an orphan_rescue proposal at/above the 0.90 threshold", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_orphan_1",
				tenant_id: "rook",
				proposal_type: "orphan_rescue",
				source_id: "obs_orphan",
				target_id: "obs_rescuer",
				confidence: 0.9,
				metadata: {},
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(1);
		expect(storage.appendLink).toHaveBeenCalledTimes(2);
		expect(storage.updateOrphanStatus).toHaveBeenCalledWith("obs_orphan", "rescued");
		expect(storage.reviewProposal).toHaveBeenCalledWith("prop_orphan_1", "accepted", "auto-absorbed");
	});

	it("leaves an orphan_rescue proposal below the 0.90 threshold pending", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_orphan_2",
				tenant_id: "rook",
				proposal_type: "orphan_rescue",
				source_id: "obs_orphan",
				target_id: "obs_rescuer",
				confidence: 0.85,
				metadata: {},
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(0);
		expect(storage.updateOrphanStatus).not.toHaveBeenCalled();
		expect(storage.reviewProposal).not.toHaveBeenCalled();
	});

	it("auto-archives an orphan_rescue archive proposal regardless of confidence", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_orphan_archive",
				tenant_id: "rook",
				proposal_type: "orphan_rescue",
				source_id: "obs_dead",
				target_id: "obs_dead",
				confidence: 0.5,
				metadata: { action: "archive" },
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}]),
			findObservation: vi.fn(async () => ({
				observation: { id: "obs_dead", texture: { salience: "dormant", charge_phase: "fresh" } },
				territory: "personal"
			}))
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(1);
		expect(storage.appendLink).not.toHaveBeenCalled();
		expect(storage.updateObservationTexture).toHaveBeenCalledWith(
			"obs_dead",
			expect.objectContaining({ charge_phase: "metabolized" })
		);
		expect(storage.updateOrphanStatus).toHaveBeenCalledWith("obs_dead", "archived");
		expect(storage.reviewProposal).toHaveBeenCalledWith("prop_orphan_archive", "accepted", "auto-absorbed");
	});

	it("processes up to 200 pending proposals per run (ops/ADR-JANITOR.md §2/§9 commit 4 — MAX_ABSORB_PER_RUN, must be >= RESCUE_LIMIT's backlog value)", async () => {
		const proposals = Array.from({ length: 200 }, (_, i) => ({
			id: `prop_link_${i}`,
			tenant_id: "rook",
			proposal_type: "link",
			source_id: `obs_a_${i}`,
			target_id: `obs_b_${i}`,
			confidence: 0.95,
			metadata: {},
			status: "pending",
			proposed_at: "2026-07-01T00:00:00.000Z"
		}));
		const storage = makeStorage({ listProposals: vi.fn(async () => proposals) });

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(200);
		expect(storage.reviewProposal).toHaveBeenCalledTimes(200);
	});

	it("leaves other proposal types (e.g. skill_promotion) pending for human/companion review", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_skill_1",
				tenant_id: "rook",
				proposal_type: "skill_promotion",
				source_id: "obs_a",
				target_id: "obs_b",
				confidence: 0.99,
				metadata: {},
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(0);
		expect(storage.reviewProposal).not.toHaveBeenCalled();
	});

	it("never auto-absorbs a salience_regrade proposal, at ANY confidence — ops/ADR-JANITOR.md §5.6/§8: no automatic accept path exists for this type, ever", async () => {
		const storage = makeStorage({
			listProposals: vi.fn(async () => [{
				id: "prop_regrade_1",
				tenant_id: "rook",
				proposal_type: "salience_regrade",
				source_id: "obs_foundational",
				target_id: "obs_foundational",
				confidence: 1.0,
				metadata: { action: "demote_to_active", shadow: false },
				status: "pending",
				proposed_at: "2026-07-01T00:00:00.000Z"
			}])
		});

		const result = await runAbsorptionTask(storage as any);

		expect(result.changes).toBe(0);
		expect(storage.updateObservationTexture).not.toHaveBeenCalled();
		expect(storage.reviewProposal).not.toHaveBeenCalled();
	});
});
