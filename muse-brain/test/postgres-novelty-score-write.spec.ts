// fix(brain): novelty exists as a dimension again — B1, the write path.
// ops/ADR-JANITOR.md's audit found the `novelty_score` column was never written
// by any Postgres INSERT/UPSERT, so every observation sat at the schema DEFAULT
// (0.5, migrations/001_initial_schema.sql:73) forever, no matter what
// texture.novelty_score said (always 1.0 at creation — src/tools-v2/memory.ts).
// Tested against a mocked `sql` tag (same harness shape as
// postgres-salience-regrade-candidates.spec.ts / postgres-proposals.spec.ts)
// rather than a live Postgres instance — this repo's established convention for
// proving query text + bound values without a real DB. The Layer-B-multiplier
// half of the round-trip (column value -> retrieval score) is covered in
// test/retrieval-scoring.spec.ts's "B1 fix" describe block.
import { describe, expect, it, vi } from "vitest";
import { createPostgresStorage } from "../src/storage/postgres";
import type { Observation } from "../src/types";

/** Captures every tagged-template call instead of returning a canned response. */
function makeCapturingSql(response: Array<Record<string, unknown>> = []) {
	const calls: { text: string; values: unknown[] }[] = [];
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ text: strings.join("?"), values });
		return response;
	}) as any;
	sql.json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	// writeTerritory() opens a transaction via sql.begin(async (sql) => {...}) —
	// hand back the SAME capturing sql so _executeInsertQueries' calls land in `calls`.
	sql.begin = vi.fn(async (fn: (sql: unknown) => Promise<void>) => { await fn(sql); });
	return { sql, calls };
}

function baseObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: overrides.id ?? "obs_new",
		content: overrides.content ?? "a fresh observation",
		territory: overrides.territory ?? "episodic",
		created: overrides.created ?? "2026-09-06T00:00:00.000Z",
		texture: overrides.texture ?? {
			salience: "active",
			vividness: "vivid",
			charge: [],
			grip: "present",
			charge_phase: "fresh",
			novelty_score: 1.0
		},
		access_count: overrides.access_count ?? 0
	};
}

describe("Postgres appendToTerritory (_insertObservation) writes the real novelty_score column", () => {
	it("a freshly-created observation (texture.novelty_score: 1.0) writes 1.0 into the novelty_score column, not the schema default", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		await storage.appendToTerritory("episodic", baseObservation());

		expect(calls).toHaveLength(1);
		expect(calls[0].text).toContain("novelty_score");
		// novelty_score is the last column added to both the column list and the
		// VALUES list in _insertObservation (postgres.ts) — last bound value.
		expect(calls[0].values.at(-1)).toBe(1.0);
	});

	it("the ON CONFLICT DO UPDATE SET list carries novelty_score — an upsert that omitted it would silently revert existing rows to the default", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		await storage.appendToTerritory("episodic", baseObservation());

		expect(calls[0].text).toMatch(/ON CONFLICT[\s\S]*novelty_score\s*=\s*EXCLUDED\.novelty_score/);
	});

	it("an observation whose texture omits novelty_score entirely falls back to 1.0, matching sqlite.ts's own fallback default", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		const obs = baseObservation({
			texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", charge_phase: "fresh" }
		});
		await storage.appendToTerritory("episodic", obs);

		expect(calls[0].values.at(-1)).toBe(1.0);
	});

	it("a non-default texture.novelty_score (e.g. already decayed by updateSurfacingEffects) passes through unchanged, not clobbered to 1.0", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		const obs = baseObservation({
			texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", charge_phase: "processing", novelty_score: 0.42 }
		});
		await storage.appendToTerritory("episodic", obs);

		expect(calls[0].values.at(-1)).toBe(0.42);
	});
});

describe("Postgres writeTerritory (_executeInsertQueries) also writes novelty_score, including its own ON CONFLICT list", () => {
	it("writes novelty_score in both the VALUES list and the ON CONFLICT DO UPDATE SET list", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		await storage.writeTerritory("episodic", [baseObservation()]);

		// calls[0] is the DELETE; calls[1] is the INSERT from _executeInsertQueries.
		const insertCall = calls.find(c => c.text.includes("INSERT INTO observations"));
		expect(insertCall).toBeDefined();
		expect(insertCall!.text).toContain("novelty_score");
		expect(insertCall!.text).toMatch(/ON CONFLICT[\s\S]*novelty_score\s*=\s*EXCLUDED\.novelty_score/);
		expect(insertCall!.values.at(-1)).toBe(1.0);
	});
});

describe("Postgres bulkReplaceTexture mirrors texture.novelty_score onto the column (matching sqlite.ts:634)", () => {
	it("the UPDATE statement's SET list carries a COALESCE that mirrors the new texture's novelty_score onto the real column", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		await storage.bulkReplaceTexture([
			{ id: "obs_1", texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", novelty_score: 0.9 } }
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].text).toMatch(/novelty_score\s*=\s*COALESCE\(\(updates\.new_texture->>'novelty_score'\)::real, observations\.novelty_score\)/);
	});

	it("falls back to the existing column value (does not clobber to NULL) when the new texture omits novelty_score — same COALESCE semantics as sqlite's ternary", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		const { sql, calls } = makeCapturingSql();
		storage.sql = sql;

		await storage.bulkReplaceTexture([
			{ id: "obs_1", texture: { salience: "active", vividness: "vivid", charge: [], grip: "present" } }
		]);

		// Structural guarantee: the SQL always runs through the SAME COALESCE
		// expression regardless of whether this particular texture carries a
		// novelty_score — the fallback-to-self behavior lives in Postgres (the
		// jsonb ->> of a missing key is NULL, so COALESCE keeps observations.novelty_score),
		// not in JS, so there is nothing texture-shaped to branch on here.
		expect(calls[0].text).toMatch(/novelty_score\s*=\s*COALESCE\(\(updates\.new_texture->>'novelty_score'\)::real, observations\.novelty_score\)/);
	});
});
