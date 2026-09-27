import { describe, expect, it } from "vitest";

import { createEmbeddingProvider, parseEmbedQueryPrefixEnv } from "../src/embedding/index";
import { WorkersAIEmbeddingProvider } from "../src/embedding/workers-ai";
import type { WorkersAIClient } from "../src/ai/interface";

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/** Records every text string actually sent to the model, so tests can assert
 * on the exact string embedQuery/embedText produced — not just the return value. */
function makeAiClient(): { client: WorkersAIClient; calls: string[] } {
	const calls: string[] = [];
	const client: WorkersAIClient = {
		async run(_model: string, input: unknown) {
			const text = (input as { text: string[] }).text[0];
			calls.push(text);
			return { data: [[0.1, 0.2, 0.3]] };
		}
	};
	return { client, calls };
}

describe("WorkersAIEmbeddingProvider.embedQuery — ADR-RETRIEVAL-FUSION-RETUNE §5 item 1", () => {
	it("prepends the BGE query instruction prefix exactly once when the flag is on", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client, true);

		await provider.embedQuery("what did I say about the book");

		expect(calls).toEqual([`${QUERY_PREFIX}what did I say about the book`]);
	});

	it("does not accumulate the prefix across repeated calls with the same text", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client, true);

		await provider.embedQuery("the office email");
		await provider.embedQuery("the office email");

		expect(calls).toEqual([
			`${QUERY_PREFIX}the office email`,
			`${QUERY_PREFIX}the office email`
		]);
	});

	it("behaves exactly like embedText when the flag is off", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client, false);

		await provider.embedQuery("plain query text");

		expect(calls).toEqual(["plain query text"]);
	});

	it("defaults the flag to on when the constructor's third argument is omitted", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client);

		await provider.embedQuery("no flag passed at all");

		expect(calls).toEqual([`${QUERY_PREFIX}no flag passed at all`]);
	});

	it("never prefixes embedText (document-side), even with the flag on", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client, true);

		await provider.embedText("alpha memory, the full observation content");

		expect(calls).toEqual(["alpha memory, the full observation content"]);
	});

	it("embedQuery and embedText diverge only in the prefix — same underlying embedding call", async () => {
		const { client, calls } = makeAiClient();
		const provider = new WorkersAIEmbeddingProvider(client, true);

		const queryVector = await provider.embedQuery("shared text");
		const textVector = await provider.embedText("shared text");

		expect(calls).toEqual([`${QUERY_PREFIX}shared text`, "shared text"]);
		expect(queryVector).toEqual([0.1, 0.2, 0.3]);
		expect(textVector).toEqual([0.1, 0.2, 0.3]);
	});
});

describe("createEmbeddingProvider — embedQueryPrefix option", () => {
	it("wires embedQueryPrefix: true through to the constructed provider's embedQuery", async () => {
		const { client, calls } = makeAiClient();
		const provider = createEmbeddingProvider(client, { embedQueryPrefix: true });

		await provider.embedQuery("query text");

		expect(calls).toEqual([`${QUERY_PREFIX}query text`]);
	});

	it("defaults embedQueryPrefix to true when options are omitted entirely", async () => {
		const { client, calls } = makeAiClient();
		const provider = createEmbeddingProvider(client);

		await provider.embedQuery("query text");

		expect(calls).toEqual([`${QUERY_PREFIX}query text`]);
	});

	it("wires embedQueryPrefix: false through to the constructed provider's embedQuery", async () => {
		const { client, calls } = makeAiClient();
		const provider = createEmbeddingProvider(client, { embedQueryPrefix: false });

		await provider.embedQuery("query text");

		expect(calls).toEqual(["query text"]);
	});
});

describe("parseEmbedQueryPrefixEnv — default ON, A/B 2026-09-05 kept it (SWEEP-2026-09-05.md §prefix)", () => {
	it("returns true for undefined, empty string, \"1\", and \"true\" (case-insensitive, trimmed)", () => {
		expect(parseEmbedQueryPrefixEnv(undefined)).toBe(true);
		expect(parseEmbedQueryPrefixEnv("")).toBe(true);
		expect(parseEmbedQueryPrefixEnv("1")).toBe(true);
		expect(parseEmbedQueryPrefixEnv("true")).toBe(true);
		expect(parseEmbedQueryPrefixEnv("TRUE")).toBe(true);
		expect(parseEmbedQueryPrefixEnv("  true  ")).toBe(true);
	});

	it("returns false only for \"0\" and \"false\" (case-insensitive, trimmed) — anything unrecognized falls back to the default", () => {
		expect(parseEmbedQueryPrefixEnv("0")).toBe(false);
		expect(parseEmbedQueryPrefixEnv("false")).toBe(false);
		expect(parseEmbedQueryPrefixEnv("FALSE")).toBe(false);
		expect(parseEmbedQueryPrefixEnv("  false  ")).toBe(false);
		expect(parseEmbedQueryPrefixEnv("  0  ")).toBe(false);
		expect(parseEmbedQueryPrefixEnv("yes")).toBe(true);
	});
});
