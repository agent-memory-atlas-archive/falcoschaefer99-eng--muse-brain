// ops/ADR-JANITOR.md §5.1 — the seam this commit fixed: readFoundationalObservations()
// used to `ORDER BY created_at DESC LIMIT 200` (truncating by recency) before
// tools-v2/wake.ts's buildFoundationLane ever got a chance to re-rank the result by
// calculatePullStrength — so a high-pull-strength OLD foundational memory could be
// dropped here, before the ranker ever saw it. This test drives the real storage
// method (mocked `sql` tag, no live Postgres — same harness shape as
// postgres-salience-regrade-candidates.spec.ts) and fails if that regresses: it does
// NOT re-implement the ranking in test scope, it asserts on the actual output.
import { describe, expect, it, vi } from "vitest";
import { createPostgresStorage } from "../src/storage/postgres";

function foundationalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "obs_default",
		content: "a foundational memory",
		territory: "self",
		created_at: new Date("2026-01-01T00:00:00.000Z"),
		texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "present" },
		context: null,
		mood: null,
		last_accessed_at: null,
		access_count: 1,
		links: [],
		summary: null,
		type: null,
		tags: [],
		entity_id: null,
		...overrides
	};
}

function makeSql(rows: Array<Record<string, unknown>>) {
	const sql = (async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows) as any;
	sql.json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	return sql;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("Postgres readFoundationalObservations — ranks by pull strength, not recency", () => {
	it("an old, high-pull-strength row ranks ahead of a new, low-pull-strength row", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;

		const oldButAlive = foundationalRow({
			id: "obs_old_alive",
			created_at: daysAgo(400),
			texture: { salience: "foundational", vividness: "crystalline", charge: ["identity", "vow", "home", "grief"], grip: "iron" },
			access_count: 20
		});
		const newButDormant = foundationalRow({
			id: "obs_new_dormant",
			created_at: daysAgo(0),
			texture: { salience: "foundational", vividness: "faded", charge: [], grip: "dormant" },
			access_count: 0
		});

		// Insertion order deliberately puts the recency-favored row first — if this
		// were still `ORDER BY created_at DESC`, obs_new_dormant would lead.
		storage.sql = makeSql([newButDormant, oldButAlive]);

		const result = await storage.readFoundationalObservations();
		const ids = result.map((r: any) => r.observation.id);

		expect(ids).toEqual(["obs_old_alive", "obs_new_dormant"]);
	});

	it("truncation past the cap drops the least-alive row, keeping an old-but-alive row over a new-but-dormant one", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;

		// 200 filler rows at a middling pull strength, all newer and less "alive" than
		// obs_old_alive but more alive than obs_new_dormant — enough rows that the cap
		// (FOUNDATIONAL_LANE_CAP = 200) has to actually drop someone.
		const fillers = Array.from({ length: 200 }, (_, i) =>
			foundationalRow({
				id: `obs_filler_${i}`,
				created_at: daysAgo(5),
				texture: { salience: "foundational", vividness: "vivid", charge: ["a", "b"], grip: "strong" },
				access_count: 3
			})
		);
		const oldButAlive = foundationalRow({
			id: "obs_old_alive",
			created_at: daysAgo(400),
			texture: { salience: "foundational", vividness: "crystalline", charge: ["identity", "vow", "home", "grief"], grip: "iron" },
			access_count: 20
		});
		const newButDormant = foundationalRow({
			id: "obs_new_dormant",
			created_at: daysAgo(0),
			texture: { salience: "foundational", vividness: "faded", charge: [], grip: "dormant" },
			access_count: 0
		});

		storage.sql = makeSql([...fillers, oldButAlive, newButDormant]);

		const result = await storage.readFoundationalObservations();
		const ids = new Set(result.map((r: any) => r.observation.id));

		expect(result.length).toBe(200);
		// The high-pull-strength row survives despite being the oldest by far.
		expect(ids.has("obs_old_alive")).toBe(true);
		// The newest row is the one that gets dropped, because it's the least alive —
		// the exact inversion of the old `ORDER BY created_at DESC` behavior.
		expect(ids.has("obs_new_dormant")).toBe(false);
	});
});
