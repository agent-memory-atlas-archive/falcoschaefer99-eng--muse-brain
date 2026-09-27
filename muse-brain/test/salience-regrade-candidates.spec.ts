// ops/ADR-JANITOR.md §5.2 — the salience_regrade protection list, tested case by
// case against the REAL sqlite backend (not a mock) per §9's acceptance
// criterion. Real backend throughout: the bug class this list guards against
// (§0.2's foundational-exclusion freeze, §5.5's anti-nag tombstone) lives in
// actual storage-layer joins a mock re-implementation would hide.
import { describe, expect, it } from "vitest";
import { createStorage } from "../src/storage/factory";
import type { Anchor, ConsolidationCandidate, DaemonProposal, Link, Observation } from "../src/types";

function freshStorage() {
	const dbPath = `/tmp/muse-brain-test-salience-regrade-${crypto.randomUUID()}.sqlite`;
	return createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Same cutoffs runSalienceRegradeTask computes — MIN_AGE_DAYS=90, SURFACED_STALE_DAYS=60. */
const MIN_AGE_CUTOFF = daysAgo(90);
const SURFACED_CUTOFF = daysAgo(60);
const FETCH_CAP = 800;

/** A foundational observation that satisfies every clause on its own — the control. */
function cleanCandidate(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `foundational memory ${id}`,
		territory: "craft",
		created: daysAgo(200),
		texture: {
			salience: "foundational",
			vividness: "vivid",
			charge: ["pride"],
			grip: "iron",
			charge_phase: "processing"
		},
		access_count: 0,
		...overrides
	};
}

async function findCandidateIds(storage: ReturnType<typeof createStorage>): Promise<string[]> {
	const rows = await storage.findSalienceRegradeCandidates!(MIN_AGE_CUTOFF, SURFACED_CUTOFF, FETCH_CAP);
	return rows.map(r => r.id);
}

describe("findSalienceRegradeCandidates — protection list, case by case (sqlite)", () => {
	it("surfaces a clean foundational observation that violates no protection clause", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_clean"));

		expect(await findCandidateIds(storage)).toEqual(["obs_clean"]);
	});

	it("excludes salience != 'foundational'", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_active", {
			texture: { salience: "active", vividness: "vivid", charge: [], grip: "iron", charge_phase: "processing" }
		}));

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes territory = 'self' (§5.2 clause 2 — the identity spine)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("self", cleanCandidate("obs_self", { territory: "self" }));

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes access_count > 1", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_accessed", { access_count: 2 }));

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes created_at within the last 90 days (§5.2 clause 5 — too new to judge)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_recent", { created: daysAgo(10) }));

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes charge_phase = 'metabolized' (§2.1 clause 8 — already declared inert by the Janitor)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_metabolized", {
			texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "iron", charge_phase: "metabolized" }
		}));

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes last_surfaced_at within the last 60 days, but null/absent passes", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_surfaced_recent"));
		// updateSurfacingEffects writes last_surfaced_at as a top-level field, NOT
		// inside texture (ops/ADR-JANITOR.md §5.2 is imprecise on this point for
		// Postgres — see storage/interface.ts's doc comment on this method).
		await storage.updateSurfacingEffects(["obs_surfaced_recent"]);

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes an anchor's triggers_memory_id target (§5.2 clause 1 — structural reference)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_anchored"));
		const anchor: Anchor = {
			id: "anchor_1",
			type: "lexical",
			anchor_type: "callback",
			content: "anchor content",
			charge: [],
			triggers_memory_id: "obs_anchored",
			created: daysAgo(200),
			activation_count: 0
		};
		await storage.writeAnchors([anchor]);

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes an observation with a prior salience_regrade proposal in ANY status — including rejected (§5.5's anti-nag tombstone)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_already_asked"));
		const created = await storage.createProposal({
			tenant_id: "companion",
			proposal_type: "salience_regrade",
			source_id: "obs_already_asked",
			target_id: "obs_already_asked",
			confidence: 0.5,
			rationale: "prior ask",
			metadata: { action: "demote_to_active", shadow: true },
			status: "pending"
		});
		await storage.reviewProposal(created.id, "rejected", "not this one");

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes a source of an ACCEPTED consolidation (§5.2 clause 4)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_consolidated"));
		const candidate: Omit<ConsolidationCandidate, "id" | "tenant_id" | "created_at" | "reviewed_at"> = {
			source_observation_ids: ["obs_consolidated", "obs_other"],
			pattern_description: "test pattern",
			suggested_type: "skill",
			status: "pending"
		};
		const created = await storage.createConsolidationCandidate(candidate);
		await storage.reviewConsolidationCandidate(created.id, "accepted");

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("does NOT exclude a source of a still-PENDING consolidation — only accepted ones protect", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_pending_consolidation"));
		await storage.createConsolidationCandidate({
			source_observation_ids: ["obs_pending_consolidation"],
			pattern_description: "test pattern",
			suggested_type: "skill",
			status: "pending"
		});

		expect(await findCandidateIds(storage)).toEqual(["obs_pending_consolidation"]);
	});

	it("excludes an id present in a captured skill artifact's metabolized_observation_ids (§5.2 clause 4)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_skill_metabolized"));
		await storage.createCapturedSkillArtifact({
			skill_key: "derived:companion:test-skill",
			layer: "derived",
			status: "candidate",
			name: "Test skill",
			domain: "agent-learning",
			task_type: "consolidation",
			agent_tenant: "companion",
			source_observation_id: "obs_skill_1",
			provenance: { metabolized_observation_ids: ["obs_skill_metabolized"] },
			metadata: {}
		});

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes an observation with an outbound link (§5.2 clause 7)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_link_source"));
		await storage.appendToTerritory("craft", cleanCandidate("obs_link_target"));
		const link: Link = {
			id: "link_1",
			source_id: "obs_link_source",
			target_id: "obs_link_target",
			resonance_type: "semantic",
			strength: "present",
			origin: "daemon",
			created: daysAgo(200),
			last_activated: daysAgo(200)
		};
		await storage.appendLink(link);

		expect(await findCandidateIds(storage)).toEqual([]);
	});

	it("excludes an observation with an INBOUND link too — protection checks both directions", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_link_source_2"));
		await storage.appendToTerritory("craft", cleanCandidate("obs_link_target_2"));
		const link: Link = {
			id: "link_2",
			source_id: "obs_link_source_2",
			target_id: "obs_link_target_2",
			resonance_type: "semantic",
			strength: "present",
			origin: "daemon",
			created: daysAgo(200),
			last_activated: daysAgo(200)
		};
		await storage.appendLink(link);

		// obs_link_target_2 is only ever a TARGET, never a source — must still be excluded.
		expect(await findCandidateIds(storage)).not.toContain("obs_link_target_2");
	});

	it("ops/ADR-JANITOR.md §2.1 instance nine (commit 7c): last_surfaced_at round-trips a real, non-null value through the sqlite backend when it's old enough not to exclude", async () => {
		const storage = freshStorage();
		const surfacedAt = daysAgo(200); // older than the 60-day surfacedCutoff — passes clause, stays populated
		await storage.appendToTerritory("craft", cleanCandidate("obs_surfaced_old", { last_surfaced_at: surfacedAt }));

		const rows = await storage.findSalienceRegradeCandidates!(MIN_AGE_CUTOFF, SURFACED_CUTOFF, FETCH_CAP);

		// Proves this isn't passing because both sides are null (toPublicObservation
		// used to strip this field entirely) — a real value must survive the round trip.
		expect(rows).toHaveLength(1);
		expect(rows[0].last_surfaced_at).toBe(surfacedAt);
	});

	it("orders survivors oldest-first (created_at ASC)", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", cleanCandidate("obs_newer", { created: daysAgo(100) }));
		await storage.appendToTerritory("craft", cleanCandidate("obs_oldest", { created: daysAgo(500) }));
		await storage.appendToTerritory("craft", cleanCandidate("obs_middle", { created: daysAgo(300) }));

		expect(await findCandidateIds(storage)).toEqual(["obs_oldest", "obs_middle", "obs_newer"]);
	});
});
