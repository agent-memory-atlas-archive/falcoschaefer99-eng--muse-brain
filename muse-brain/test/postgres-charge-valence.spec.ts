// ops/ADR-VALENCE-FLOOR.md, slice 0 — Postgres readChargeValence/upsertChargeValence.
// Tested against a mocked `sql` tag (same harness shape as
// postgres-salience-regrade-candidates.spec.ts / postgres-novelty-score-write.spec.ts)
// rather than a live Postgres instance.
import { describe, expect, it, vi } from "vitest";
import { createPostgresStorage } from "../src/storage/postgres";
import type { ChargeValenceRow } from "../src/types";

function chargeValenceRow(overrides: Record<string, unknown> = {}) {
	return {
		charge: "creative fire",
		valence: "positive",
		method: "llm",
		model: "@cf/meta/llama-3.2-3b-instruct",
		classified_at: new Date("2026-09-17T00:00:00.000Z"),
		observation_count: 4,
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

/** Captures every tagged-template call instead of returning a canned response. */
function makeCapturingSql(response: Array<Record<string, unknown>> = []) {
	const calls: { text: string; values: unknown[] }[] = [];
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ text: strings.join("?"), values });
		return response;
	}) as any;
	sql.json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	return { sql, calls };
}

describe("Postgres readChargeValence", () => {
	it("maps a row's classified_at Date to an ISO string, scoped to this.tenant", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = makeSqlSequence([[chargeValenceRow()]]);

		const rows: ChargeValenceRow[] = await storage.readChargeValence();

		expect(rows).toEqual([{
			charge: "creative fire",
			valence: "positive",
			method: "llm",
			model: "@cf/meta/llama-3.2-3b-instruct",
			classified_at: "2026-09-17T00:00:00.000Z",
			observation_count: 4
		}]);
	});

	it("returns an empty array (never throws) on a query failure", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = makeSqlSequence([new Error("connection reset")]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			expect(await storage.readChargeValence()).toEqual([]);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("Postgres upsertChargeValence", () => {
	it("issues one INSERT ... ON CONFLICT (tenant_id, charge) DO UPDATE per row, with the tenant bound", async () => {
		const { sql, calls } = makeCapturingSql();
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = sql;

		await storage.upsertChargeValence([
			{ charge: "joy", valence: "positive", method: "llm", model: "m1", classified_at: "2026-09-17T00:00:00.000Z", observation_count: 2 },
			{ charge: "grief", valence: "negative", method: "manual", model: "m1", classified_at: "2026-09-17T00:00:00.000Z", observation_count: 1 }
		]);

		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.text).toContain("INSERT INTO charge_valence");
			expect(call.text).toContain("ON CONFLICT (tenant_id, charge) DO UPDATE SET");
			expect(call.values).toContain("companion");
		}
		expect(calls[0].values).toContain("joy");
		expect(calls[1].values).toContain("grief");
	});

	it("no-ops on an empty array — zero queries issued", async () => {
		const { sql, calls } = makeCapturingSql();
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = sql;

		await storage.upsertChargeValence([]);

		expect(calls).toHaveLength(0);
	});

	it("throws (does not swallow) on a write failure — a lost classification must be visible, not silent", async () => {
		const storage = createPostgresStorage("postgres://fake:fake@localhost:1/fake", "companion") as any;
		storage.sql = makeSqlSequence([new Error("write failed")]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			await expect(storage.upsertChargeValence([
				{ charge: "joy", valence: "positive", method: "llm", model: "m1", classified_at: "2026-09-17T00:00:00.000Z", observation_count: 1 }
			])).rejects.toThrow("Failed to upsert charge valence");
		} finally {
			errorSpy.mockRestore();
		}
	});
});
