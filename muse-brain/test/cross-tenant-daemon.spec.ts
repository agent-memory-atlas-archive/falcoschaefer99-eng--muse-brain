import { describe, expect, it, vi } from "vitest";

import { runCrossTenantTask } from "../src/daemon/tasks/cross-tenant";

function obs(id: string, entityId: string) {
	return {
		observation: {
			id,
			content: `content ${id}`,
			territory: "craft",
			created: new Date().toISOString(),
			texture: { charge_phase: "active" },
			entity_id: entityId,
			access_count: 0
		},
		territory: "craft"
	};
}

/**
 * `storage` is the "companion" tenant; forTenant("rainer") returns the other side.
 * Only 'craft' carries observations so the pair scan runs exactly once.
 */
function makeStorage(currentObs: any[], otherObs: any[], overrides: Record<string, any> = {}) {
	const other = {
		queryObservations: vi.fn(async ({ territory }: any) => (territory === "craft" ? otherObs : [])),
		close: vi.fn(async () => undefined)
	};
	const storage: any = {
		getTenant: () => "companion",
		queryObservations: vi.fn(async ({ territory }: any) => (territory === "craft" ? currentObs : [])),
		forTenant: vi.fn(() => other),
		proposalExists: vi.fn(async () => false),
		batchProposalExists: vi.fn(async () => new Set<string>()),
		createProposal: vi.fn(async () => undefined),
		...overrides
	};
	return { storage, other };
}

describe("cross-tenant daemon task", () => {
	it("checks proposal existence once for the whole run", async () => {
		const { storage } = makeStorage(
			[obs("a1", "ent_1"), obs("a2", "ent_2")],
			[obs("b1", "ent_1"), obs("b2", "ent_2")]
		);

		const result = await runCrossTenantTask(storage);

		expect(storage.batchProposalExists).toHaveBeenCalledTimes(1);
		expect(storage.proposalExists).not.toHaveBeenCalled();
		// a1×b1 and a2×b2 share an entity; the cross pairs do not
		expect(result.proposals_created).toBe(2);
		expect(storage.createProposal).toHaveBeenCalledTimes(2);
	});

	it("uses the compiled tenant allowlist for legacy storage seams", async () => {
		const { storage } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_1")]);

		await runCrossTenantTask(storage);

		expect(storage.forTenant).toHaveBeenCalledWith("rainer");
	});

	it("allocates one storage handle per other tenant, not one per territory", async () => {
		const { storage } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_1")]);

		await runCrossTenantTask(storage);

		// two shared territories are scanned, but forTenant is hoisted above the loop
		expect(storage.forTenant).toHaveBeenCalledTimes(1);
		expect(storage.forTenant).toHaveBeenCalledWith("rainer");
	});

	it("caps proposals per run and says so out loud", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// 20 × 20 all sharing one entity = 400 candidate pairs
		const many = (prefix: string) => Array.from({ length: 20 }, (_, i) => obs(`${prefix}${i}`, "ent_shared"));
		const { storage } = makeStorage(many("a"), many("b"));

		const result = await runCrossTenantTask(storage);

		expect(result.proposals_created).toBe(50);
		expect(storage.createProposal).toHaveBeenCalledTimes(50);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("pair cap of 50 reached"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("350 candidate pairs deferred"));
		warn.mockRestore();
	});

	it("skips pairs the batch check reports as already proposed", async () => {
		const { storage } = makeStorage(
			[obs("a1", "ent_1"), obs("a2", "ent_2")],
			[obs("b1", "ent_1"), obs("b2", "ent_2")],
			{ batchProposalExists: vi.fn(async () => new Set(["cross_tenant:a1:b1"])) }
		);

		const result = await runCrossTenantTask(storage);

		expect(result.proposals_created).toBe(1);
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			source_id: "a2",
			target_id: "b2"
		}));
	});

	it("proposes nothing when no entity is shared", async () => {
		const { storage } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_9")]);

		const result = await runCrossTenantTask(storage);

		expect(result.proposals_created).toBe(0);
		expect(storage.batchProposalExists).not.toHaveBeenCalled();
		expect(storage.createProposal).not.toHaveBeenCalled();
	});


	it("closes the cloned tenant storage on early return", async () => {
		const { storage, other } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_9")]);

		const result = await runCrossTenantTask(storage);

		expect(result.proposals_created).toBe(0);
		expect(other.close).toHaveBeenCalledTimes(1);
	});

	it("closes the cloned tenant storage when the task throws", async () => {
		const { storage, other } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_1")]);
		storage.queryObservations.mockRejectedValueOnce(new Error("boom"));

		await expect(runCrossTenantTask(storage)).rejects.toThrow("boom");

		expect(other.close).toHaveBeenCalledTimes(1);
	});

	it("preserves the task error when cloned storage cleanup also fails", async () => {
		const { storage, other } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_1")]);
		const taskError = new Error("task failed");
		storage.queryObservations.mockRejectedValueOnce(taskError);
		other.close.mockRejectedValueOnce(new Error("cleanup failed"));

		await expect(runCrossTenantTask(storage)).rejects.toBe(taskError);

		expect(other.close).toHaveBeenCalledTimes(1);
	});

	it("never reads a private territory across tenants", async () => {
		const { storage, other } = makeStorage([obs("a1", "ent_1")], [obs("b1", "ent_1")]);

		await runCrossTenantTask(storage);

		// The current tenant is only ever scanned in the two shared territories...
		const ownReads = storage.queryObservations.mock.calls.map(([args]: any) => args.territory);
		expect(ownReads).toEqual(["craft", "philosophy"]);
		// ...and the other tenant is only ever asked for a subset of those.
		const otherReads = other.queryObservations.mock.calls.map(([args]: any) => args.territory);
		expect(otherReads.every((t: string) => ["craft", "philosophy"].includes(t))).toBe(true);
		expect(otherReads).toContain("craft");
	});
});
