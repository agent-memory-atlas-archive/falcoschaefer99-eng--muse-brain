// ops/ADR-JANITOR.md §1 — expireStaleProposals DELETEs regenerable proposal types
// instead of tombstoning them via UPDATE...status='rejected'. Real sqlite backend
// throughout: the bug this fixes IS the storage-layer status-blind unique index
// (idx_proposals_dedup) interacting with createProposal's ON CONFLICT DO NOTHING —
// a mock re-implementation would hide exactly the wiring this proves.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorage } from "../src/storage/factory";
import { EXPIRABLE_PROPOSAL_TYPES } from "../src/types";

function freshStorage() {
	const dbPath = `/tmp/muse-brain-test-proposal-expiry-${crypto.randomUUID()}.sqlite`;
	return createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
}

function daysAgo(d: number): Date {
	return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

function proposalPayload(overrides: Record<string, unknown> = {}) {
	return {
		tenant_id: "companion",
		proposal_type: "orphan_rescue" as const,
		source_id: "obs_a",
		target_id: "obs_b",
		confidence: 0.9,
		rationale: "test",
		metadata: {},
		status: "pending" as const,
		...overrides
	};
}

describe("expireStaleProposals — deletes, never re-tombstones", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("deletes a pending orphan_rescue proposal past the cutoff, and it CAN be re-proposed", async () => {
		const storage = freshStorage();

		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(40));
		await storage.createProposal(proposalPayload());
		vi.useRealTimers();

		expect(await storage.expireStaleProposals(30)).toBe(1);
		expect(await storage.listProposals("orphan_rescue", undefined, 50)).toHaveLength(0);

		// The exact bug this fixes: the status-blind unique index used to make this
		// createProposal a silent no-op that returned the old tombstoned row instead
		// of a fresh pending one. It must succeed cleanly now that the row is gone.
		const recreated = await storage.createProposal(proposalPayload({ rationale: "re-proposed", confidence: 0.85 }));
		expect(recreated.rationale).toBe("re-proposed");
		expect(recreated.status).toBe("pending");
	});

	it("deletes a pending link proposal past the cutoff (the other expirable type)", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(31));
		await storage.createProposal(proposalPayload({ proposal_type: "link", source_id: "obs_x", target_id: "obs_y" }));
		vi.useRealTimers();

		expect(await storage.expireStaleProposals(30)).toBe(1);
		expect(await storage.listProposals("link", undefined, 50)).toHaveLength(0);
	});

	it("leaves a pending proposal of an expirable type BEFORE the cutoff untouched", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(10));
		await storage.createProposal(proposalPayload({ source_id: "obs_fresh", target_id: "obs_fresh" }));
		vi.useRealTimers();

		expect(await storage.expireStaleProposals(30)).toBe(0);
		expect(await storage.listProposals("orphan_rescue", "pending", 50)).toHaveLength(1);
	});

	it("a pending consolidation proposal survives expiry untouched, however old", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(400));
		await storage.createProposal(proposalPayload({ proposal_type: "consolidation", source_id: "obs_c1", target_id: "obs_c2" }));
		vi.useRealTimers();

		expect(await storage.expireStaleProposals(30)).toBe(0);
		expect(await storage.listProposals("consolidation", "pending", 50)).toHaveLength(1);
	});

	it("writes the last_expiry breadcrumb with the deleted count and a by-type breakdown", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(40));
		await storage.createProposal(proposalPayload({ source_id: "a", target_id: "b" }));
		await storage.createProposal(proposalPayload({ proposal_type: "link", source_id: "c", target_id: "d" }));
		vi.useRealTimers();

		await storage.expireStaleProposals(30);

		const config = await storage.readDaemonConfig();
		expect(config.data.last_expiry).toMatchObject({ deleted: 2, by_type: { orphan_rescue: 1, link: 1 } });
		expect((config.data.last_expiry as { at: string }).at).toBeTruthy();
	});

	it("does not write a last_expiry breadcrumb when nothing expired", async () => {
		const storage = freshStorage();

		await storage.expireStaleProposals(30);

		const config = await storage.readDaemonConfig();
		expect(config.data.last_expiry).toBeUndefined();
	});
});

describe("expireStaleProposals — backfills the historical tombstone bug", () => {
	it("deletes a legacy tombstoned orphan_rescue row (status=rejected, never reviewed), freeing it to be re-proposed", async () => {
		const storage = freshStorage();
		// Simulates a row created by the PREVIOUS expireStaleProposals: rejected via a
		// raw UPDATE, never through reviewProposal() — reviewed_at was never set.
		await storage.createProposal(proposalPayload({
			source_id: "obs_legacy", target_id: "obs_legacy",
			status: "rejected", feedback_note: "Auto-expired: pending > 30 days",
			metadata: { action: "archive" }
		}));

		expect(await storage.expireStaleProposals(30)).toBe(1);

		const recreated = await storage.createProposal(proposalPayload({
			source_id: "obs_legacy", target_id: "obs_legacy",
			rationale: "re-proposed after backfill", metadata: { action: "archive" }
		}));
		expect(recreated.rationale).toBe("re-proposed after backfill");
	});

	it("does NOT delete a genuinely-reviewed rejected orphan_rescue row (reviewed_at present)", async () => {
		const storage = freshStorage();
		const created = await storage.createProposal(proposalPayload({ source_id: "obs_reviewed", target_id: "obs_reviewed" }));
		await storage.reviewProposal(created.id, "rejected", "Rook said no");

		expect(await storage.expireStaleProposals(30)).toBe(0);

		const stillThere = await storage.getProposalById(created.id);
		expect(stillThere?.status).toBe("rejected");
		expect(stillThere?.reviewed_at).toBeTruthy();
	});

	it("does NOT delete a legacy-shaped rejected row of a NON-expirable type, even with reviewed_at absent", async () => {
		const storage = freshStorage();
		await storage.createProposal(proposalPayload({
			proposal_type: "consolidation", source_id: "obs_e1", target_id: "obs_e2", status: "rejected"
		}));

		expect(await storage.expireStaleProposals(30)).toBe(0);
		expect(await storage.listProposals("consolidation", "rejected", 50)).toHaveLength(1);
	});

	it("EXPIRABLE_PROPOSAL_TYPES excludes salience_regrade — ops/ADR-JANITOR.md §1 non-negotiable: it must never expire and must never be deleted", () => {
		expect(EXPIRABLE_PROPOSAL_TYPES).toEqual(["link", "orphan_rescue"]);
		expect(EXPIRABLE_PROPOSAL_TYPES).not.toContain("salience_regrade");
	});

	it("EXPIRABLE_PROPOSAL_TYPES excludes paradox_detected — a tension does not time out", () => {
		expect(EXPIRABLE_PROPOSAL_TYPES).not.toContain("paradox_detected");
	});

	it("EXPIRABLE_PROPOSAL_TYPES excludes cross_agent and cross_tenant — both are queued for Rook's judgment, not a deadline", () => {
		expect(EXPIRABLE_PROPOSAL_TYPES).not.toContain("cross_agent");
		expect(EXPIRABLE_PROPOSAL_TYPES).not.toContain("cross_tenant");
	});

	it("does NOT delete a stale pending salience_regrade proposal — the anti-nag tombstone (§5.5) depends on it staying forever, pending or not", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(40));
		await storage.createProposal(proposalPayload({
			proposal_type: "salience_regrade", source_id: "obs_regrade", target_id: "obs_regrade",
			metadata: { action: "demote_to_active", shadow: true }
		}));
		vi.useRealTimers();

		expect(await storage.expireStaleProposals(30)).toBe(0);
		expect(await storage.listProposals("salience_regrade", "pending", 50)).toHaveLength(1);
	});
});

describe("getOldestPendingProposalDays — scoped to EXPIRABLE_PROPOSAL_TYPES (ops/ADR-JANITOR.md §2.1 instance eight)", () => {
	// A stale pending salience_regrade is expected and permanent (§5.5) — it must
	// never light §7's "approaching the 30-day auto-expiry" wake-time alarm, which
	// this query alone feeds. Unscoped, the very first salience_regrade proposal
	// to cross 21 days would light that alarm forever.
	it("ignores a 40-day pending salience_regrade and reports the 3-day pending link instead", async () => {
		const storage = freshStorage();

		// Anchor both offsets to the REAL wall clock before faking it — daysAgo()
		// reads Date.now() at call time, so a second daysAgo() call made while
		// already faked would compound off the first fake time, not real "now".
		const realNow = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(realNow - 40 * 24 * 60 * 60 * 1000));
		await storage.createProposal(proposalPayload({
			proposal_type: "salience_regrade", source_id: "obs_old_regrade", target_id: "obs_old_regrade",
			metadata: { action: "demote_to_active" }
		}));
		vi.setSystemTime(new Date(realNow - 3 * 24 * 60 * 60 * 1000));
		await storage.createProposal(proposalPayload({ proposal_type: "link", source_id: "obs_link_a", target_id: "obs_link_b" }));
		vi.useRealTimers();

		expect(await storage.getOldestPendingProposalDays!()).toBe(3);
	});

	it("returns null when only a non-expirable type is pending, however old", async () => {
		const storage = freshStorage();
		vi.useFakeTimers();
		vi.setSystemTime(daysAgo(400));
		await storage.createProposal(proposalPayload({
			proposal_type: "salience_regrade", source_id: "obs_only_regrade", target_id: "obs_only_regrade",
			metadata: { action: "demote_to_active" }
		}));
		vi.useRealTimers();

		expect(await storage.getOldestPendingProposalDays!()).toBeNull();
	});
});
