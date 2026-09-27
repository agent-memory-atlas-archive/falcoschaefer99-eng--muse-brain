// ops/ADR-JANITOR.md §6.2 — findSimilarByEmbedding: findSimilarUnlinked minus its
// already_linked/pending_proposals exclusion CTEs, plus a similarity floor pushed
// into SQL. Same mocked-`sql`-tag harness shape as postgres-proposals.spec.ts.
// 🔒 Michael flag (§6.2): tenant filter must be present on both the source CTE
// and the lateral — asserted below via the reconstructed query text, not just
// "the query ran."
import { describe, expect, it } from "vitest";
import { createPostgresStorage } from "../src/storage/postgres";

function similarRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "obs_candidate",
		content: "a near-duplicate memory",
		territory: "craft",
		created_at: new Date("2026-01-01T00:00:00.000Z"),
		texture: { salience: "active", vividness: "vivid", charge: [], grip: "present" },
		context: null,
		mood: null,
		last_accessed_at: null,
		access_count: 0,
		links: [],
		summary: null,
		type: null,
		tags: [],
		entity_id: null,
		similarity: 0.78,
		...overrides
	};
}

function makeSqlSequence(responses: Array<Array<Record<string, unknown>> | Error>) {
	const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ strings, values });
		const response = responses.shift() ?? [];
		if (response instanceof Error) throw response;
		return response;
	}) as any;
	sql.json = () => { throw new Error("findSimilarByEmbedding must not need sql.json"); };
	return { sql, calls };
}

describe("Postgres findSimilarByEmbedding", () => {
	it("filters by tenant on both the source CTE and the lateral, pushes minSimilarity into SQL, and excludes the source id", async () => {
		const { sql, calls } = makeSqlSequence([[similarRow()]]);
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "rainer") as any;
		storage.sql = sql;

		const results = await storage.findSimilarByEmbedding("obs_source", 5, 0.5);

		expect(calls).toHaveLength(1);
		const queryText = calls[0].strings.join("?");
		// tenant filter present twice — source CTE and the lateral (🔒 Michael, §6.2)
		expect(queryText.match(/tenant_id = \?/g)?.length).toBe(2);
		expect(queryText).toContain("id != ?");
		expect(queryText).toContain(">= ?");
		expect(calls[0].values).toContain("rainer");
		expect(calls[0].values).toContain("obs_source");
		expect(calls[0].values).toContain(5);
		expect(calls[0].values).toContain(0.5);

		expect(results).toHaveLength(1);
		expect(results[0].observation.id).toBe("obs_candidate");
		expect(results[0].territory).toBe("craft");
		expect(results[0].similarity).toBe(0.78);
	});

	it("does NOT carry findSimilarUnlinked's already_linked / pending_proposals exclusions — a linked or previously-proposed pair is exactly what dedup needs to see (§0.4 item 3)", async () => {
		const { sql, calls } = makeSqlSequence([[similarRow()]]);
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "rainer") as any;
		storage.sql = sql;

		await storage.findSimilarByEmbedding("obs_source", 5, 0.5);

		const queryText = calls[0].strings.join("?");
		expect(queryText).not.toContain("already_linked");
		expect(queryText).not.toContain("pending_proposals");
	});

	it("returns [] and logs rather than throwing on a query failure", async () => {
		const errorSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
		const { sql } = makeSqlSequence([new Error("connection reset")]);
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "rainer") as any;
		storage.sql = sql;

		const results = await storage.findSimilarByEmbedding("obs_source", 5, 0.5);

		expect(results).toEqual([]);
		errorSpy.mockRestore();
	});
});
