import { describe, expect, it } from "vitest";

import type { Observation } from "../src/types";
import { applyDecaySemantics } from "../src/daemon/decay";
import { createStorage } from "../src/storage/factory";

const AS_OF = new Date("2026-08-01T00:00:00.000Z");

function texture(overrides: Partial<Observation["texture"]> = {}): Observation["texture"] {
	return {
		salience: "active",
		vividness: "crystalline",
		charge: ["keep-me"],
		grip: "iron",
		charge_phase: "fresh",
		...overrides
	};
}

function observation(
	id: string,
	created: string,
	textureValue: Observation["texture"],
	last_accessed?: string
): Observation {
	return {
		id,
		content: id,
		territory: "craft",
		created,
		last_accessed,
		texture: textureValue,
		access_count: 0
	};
}

describe("daemon decay semantics", () => {
	it("keeps every transition strict at its exact threshold, each on its own clock", () => {
		// ops/ADR-JANITOR.md §4: vividness/grip decay on access (lastAccessed),
		// charge_phase decays on age (created) — the two clocks must be exercised
		// through the parameter each dimension actually reads.
		const cases = [
			{
				field: "vividness",
				clock: "access",
				thresholdMs: 7 * 24 * 60 * 60 * 1000,
				startingTexture: texture({ vividness: "crystalline", grip: "present", charge_phase: "metabolized" }),
				expected: { vividness: "vivid" }
			},
			{
				field: "grip",
				clock: "access",
				thresholdMs: 14 * 24 * 60 * 60 * 1000,
				startingTexture: texture({ vividness: "soft", grip: "iron", charge_phase: "metabolized" }),
				expected: { grip: "strong" }
			},
			{
				field: "charge_phase",
				clock: "age",
				thresholdMs: 60 * 60 * 1000,
				startingTexture: texture({ vividness: "soft", grip: "present", charge_phase: "fresh" }),
				expected: { charge_phase: "active" }
			}
		] as const;

		for (const { field, clock, thresholdMs, startingTexture, expected } of cases) {
			const exactTimestamp = new Date(AS_OF.getTime() - thresholdMs).toISOString();
			const olderTimestamp = new Date(AS_OF.getTime() - thresholdMs - 1).toISOString();

			const exact = clock === "access"
				? applyDecaySemantics(startingTexture, exactTimestamp, undefined, AS_OF)
				: applyDecaySemantics(startingTexture, undefined, exactTimestamp, AS_OF);
			const older = clock === "access"
				? applyDecaySemantics(startingTexture, olderTimestamp, undefined, AS_OF)
				: applyDecaySemantics(startingTexture, undefined, olderTimestamp, AS_OF);

			expect(exact.changed, `${field} exact threshold`).toBe(false);
			expect(exact.texture).toEqual(startingTexture);
			expect(older.changed, `${field} one millisecond past threshold`).toBe(true);
			expect(older.texture).toMatchObject(expected);
		}
	});

	it("§4: charge_phase advances on age even when grip is pinned by recent access", () => {
		const createdSixtyDaysAgo = new Date(AS_OF.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
		const accessedYesterday = new Date(AS_OF.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

		const result = applyDecaySemantics(
			texture({ vividness: "crystalline", grip: "iron", charge_phase: "active" }),
			accessedYesterday,
			createdSixtyDaysAgo,
			AS_OF
		);

		// 60 days since creation clears charge_phase's 1-day active->processing
		// threshold regardless of access.
		expect(result.texture.charge_phase).toBe("processing");
		// 1 day since last access is nowhere near grip's 14-day or vividness's
		// 7-day thresholds — access, not age, is what should hold these.
		expect(result.texture.grip).toBe("iron");
		expect(result.texture.vividness).toBe("crystalline");
		expect(result.changed).toBe(true);
	});

	it("uses last_accessed when present and created only as the fallback", () => {
		const created = new Date(AS_OF.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
		const recentlyAccessed = new Date(AS_OF.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

		const accessed = applyDecaySemantics(
			texture({ vividness: "vivid", grip: "present", charge_phase: "metabolized" }),
			recentlyAccessed,
			created,
			AS_OF
		);
		const fallback = applyDecaySemantics(
			texture({ vividness: "vivid", grip: "present", charge_phase: "metabolized" }),
			undefined,
			created,
			AS_OF
		);

		expect(accessed.changed).toBe(false);
		expect(accessed.texture.vividness).toBe("vivid");
		expect(fallback.changed).toBe(true);
		expect(fallback.texture.vividness).toBe("soft");
	});

	it("skips foundational textures and does not invent absent fields", () => {
		const sparse = {
			salience: "active",
			vividness: "crystalline",
			charge: ["keep-me"],
			grip: "iron",
			unrelated_texture_field: { preserved: true }
		} as unknown as Observation["texture"];
		const foundational = texture({ salience: "foundational" });

		const sparseResult = applyDecaySemantics(sparse, undefined, "2026-01-01T00:00:00.000Z", AS_OF);
		const foundationalResult = applyDecaySemantics(
			foundational,
			undefined,
			"2026-01-01T00:00:00.000Z",
			AS_OF
		);

		expect(sparseResult.texture).toEqual({
			...sparse,
			vividness: "vivid",
			grip: "strong"
		});
		expect(sparseResult.texture).not.toHaveProperty("charge_phase");
		expect(foundationalResult.changed).toBe(false);
		expect(foundationalResult.texture).toEqual(foundational);
	});

	it("advances each dimension by only one state per run", () => {
		const first = applyDecaySemantics(
			texture(),
			undefined,
			"2026-01-01T00:00:00.000Z",
			AS_OF
		);

		expect(first.texture).toMatchObject({ vividness: "vivid", grip: "strong", charge_phase: "active" });

		const second = applyDecaySemantics(
			first.texture,
			undefined,
			"2026-01-01T00:00:00.000Z",
			AS_OF
		);
		expect(second.texture).toMatchObject({ vividness: "soft", grip: "present", charge_phase: "processing" });
	});
});

describe("sqlite daemon decay parity", () => {
	it("returns changed rows and matches the pure semantics helper", async () => {
		const dbPath = `/tmp/muse-brain-decay-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "rainer");
		const oldCreated = "2026-01-01T00:00:00.000Z";
			const recentCreated = "2026-07-31T23:30:00.000Z";

		const old = observation(
			"obs_decay_old",
			oldCreated,
			{
				...texture(),
				custom_field: "preserve"
			} as Observation["texture"]
		);
		const foundational = observation("obs_decay_foundational", oldCreated, texture({ salience: "foundational" }));
		const recent = observation("obs_decay_recent", recentCreated, texture());
		await storage.appendToTerritory("craft", old);
		await storage.appendToTerritory("craft", foundational);
		await storage.appendToTerritory("craft", recent);

		const changed = await storage.runDecay(AS_OF);
		expect(changed).toBe(1);

		const updated = (await storage.findObservation(old.id))?.observation;
		const untouchedFoundational = (await storage.findObservation(foundational.id))?.observation;
		const untouchedRecent = (await storage.findObservation(recent.id))?.observation;
		const expected = applyDecaySemantics(old.texture, old.last_accessed, old.created, AS_OF);

		expect(updated?.texture).toEqual(expected.texture);
		expect(updated?.texture).toHaveProperty("custom_field", "preserve");
		expect(untouchedFoundational?.texture).toEqual(foundational.texture);
		expect(untouchedRecent?.texture).toEqual(recent.texture);
	});
});
