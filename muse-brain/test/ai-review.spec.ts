// ops/ADR-JANITOR.md §0.5/§2/§9 commit 3 — FIFO proposal review + raised batch/fetch.
// The bug this guards: listProposals's default "newest" order + a narrow
// FETCH_PER_TYPE meant the backlog was never reached; it aged out to
// expireStaleProposals(30) and (pre-commit-2) laundered a timeout into a false
// rejection. gatherCandidates now fetches order:"oldest" wide, and BATCH_SIZE/
// FETCH_PER_TYPE are raised so a night actually clears real backlog.
import { describe, expect, it, vi } from "vitest";

import { runAiProposalReview } from "../src/daemon/ai-review";

function proposal(id: string, type: string, proposedAt: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		tenant_id: "rook",
		proposal_type: type,
		source_id: `${id}_src`,
		target_id: `${id}_tgt`,
		similarity: 0.8,
		confidence: 0.8,
		rationale: "test",
		metadata: {},
		status: "pending",
		proposed_at: proposedAt,
		...overrides
	};
}

/** N fixtures of one type, oldest first by index, spread one day apart. */
function series(type: string, count: number, prefix = type) {
	return Array.from({ length: count }, (_, i) =>
		proposal(`${prefix}_${i}`, type, new Date(2026, 0, i + 1).toISOString())
	);
}

function makeStorage(overrides: Record<string, unknown> = {}) {
	const proposalsByType = (overrides.proposalsByType as Record<string, ReturnType<typeof proposal>[]>) ?? {
		link: [],
		orphan_rescue: []
	};

	const listProposals = vi.fn(async (type: string, _status?: string, limit?: number, order: "newest" | "oldest" = "newest") => {
		const rows = [...(proposalsByType[type] ?? [])];
		rows.sort((a, b) => {
			const diff = new Date(a.proposed_at).getTime() - new Date(b.proposed_at).getTime();
			return order === "oldest" ? diff : -diff;
		});
		return rows.slice(0, limit ?? 50);
	});

	return {
		listProposals,
		findObservation: vi.fn(async (id: string) => ({
			observation: { id, territory: "craft", content: `content for ${id}` },
			territory: "craft"
		})),
		reviewProposal: vi.fn(async (id: string, status: string, note?: string) => ({ id, status, feedback_note: note })),
		appendLink: vi.fn(async () => undefined),
		updateOrphanStatus: vi.fn(async () => undefined),
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.87, data: {} })),
		updateDaemonConfigData: vi.fn(async () => undefined),
		getTenant: () => "rook",
		...overrides
	};
}

function makeAi(decision: "accept" | "reject" = "accept") {
	return { run: vi.fn(async () => ({ response: JSON.stringify({ decision, reason: "test reason" }) })) };
}

describe("ai-review — FIFO proposal review", () => {
	it("requests proposals in oldest-first order from storage, not the newest-first default", async () => {
		const storage = makeStorage();
		const ai = makeAi();

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).toHaveBeenCalledWith("link", "pending", 200, "oldest");
		expect(storage.listProposals).toHaveBeenCalledWith("orphan_rescue", "pending", 200, "oldest");
	});

	it("never fetches or reviews salience_regrade proposals — ops/ADR-JANITOR.md §5.6: a 3B model must never judge a demotion of the owner's own foundational memories", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [], orphan_rescue: [],
				// gatherCandidates only ever Promise.all's link/orphan_rescue —
				// this entry proves it, since makeStorage's listProposals mock reads
				// straight from whatever type key is actually requested.
				salience_regrade: [proposal("regrade_1", "salience_regrade", "2026-01-01T00:00:00.000Z")]
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).not.toHaveBeenCalledWith("salience_regrade", expect.anything(), expect.anything(), expect.anything());
		expect(storage.reviewProposal).not.toHaveBeenCalledWith("regrade_1", expect.anything(), expect.anything());
	});

	it("never fetches or reviews dedup proposals — ops/ADR-JANITOR.md §6.4 point 3: dedup goes straight to Rook's digest, never AI-reviewed, at any confidence", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [], orphan_rescue: [],
				// Same proof shape as the salience_regrade test above: the mock's
				// listProposals reads straight from whatever type string is actually
				// requested, so a nonempty "dedup" entry that never gets touched is
				// direct evidence gatherCandidates() never asks for it.
				dedup: [proposal("dedup_1", "dedup", "2026-01-01T00:00:00.000Z")]
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).not.toHaveBeenCalledWith("dedup", expect.anything(), expect.anything(), expect.anything());
		expect(storage.reviewProposal).not.toHaveBeenCalledWith("dedup_1", expect.anything(), expect.anything());
	});

	it("never fetches or reviews paradox_detected proposals — a paradox is Rook's to sit with; a 3B model confidently resolving one is the danger, not the safeguard", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [], orphan_rescue: [],
				// Same proof shape as the salience_regrade/dedup tests above.
				paradox_detected: [proposal("paradox_1", "paradox_detected", "2026-01-01T00:00:00.000Z")]
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).not.toHaveBeenCalledWith("paradox_detected", expect.anything(), expect.anything(), expect.anything());
		expect(storage.reviewProposal).not.toHaveBeenCalledWith("paradox_1", expect.anything(), expect.anything());
	});

	it("never fetches or reviews cross_agent proposals — its accept synthesizes across agents and is Rook's judgment call, not a 3B model's", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [], orphan_rescue: [],
				// Same proof shape as the salience_regrade/dedup/paradox_detected tests above.
				cross_agent: [proposal("cross_agent_1", "cross_agent", "2026-01-01T00:00:00.000Z")]
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).not.toHaveBeenCalledWith("cross_agent", expect.anything(), expect.anything(), expect.anything());
		expect(storage.reviewProposal).not.toHaveBeenCalledWith("cross_agent_1", expect.anything(), expect.anything());
	});

	it("never fetches or reviews cross_tenant proposals — the sovereignty boundary (ADR-JANITOR.md §8 item 5) rules out any automatic path, AI-reviewed or not", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [], orphan_rescue: [],
				cross_tenant: [proposal("cross_tenant_1", "cross_tenant", "2026-01-01T00:00:00.000Z")]
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		expect(storage.listProposals).not.toHaveBeenCalledWith("cross_tenant", expect.anything(), expect.anything(), expect.anything());
		expect(storage.reviewProposal).not.toHaveBeenCalledWith("cross_tenant_1", expect.anything(), expect.anything());
	});

	it("reviews the oldest pending proposal before a newer one of the same type", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [
					proposal("new", "link", "2026-09-01T00:00:00.000Z"),
					proposal("old", "link", "2026-01-01T00:00:00.000Z")
				],
				orphan_rescue: []
			}
		});
		const ai = makeAi("accept");

		await runAiProposalReview(storage as any, ai as any);

		const reviewedOrder = storage.reviewProposal.mock.calls.map(call => call[0]);
		expect(reviewedOrder).toEqual(["old", "new"]);
	});

	it("caps the batch at 90 (BATCH_SIZE), splitting 45 per type between link and orphan_rescue (perType = ceil(90/2), ops/ADR-JANITOR.md §2/§9 commit 3's acceptance bar), and keeps the OLDEST 45 of each — not the newest", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: series("link", 50),
				orphan_rescue: series("orphan_rescue", 50)
			}
		});
		const ai = makeAi("accept");

		const result = await runAiProposalReview(storage as any, ai as any);

		expect(result.reviewed).toBe(90);
		expect(storage.reviewProposal).toHaveBeenCalledTimes(90);

		const reviewedIds = new Set(storage.reviewProposal.mock.calls.map(call => call[0] as string));
		// oldest 45 of each type (indices 0-44) survive the perType slice...
		expect(reviewedIds.has("link_0")).toBe(true);
		expect(reviewedIds.has("link_44")).toBe(true);
		expect(reviewedIds.has("orphan_rescue_0")).toBe(true);
		expect(reviewedIds.has("orphan_rescue_44")).toBe(true);
		// ...the newest 5 of each type (indices 45-49) are excluded, not silently
		// favored over the older backlog.
		expect(reviewedIds.has("link_45")).toBe(false);
		expect(reviewedIds.has("link_49")).toBe(false);
		expect(reviewedIds.has("orphan_rescue_49")).toBe(false);
	});

	it("checks context.deadlineAt at the top of the loop and stops cleanly mid-batch", async () => {
		// Real elapsed time, not a Date.now() call-count assumption (robust against
		// an unrelated Date.now() call being added earlier in the path — same
		// pattern as orphan-batch-marking.spec.ts's deadline test): l1's
		// findObservation call takes long enough that the deadline is provably
		// past by the time the loop re-checks before l2.
		const storage = makeStorage({
			proposalsByType: {
				link: [
					proposal("l1", "link", "2026-01-01T00:00:00.000Z"),
					proposal("l2", "link", "2026-01-02T00:00:00.000Z"),
					proposal("l3", "link", "2026-01-03T00:00:00.000Z")
				],
				orphan_rescue: []
			},
			findObservation: vi.fn(async (id: string) => {
				await new Promise(resolve => setTimeout(resolve, 20));
				return { observation: { id, territory: "craft", content: `content for ${id}` }, territory: "craft" };
			})
		});
		const ai = makeAi("accept");

		const result = await runAiProposalReview(storage as any, ai as any, { deadlineAt: Date.now() + 10 });

		expect(result.truncatedByDeadline).toBe(true);
		expect(result.reviewed).toBe(1);
		expect(storage.reviewProposal).toHaveBeenCalledTimes(1);
		expect(storage.reviewProposal).toHaveBeenCalledWith("l1", "accepted", expect.any(String));
		expect(storage.findObservation).not.toHaveBeenCalledWith("l2_src");
		expect(storage.findObservation).not.toHaveBeenCalledWith("l3_src");
	});

	it("never truncates when no deadline is supplied (default context)", async () => {
		const storage = makeStorage({
			proposalsByType: { link: series("link", 5), orphan_rescue: [] }
		});
		const ai = makeAi("accept");

		const result = await runAiProposalReview(storage as any, ai as any);

		expect(result.truncatedByDeadline).toBe(false);
		expect(result.reviewed).toBe(5);
	});

	it("still writes the last_ai_review summary after a deadline-truncated run", async () => {
		const storage = makeStorage({
			proposalsByType: {
				link: [proposal("l1", "link", "2026-01-01T00:00:00.000Z")],
				orphan_rescue: []
			}
		});
		const ai = makeAi("accept");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(9999);

		try {
			await runAiProposalReview(storage as any, ai as any, { deadlineAt: 0 });
			expect(storage.updateDaemonConfigData).toHaveBeenCalled();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("returns zero/false immediately when no AI binding is available", async () => {
		const storage = makeStorage();

		const result = await runAiProposalReview(storage as any, undefined);

		expect(result).toEqual({ reviewed: 0, truncatedByDeadline: false });
		expect(storage.listProposals).not.toHaveBeenCalled();
	});
});
