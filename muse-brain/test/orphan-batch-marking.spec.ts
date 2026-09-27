import { describe, expect, it, vi } from "vitest";

import { createStorage } from "../src/storage/factory";
import {
	runOrphanTask,
	DETECT_LIMIT_STEADY,
	DETECT_LIMIT_BACKLOG,
	RESCUE_LIMIT_STEADY,
	RESCUE_LIMIT_BACKLOG,
	SLOTS_PER_ORPHAN_STEADY,
	SLOTS_PER_ORPHAN_BACKLOG
} from "../src/daemon/tasks/orphans";
import { proposalKey } from "../src/storage/keys";

function candidate(id: string, chargePhase = "processing") {
	return {
		id,
		content: `orphan candidate ${id}`,
		territory: "craft",
		created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
		texture: { charge_phase: chargePhase },
		access_count: 0
	};
}

function makeStorage(overrides: Record<string, any> = {}) {
	return {
		listOrphans: vi.fn(async () => []),
		findOrphanCandidates: vi.fn(async () => []),
		markOrphan: vi.fn(async () => undefined),
		markOrphans: vi.fn(async (ids: string[]) => ids.length),
		findSimilarUnlinked: vi.fn(async () => []),
		proposalExists: vi.fn(async () => false),
		batchProposalExists: vi.fn(async () => new Set<string>()),
		createProposal: vi.fn(async () => undefined),
		incrementRescueAttempt: vi.fn(async () => undefined),
		incrementRescueAttempts: vi.fn(async (ids: string[]) => ids.length),
		getTenant: () => "rook",
		...overrides
	};
}

function orphan(id: string, rescue_attempts = 0) {
	return {
		observation_id: id,
		tenant_id: "rook",
		first_marked: "2026-07-01T00:00:00.000Z",
		rescue_attempts,
		status: "orphaned"
	};
}

function similarHit(targetId: string, similarity: number) {
	return [{ observation: { id: targetId }, territory: "craft", similarity }];
}

describe("markOrphans batch semantics (sqlite backend)", () => {
	it("inserts each id once and reports the rows actually inserted", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		const inserted = await storage.markOrphans(["obs_a", "obs_b", "obs_c"]);
		expect(inserted).toBe(3);

		const orphans = await storage.listOrphans("orphaned", 50);
		expect(orphans.map(o => o.observation_id).sort()).toEqual(["obs_a", "obs_b", "obs_c"]);
		expect(orphans.every(o => o.rescue_attempts === 0 && o.status === "orphaned")).toBe(true);
	});

	it("skips ids already marked — ON CONFLICT DO NOTHING semantics", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.markOrphans(["obs_a", "obs_b"]);
		const inserted = await storage.markOrphans(["obs_b", "obs_c"]);

		expect(inserted).toBe(1);
		const orphans = await storage.listOrphans(undefined, 50);
		expect(orphans).toHaveLength(3);
	});

	it("dedupes ids inside a single batch", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		const inserted = await storage.markOrphans(["obs_dup", "obs_dup", "obs_dup"]);

		expect(inserted).toBe(1);
		expect(await storage.listOrphans(undefined, 50)).toHaveLength(1);
	});

	it("leaves an already-marked orphan's first_marked untouched", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.markOrphans(["obs_a"]);
		const before = (await storage.listOrphans(undefined, 50))[0].first_marked;

		await storage.markOrphans(["obs_a"]);
		const after = (await storage.listOrphans(undefined, 50))[0].first_marked;

		expect(after).toBe(before);
	});

	it("is a no-op on an empty batch", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		expect(await storage.markOrphans([])).toBe(0);
		expect(await storage.listOrphans(undefined, 50)).toHaveLength(0);
	});

	it("lists oldest-marked first among never-attempted orphans (first_marked ASC tiebreak)", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.markOrphans(["obs_oldest"]);
		await new Promise(resolve => setTimeout(resolve, 5));
		await storage.markOrphans(["obs_newest"]);

		// Neither has ever been attempted (last_rescue_attempt is null for both), so
		// the primary key (last_rescue_attempt ASC NULLS FIRST) ties and the sort
		// falls to the first_marked ASC tiebreak — this sort decides who gets worked.
		expect((await storage.listOrphans("orphaned", 50)).map(o => o.observation_id))
			.toEqual(["obs_oldest", "obs_newest"]);
	});

	it("ranks a never-attempted orphan ahead of one attempted long ago (ops/ADR-JANITOR.md §1 fairness)", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		// obs_stale was marked first (oldest by first_marked) AND already attempted —
		// under the OLD first_marked-only order it would always be worked first,
		// forever, even after every other orphan has had a turn.
		await storage.markOrphans(["obs_stale"]);
		await storage.incrementRescueAttempts(["obs_stale"]);
		await new Promise(resolve => setTimeout(resolve, 5));
		await storage.markOrphans(["obs_never_tried"]);

		const order = (await storage.listOrphans("orphaned", 50)).map(o => o.observation_id);
		expect(order).toEqual(["obs_never_tried", "obs_stale"]);
	});

	it("ranks the LEAST-recently-attempted of two previously-attempted orphans first", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.markOrphans(["obs_attempted_recently", "obs_attempted_long_ago"]);
		await storage.incrementRescueAttempts(["obs_attempted_long_ago"]);
		await new Promise(resolve => setTimeout(resolve, 5));
		await storage.incrementRescueAttempts(["obs_attempted_recently"]);

		const order = (await storage.listOrphans("orphaned", 50)).map(o => o.observation_id);
		expect(order).toEqual(["obs_attempted_long_ago", "obs_attempted_recently"]);
	});
});

describe("orphan task phase 1 batching", () => {
	it("marks all eligible candidates in a single storage call", async () => {
		const storage = makeStorage({
			findOrphanCandidates: vi.fn(async () => [candidate("obs_1"), candidate("obs_2"), candidate("obs_3")])
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.markOrphans).toHaveBeenCalledTimes(1);
		expect(storage.markOrphans).toHaveBeenCalledWith(["obs_1", "obs_2", "obs_3"]);
		expect(storage.markOrphan).not.toHaveBeenCalled();
		expect(result.changes).toBe(3);
	});

	it("excludes metabolized candidates from the batch", async () => {
		const storage = makeStorage({
			findOrphanCandidates: vi.fn(async () => [
				candidate("obs_1"),
				candidate("obs_metabolized", "metabolized"),
				candidate("obs_2")
			])
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.markOrphans).toHaveBeenCalledWith(["obs_1", "obs_2"]);
		expect(result.changes).toBe(2);
	});

	it("counts only rows actually inserted, not candidates seen", async () => {
		const storage = makeStorage({
			findOrphanCandidates: vi.fn(async () => [candidate("obs_1"), candidate("obs_2")]),
			// both already marked on a previous night
			markOrphans: vi.fn(async () => 0)
		});

		const result = await runOrphanTask(storage as any);

		expect(result.changes).toBe(0);
	});

	it("caps detection at DETECT_LIMIT_STEADY (6) candidates per night in steady mode (ops/ADR-JANITOR.md §2.1 — derived from RESCUE_LIMIT_STEADY/(SLOTS_PER_ORPHAN_STEADY*2))", async () => {
		const storage = makeStorage();

		await runOrphanTask(storage as any);

		expect(storage.findOrphanCandidates).toHaveBeenCalledWith(expect.any(String), 6);
		// listOrphans is called exactly once — the dead 5000-row guard is gone
		expect(storage.listOrphans).toHaveBeenCalledTimes(1);
		expect(storage.listOrphans).toHaveBeenCalledWith("orphaned", 50);
	});
});

describe("orphan task phase 2 batching", () => {
	it("checks proposal existence once for the whole cycle", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1"), orphan("obs_2"), orphan("obs_done", 3)]),
			findSimilarUnlinked: vi.fn(async (sourceId: string) => similarHit(`near_${sourceId}`, 0.8))
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.batchProposalExists).toHaveBeenCalledTimes(1);
		expect(storage.proposalExists).not.toHaveBeenCalled();
		expect(storage.batchProposalExists).toHaveBeenCalledWith([
			{ type: "orphan_rescue", sourceId: "obs_done", targetId: "obs_done" },
			{ type: "orphan_rescue", sourceId: "obs_1", targetId: "near_obs_1" },
			{ type: "orphan_rescue", sourceId: "obs_2", targetId: "near_obs_2" }
		]);
		// two rescue proposals + one archival proposal
		expect(result.proposals_created).toBe(3);
	});

	it("increments attempts once for all rescuable orphans", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1"), orphan("obs_2"), orphan("obs_done", 3)]),
			findSimilarUnlinked: vi.fn(async (sourceId: string) => similarHit(`near_${sourceId}`, 0.8))
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.incrementRescueAttempts).toHaveBeenCalledTimes(1);
		// the exhausted orphan is NOT incremented — matches the original early-continue
		expect(storage.incrementRescueAttempts).toHaveBeenCalledWith(["obs_1", "obs_2"]);
		expect(storage.incrementRescueAttempt).not.toHaveBeenCalled();
		expect(result.changes).toBe(2);
	});

	it("still counts an attempt when no similar observation is found", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1")]),
			findSimilarUnlinked: vi.fn(async () => [])
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(storage.incrementRescueAttempts).toHaveBeenCalledWith(["obs_1"]);
		expect(result.changes).toBe(1);
	});

	it("skips proposals the batch check reports as already existing", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1"), orphan("obs_2"), orphan("obs_done", 3)]),
			findSimilarUnlinked: vi.fn(async (sourceId: string) => similarHit(`near_${sourceId}`, 0.8)),
			batchProposalExists: vi.fn(async () => new Set([
				"orphan_rescue:obs_1:near_obs_1",
				"orphan_rescue:obs_done:obs_done"
			]))
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.createProposal).toHaveBeenCalledTimes(1);
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			source_id: "obs_2",
			target_id: "near_obs_2"
		}));
		expect(result.proposals_created).toBe(1);
		// attempts still increment for both rescuable orphans
		expect(storage.incrementRescueAttempts).toHaveBeenCalledWith(["obs_1", "obs_2"]);
	});

	it("proposes archival for exhausted orphans with the original payload", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_done", 3)])
		});

		await runOrphanTask(storage as any);

		expect(storage.findSimilarUnlinked).not.toHaveBeenCalled();
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			proposal_type: "orphan_rescue",
			source_id: "obs_done",
			target_id: "obs_done",
			confidence: 0.9,
			metadata: { action: "archive" },
			status: "pending"
		}));
	});
});

describe("orphan task failure isolation", () => {
	it("still runs phase 2 when the phase 1 batch write throws", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const storage = makeStorage({
			findOrphanCandidates: vi.fn(async () => [candidate("obs_1")]),
			markOrphans: vi.fn(async () => { throw new Error("deadlock detected"); }),
			listOrphans: vi.fn(async () => [orphan("obs_old", 3)])
		});

		const result = await runOrphanTask(storage as any);

		// detection lost this night, rescue did not
		expect(result.changes).toBe(0);
		expect(result.proposals_created).toBe(1);
		expect(storage.createProposal).toHaveBeenCalledWith(expect.objectContaining({
			metadata: { action: "archive" }
		}));
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe("orphan task change accounting", () => {
	it("counts only the rescue rows actually written, not the ids passed", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1"), orphan("obs_2"), orphan("obs_gone")]),
			findSimilarUnlinked: vi.fn(async () => []),
			// obs_gone was deleted between the list and the update
			incrementRescueAttempts: vi.fn(async () => 2)
		});

		const result = await runOrphanTask(storage as any);

		expect(storage.incrementRescueAttempts).toHaveBeenCalledWith(["obs_1", "obs_2", "obs_gone"]);
		expect(result.changes).toBe(2);
	});

	it("sums phase 1 and phase 2 changes within one run", async () => {
		const storage = makeStorage({
			findOrphanCandidates: vi.fn(async () => [candidate("obs_new_1"), candidate("obs_new_2")]),
			markOrphans: vi.fn(async () => 2),
			listOrphans: vi.fn(async () => [orphan("obs_old_1"), orphan("obs_old_2"), orphan("obs_old_3")]),
			findSimilarUnlinked: vi.fn(async () => []),
			incrementRescueAttempts: vi.fn(async (ids: string[]) => ids.length)
		});

		const result = await runOrphanTask(storage as any);

		// 2 newly marked + 3 rescue attempts recorded
		expect(result.changes).toBe(5);
	});
});

describe("batchProposalExists against real sqlite storage", () => {
	it("emits keys in the format callers look up", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.createProposal({
			tenant_id: "companion",
			proposal_type: "orphan_rescue",
			source_id: "obs_a",
			target_id: "obs_b",
			confidence: 0.9,
			rationale: "test",
			metadata: {},
			status: "pending"
		});

		const found = await storage.batchProposalExists([
			{ type: "orphan_rescue", sourceId: "obs_a", targetId: "obs_b" },
			{ type: "orphan_rescue", sourceId: "obs_a", targetId: "obs_missing" }
		]);

		// The producer's REAL output, not a hand-written expectation: this is the
		// assertion that would have caught the `::` separator bug.
		expect([...found]).toEqual(["orphan_rescue:obs_a:obs_b"]);
		expect(found.has(proposalKey("orphan_rescue", "obs_a", "obs_b"))).toBe(true);
	});

	it("ignores proposals that are no longer pending", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		const created = await storage.createProposal({
			tenant_id: "companion",
			proposal_type: "orphan_rescue",
			source_id: "obs_a",
			target_id: "obs_b",
			confidence: 0.9,
			rationale: "test",
			metadata: {},
			status: "pending"
		});
		await storage.reviewProposal(created.id, "rejected", "not now");

		const found = await storage.batchProposalExists([
			{ type: "orphan_rescue", sourceId: "obs_a", targetId: "obs_b" }
		]);

		// A rejected proposal means "not now", never "never again" — it must not
		// suppress its own regeneration.
		expect([...found]).toEqual([]);
	});
});

describe("orphan task full loop against real sqlite storage", () => {
	it("proposes archival for an exhausted orphan exactly once across two nights", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		await storage.markOrphans(["obs_exhausted"]);
		for (let i = 0; i < 3; i++) await storage.incrementRescueAttempts(["obs_exhausted"]);

		const night1 = await runOrphanTask(storage);
		const night2 = await runOrphanTask(storage);

		expect(night1.proposals_created).toBe(1);
		// The dedupe check goes through the REAL batchProposalExists — a producer /
		// consumer key mismatch shows up here as a second proposal row.
		expect(night2.proposals_created).toBe(0);

		const proposals = await storage.listProposals("orphan_rescue", "pending", 50);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			source_id: "obs_exhausted",
			target_id: "obs_exhausted",
			metadata: { action: "archive" }
		});
	});
});

describe("ops/ADR-JANITOR.md §2.1 commit 5 — backlog mode caps", () => {
	it("uses the steady caps by default (context.backlogMode absent)", async () => {
		const storage = makeStorage();

		await runOrphanTask(storage as any, {});

		expect(storage.listOrphans).toHaveBeenCalledWith("orphaned", RESCUE_LIMIT_STEADY);
		expect(storage.findOrphanCandidates).toHaveBeenCalledWith(expect.any(String), DETECT_LIMIT_STEADY);
	});

	it("raises RESCUE_LIMIT to 200 when context.backlogMode is true; detection is skipped entirely (DETECT_LIMIT_BACKLOG = 0, §2.1 Finding 1 — a drain does not look for new work)", async () => {
		const storage = makeStorage();

		await runOrphanTask(storage as any, { backlogMode: true });

		expect(storage.listOrphans).toHaveBeenCalledWith("orphaned", RESCUE_LIMIT_BACKLOG);
		expect(storage.findOrphanCandidates).not.toHaveBeenCalled();
	});

	it("treats 1 prior attempt as exhausted (archive) under backlog mode but still rescuable under steady mode", async () => {
		const steady = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1", 1)]),
			findSimilarUnlinked: vi.fn(async (sourceId: string) => similarHit(`near_${sourceId}`, 0.8))
		});
		await runOrphanTask(steady as any, {});
		expect(steady.findSimilarUnlinked).toHaveBeenCalled();
		expect(steady.createProposal).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));

		const backlog = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1", 1)]),
			findSimilarUnlinked: vi.fn(async (sourceId: string) => similarHit(`near_${sourceId}`, 0.8))
		});
		await runOrphanTask(backlog as any, { backlogMode: true });
		expect(backlog.findSimilarUnlinked).not.toHaveBeenCalled();
		expect(backlog.createProposal).toHaveBeenCalledWith(expect.objectContaining({ metadata: { action: "archive" } }));
	});

	it("asserts DETECT_LIMIT × SLOTS_PER_ORPHAN < RESCUE_LIMIT in both modes — the burn-down is net-negative by construction (ops/ADR-JANITOR.md §2.1 Finding 1: one orphan's life costs A+1 window slots, not 1)", () => {
		expect(DETECT_LIMIT_STEADY * SLOTS_PER_ORPHAN_STEADY).toBeLessThan(RESCUE_LIMIT_STEADY);
		expect(DETECT_LIMIT_BACKLOG * SLOTS_PER_ORPHAN_BACKLOG).toBeLessThan(RESCUE_LIMIT_BACKLOG);
	});

	it("checks context.deadlineAt at the top of the rescue loop and stops before an orphan whose search never ran gets its attempt incremented", async () => {
		// Real elapsed time, not a Date.now() call-count assumption (robust against
		// an unrelated Date.now() call being added/removed elsewhere in the
		// function, e.g. the cutoffDate computation in Phase 1): obs_1's vector
		// search takes long enough that the deadline is provably past by the time
		// the loop re-checks before obs_2.
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1"), orphan("obs_2"), orphan("obs_3")]),
			findSimilarUnlinked: vi.fn(async () => {
				await new Promise(resolve => setTimeout(resolve, 20));
				return [];
			})
		});

		const result = await runOrphanTask(storage as any, { deadlineAt: Date.now() + 10 });

		expect(result.truncated_by_deadline).toBe(true);
		expect(storage.findSimilarUnlinked).toHaveBeenCalledTimes(1);
		expect(storage.findSimilarUnlinked).toHaveBeenCalledWith("obs_1", 3);
		expect(storage.incrementRescueAttempts).toHaveBeenCalledWith(["obs_1"]);
	});

	it("omits truncated_by_deadline from the result on a normal, non-truncated run", async () => {
		const storage = makeStorage({
			listOrphans: vi.fn(async () => [orphan("obs_1")]),
			findSimilarUnlinked: vi.fn(async () => [])
		});

		const result = await runOrphanTask(storage as any, {});

		expect(result).not.toHaveProperty("truncated_by_deadline");
	});
});

describe("incrementRescueAttempts (sqlite backend)", () => {
	it("increments every listed orphan in one call and reports the count", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		await storage.markOrphans(["obs_a", "obs_b", "obs_c"]);

		const updated = await storage.incrementRescueAttempts(["obs_a", "obs_b"]);

		expect(updated).toBe(2);
		const byId = new Map((await storage.listOrphans(undefined, 50)).map(o => [o.observation_id, o]));
		expect(byId.get("obs_a")!.rescue_attempts).toBe(1);
		expect(byId.get("obs_b")!.rescue_attempts).toBe(1);
		expect(byId.get("obs_c")!.rescue_attempts).toBe(0);
		expect(byId.get("obs_a")!.last_rescue_attempt).toBeTruthy();
	});

	it("accumulates across cycles and ignores unknown ids", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		await storage.markOrphans(["obs_a"]);

		await storage.incrementRescueAttempts(["obs_a"]);
		const updated = await storage.incrementRescueAttempts(["obs_a", "obs_ghost"]);

		expect(updated).toBe(1);
		expect((await storage.listOrphans(undefined, 50))[0].rescue_attempts).toBe(2);
	});

	it("is a no-op on an empty batch", async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		expect(await storage.incrementRescueAttempts([])).toBe(0);
	});
});
