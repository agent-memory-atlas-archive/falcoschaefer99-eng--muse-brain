import { describe, expect, it, vi } from "vitest";
import { createWorkersAIClient, WorkersAIRestAdapter } from "../src/ai";

const ACCOUNT_ID = "d69366bbcb9e63662c708a264c672bf8";

describe("Workers AI REST adapter", () => {
	it("sends authenticated JSON and unwraps result", async () => {
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(
			JSON.stringify({ success: true, result: { embedding: [1, 2] } }),
			{ status: 200, headers: { "content-type": "application/json" } }
		));
		const client = new WorkersAIRestAdapter({ accountId: ACCOUNT_ID, token: "secret", fetch });

		await expect(await client.run("@cf/baai/bge-small-en-v1.5", { text: "hello" }))
			.toEqual({ embedding: [1, 2] });
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-small-en-v1.5`);
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
		expect(JSON.parse(String(init?.body))).toEqual({ text: "hello" });
	});

	it("reports non-2xx responses without leaking credentials", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 1001, message: "bad request" }] }), { status: 400 }));
		await expect(new WorkersAIRestAdapter({ accountId: ACCOUNT_ID, token: "top-secret", fetch }).run("@cf/vendor/model", {}))
			.rejects.toThrow("status 400: 1001: bad request");
		await expect(new WorkersAIRestAdapter({ accountId: ACCOUNT_ID, token: "top-secret", fetch }).run("@cf/vendor/model", {}))
			.rejects.not.toThrow("top-secret");
	});
});

describe("Workers AI client selection", () => {
	it("selects the binding adapter and forwards calls", async () => {
		const run = vi.fn(async () => ({ ok: true }));
		const client = createWorkersAIClient({ run } as unknown as Ai);
		expect(await client?.run("model", { input: 1 })).toEqual({ ok: true });
		expect(run).toHaveBeenCalledWith("model", { input: 1 });
	});

	it("selects REST for account/token options and preserves degraded undefined", () => {
		expect(createWorkersAIClient(undefined)).toBeUndefined();
		expect(createWorkersAIClient({ accountId: ACCOUNT_ID, token: "token" })).toBeInstanceOf(WorkersAIRestAdapter);
	});
});
