// createParadoxLoop (connections.ts) is the ONE creation path shared by
// mind_loop action=paradox (this tool, human/agent-facing) and
// tools-v2/propose.ts's paradox_detected accept branch (daemon-sourced,
// single-core). This file pins that the tool's own >=2 linked_entity_ids gate
// stays exactly as strict as before the refactor — the shared function itself
// carries no such minimum (see propose-paradox-detected.spec.ts for the
// single-element path exercised through propose.ts).
import { describe, expect, it, vi } from "vitest";
import { handleTool as handleConnectionsTool } from "../src/tools-v2/connections";

function makeStorage(overrides: Record<string, unknown> = {}) {
	return {
		getTenant: () => "rook",
		appendOpenLoop: vi.fn(async () => undefined),
		validateTerritory: vi.fn((t: string) => t),
		...overrides
	};
}

describe("mind_loop action=paradox — tool-boundary validation unchanged by the shared creation path", () => {
	it("still rejects a single linked_entity_id — the human/agent-facing tool must name both cores in friction", async () => {
		const storage = makeStorage();

		const result = await handleConnectionsTool("mind_loop", {
			action: "paradox",
			content: "vision vs pragmatism",
			linked_entity_ids: ["core_1"]
		}, { storage: storage as any });

		expect(result.error).toMatch(/at least 2 entity IDs/);
		expect(storage.appendOpenLoop).not.toHaveBeenCalled();
	});

	it("still creates a burning paradox loop for 2 valid linked_entity_ids — unchanged behavior after the extraction", async () => {
		const storage = makeStorage();

		const result = await handleConnectionsTool("mind_loop", {
			action: "paradox",
			content: "vision vs pragmatism",
			linked_entity_ids: ["core_1", "core_2"]
		}, { storage: storage as any });

		expect(storage.appendOpenLoop).toHaveBeenCalledTimes(1);
		const loop = (storage.appendOpenLoop as any).mock.calls[0][0];
		expect(loop.mode).toBe("paradox");
		expect(loop.status).toBe("burning");
		expect(loop.linked_entity_ids).toEqual(["core_1", "core_2"]);
		expect(result.created).toBe(true);
		expect(result.id).toBe(loop.id);
	});
});
