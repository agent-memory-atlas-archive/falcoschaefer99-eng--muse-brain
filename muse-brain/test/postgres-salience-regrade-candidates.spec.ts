// ops/ADR-JANITOR.md §2.1 instance nine (commit 7c) — rowToObservation's mapping of
// the real `last_surfaced_at` column onto the public Observation type, tested against
// a mocked `sql` tag (same harness shape as postgres-proposals.spec.ts) rather than a
// live Postgres instance. This is the storage-layer half of the round-trip; the
// Observation -> RegradeSample half is covered in salience-regrade-task.spec.ts.
import { describe, expect, it, vi } from "vitest";
import { createPostgresStorage } from "../src/storage/postgres";

function candidateRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "obs_surfaced",
		content: "a foundational memory",
		territory: "craft",
		created_at: new Date("2025-01-01T00:00:00.000Z"),
		texture: { salience: "foundational", vividness: "vivid", charge: [], grip: "iron" },
		context: null,
		mood: null,
		last_accessed_at: null,
		access_count: 0,
		links: [],
		summary: null,
		type: null,
		tags: [],
		entity_id: null,
		last_surfaced_at: new Date("2026-01-01T00:00:00.000Z"),
		...overrides
	};
}

function makeSqlSequence(responses: Array<Array<Record<string, unknown>> | Error>) {
	const sql = (async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
		const response = responses.shift() ?? [];
		if (response instanceof Error) throw response;
		return response;
	}) as any;
	sql.json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	return sql;
}

describe("Postgres findSalienceRegradeCandidates — rowToObservation maps the real last_surfaced_at column", () => {
	it("a row carrying a real last_surfaced_at TIMESTAMPTZ value round-trips onto Observation.last_surfaced_at as an ISO string", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = makeSqlSequence([[candidateRow()]]);

		const [candidate] = await storage.findSalienceRegradeCandidates(
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			10
		);

		expect(candidate.id).toBe("obs_surfaced");
		expect(candidate.last_surfaced_at).toBe("2026-01-01T00:00:00.000Z");
	});

	it("a row with last_surfaced_at NULL maps to undefined, not a stringified null", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = makeSqlSequence([[candidateRow({ last_surfaced_at: null })]]);

		const [candidate] = await storage.findSalienceRegradeCandidates(
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			10
		);

		expect(candidate.last_surfaced_at).toBeUndefined();
	});
});
