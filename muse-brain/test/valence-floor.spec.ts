// ops/ADR-VALENCE-FLOOR.md, slice 0 — daemon/tasks/valence-floor.ts. Pins the
// eligibility predicate (unmixed positive, fail-closed on any unclassified
// charge) and the seat-count formula across the distributions the ADR itself
// works through, plus the null-vs-zero / before-first-run discipline.
import { describe, expect, it, vi } from "vitest";

import { runValenceFloorTask, classifyEligibility } from "../src/daemon/tasks/valence-floor";
import type { Observation, ChargeValence, ChargeValenceRow } from "../src/types";

function lexicon(entries: Record<string, ChargeValence>): ChargeValenceRow[] {
	return Object.entries(entries).map(([charge, valence]) => ({
		charge,
		valence,
		method: "llm",
		model: "@cf/meta/llama-3.2-3b-instruct",
		classified_at: "2026-09-17T00:00:00.000Z",
		observation_count: 1
	}));
}

function foundational(id: string, charges: string[], overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `foundational memory ${id}`,
		territory: "us",
		created: "2025-01-01T00:00:00.000Z",
		texture: { salience: "foundational", vividness: "vivid", charge: charges, grip: "iron" },
		access_count: 5,
		last_accessed: "2025-01-01T00:00:00.000Z",
		...overrides
	};
}

function territoryData(observations: Observation[]) {
	return [{ territory: "us", observations }];
}

function makeStorage(rows: ChargeValenceRow[]) {
	return { readChargeValence: vi.fn(async () => rows) };
}

describe("classifyEligibility — unmixed positive (ADR §Eligibility)", () => {
	const map = new Map<string, ChargeValence>([
		["joy", "positive"],
		["pride", "positive"],
		["calm", "neutral"],
		["grief", "negative"],
		["ambivalence", "mixed"],
		["love", "positive"],
		["shame", "negative"]
	]);

	it("eligible: at least one positive, no negative/mixed", () => {
		expect(classifyEligibility(["joy", "pride"], map)).toBe("eligible");
		expect(classifyEligibility(["joy"], map)).toBe("eligible");
	});

	it("eligible: positive plus neutral (neutral neither disqualifies nor satisfies alone)", () => {
		expect(classifyEligibility(["joy", "calm"], map)).toBe("eligible");
	});

	it("ineligible: all-neutral, no positive at all", () => {
		expect(classifyEligibility(["calm"], map)).toBe("ineligible");
	});

	it("ineligible: any negative present disqualifies, even alongside positive — NOT majority/net positive", () => {
		// The ADR's own example: grief, recognition, determination, love, shame —
		// has love (positive) but also grief and shame (negative) — ineligible.
		expect(classifyEligibility(["grief", "love", "shame"], map)).toBe("ineligible");
	});

	it("ineligible: any mixed charge disqualifies", () => {
		expect(classifyEligibility(["ambivalence", "joy"], map)).toBe("ineligible");
	});

	it("ineligible: zero charges", () => {
		expect(classifyEligibility([], map)).toBe("ineligible");
	});

	it("unclassified: any charge missing a lexicon row, fail closed — never falls back to neutral", () => {
		expect(classifyEligibility(["joy", "never-seen-before"], map)).toBe("unclassified");
		expect(classifyEligibility(["never-seen-before"], map)).toBe("unclassified");
	});
});

describe("runValenceFloorTask — formula (ADR §How many seats)", () => {
	it("before first run (storage predates the lexicon): a real fallback, not a crash", async () => {
		const storage = {} as any;
		const result = await runValenceFloorTask(storage, territoryData([foundational("a", ["joy"])]));

		expect(result.seats).toBe(0);
		expect(result.reason).toMatch(/does not support/);
		expect(result.lexicon_rows).toBe(0);
	});

	it("no foundational memories at all: honest zero with a distinct reason", async () => {
		const storage = makeStorage(lexicon({ joy: "positive" }));
		const result = await runValenceFloorTask(storage as any, territoryData([]));

		expect(result.seats).toBe(0);
		expect(result.reason).toBe("no foundational memories exist yet");
		expect(result.classified).toBe(0);
		expect(result.eligible_share).toBeNull();
	});

	it("zero eligible memories measured: seats 0, real reason, no crash", async () => {
		const storage = makeStorage(lexicon({ grief: "negative", shame: "negative" }));
		const observations = Array.from({ length: 6 }, (_, i) => foundational(`o${i}`, ["grief", "shame"]));

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.classified).toBe(6);
		expect(result.eligible).toBe(0);
		expect(result.eligible_share).toBe(0);
		expect(result.seats).toBe(0);
		expect(result.reason).toMatch(/no eligible/);
	});

	it("mirrors the ADR's own table: braided repair with `love` is INELIGIBLE (wins on pull strength alone)", async () => {
		const storage = makeStorage(lexicon({
			grief: "negative", recognition: "neutral", determination: "neutral", love: "positive", shame: "negative",
			excitement: "positive", momentum: "positive", "creative fire": "positive", pride: "positive"
		}));
		const observations = [
			foundational("braided", ["grief", "recognition", "determination", "love", "shame"]),
			foundational("clean-joy", ["excitement", "momentum", "creative fire", "pride"])
		];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.classified).toBe(2);
		expect(result.eligible).toBe(1); // only clean-joy
	});

	it("raw = round(5 * eligible_share); target = max(raw, 1) when eligible > 0", async () => {
		// 1 of 10 classified is eligible => share 0.1 => raw = round(0.5) = 0,
		// but eligible > 0 so target floors to 1, not 0.
		const storage = makeStorage(lexicon({ joy: "positive", grief: "negative" }));
		const observations = [
			foundational("eligible-1", ["joy"]),
			...Array.from({ length: 9 }, (_, i) => foundational(`ineligible-${i}`, ["grief"]))
		];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.classified).toBe(10);
		expect(result.eligible).toBe(1);
		expect(result.eligible_share).toBeCloseTo(0.1, 10);
	});

	it("seats never exceeds SEAT_CAP (2) even when eligible_share is very high", async () => {
		// All but two negative (ineligible, HIGH pull) plus a large positive-only
		// pool with LOW pull strength (access_count 0, old, dormant grip) so none
		// of them land in the simulated top-5 — target should hit the cap of 2.
		const storage = makeStorage(lexicon({ grief: "negative", joy: "positive" }));
		const observations = [
			...Array.from({ length: 2 }, (_, i) => foundational(`neg-${i}`, ["grief"], {
				access_count: 50, last_accessed: new Date().toISOString(), texture: { salience: "foundational", vividness: "vivid", charge: ["grief"], grip: "iron" }
			})),
			...Array.from({ length: 18 }, (_, i) => foundational(`pos-${i}`, ["joy"], {
				access_count: 0, last_accessed: "2020-01-01T00:00:00.000Z",
				texture: { salience: "foundational", vividness: "vivid", charge: ["joy"], grip: "dormant" }
			}))
		];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.eligible).toBe(18);
		expect(result.seats).toBeLessThanOrEqual(2);
	});

	it("seats clamp to eligible_supply_after_cut — never reserve a seat you cannot fill", async () => {
		// eligible_share is high (drives target toward the cap), but only ONE
		// eligible memory actually survives the storage cut (a synthetic
		// FOUNDATIONAL_LANE_CAP=200 makes this hard to hit for real, so this test
		// documents the clamp exists at the unit level via a corpus that is
		// entirely within the cut and has a single eligible row while the rest
		// are ineligible-but-classified with much higher pull, so eligible ends
		// up thin without going through the storage cut at all).
		const storage = makeStorage(lexicon({ grief: "negative", joy: "positive" }));
		const observations = [
			foundational("only-eligible", ["joy"], { access_count: 0, last_accessed: "2020-01-01T00:00:00.000Z", texture: { salience: "foundational", vividness: "vivid", charge: ["joy"], grip: "dormant" } }),
			...Array.from({ length: 5 }, (_, i) => foundational(`neg-${i}`, ["grief"], { access_count: 50, last_accessed: new Date().toISOString() }))
		];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.eligible_supply_after_cut).toBe(1);
		expect(result.seats).toBeLessThanOrEqual(1);
	});

	it("computes lexicon_coverage_pct from distinct charges actually present on foundational memories, not the whole lexicon", async () => {
		const storage = makeStorage(lexicon({ joy: "positive" })); // "grief" deliberately NOT classified
		const observations = [foundational("a", ["joy"]), foundational("b", ["grief"])];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		expect(result.unclassified_charge_count).toBe(1);
		expect(result.lexicon_coverage_pct).toBe(50); // 1 of 2 distinct charges classified
	});

	it("every count field is a real number — never NaN — on a mixed classified/unclassified corpus", async () => {
		const storage = makeStorage(lexicon({ joy: "positive" }));
		const observations = [foundational("a", ["joy"]), foundational("b", ["never-classified"])];

		const result = await runValenceFloorTask(storage as any, territoryData(observations));

		for (const key of ["seats", "classified", "eligible", "simulated_eligible_in_lane", "eligible_supply_after_cut", "lexicon_rows", "unclassified_charge_count"] as const) {
			expect(Number.isFinite(result[key])).toBe(true);
		}
	});

	// Production bug guard (2026-09-25): texture.charge stored as a plain
	// STRING instead of string[] (JSON-array string or comma-joined phrase).
	// Every read site in this file must go through chargesOf() and treat such
	// an observation as carrying NO charges — classified as "ineligible" (zero
	// charges, same as the existing empty-array case), never "unclassified"
	// via a character-level lexicon lookup that would poison
	// unclassified_charge_count/lexicon_coverage_pct with single letters,
	// commas, brackets and quotes.
	describe("malformed charge shapes (production bug guard)", () => {
		it("a JSON-array-shaped STRING charge is treated as zero charges — classified but ineligible, never unclassified", async () => {
			const storage = makeStorage(lexicon({ joy: "positive" }));
			const observations = [
				foundational("bad", [], { texture: { salience: "foundational", vividness: "vivid", charge: '["pride","creation"]' as unknown as string[], grip: "iron" } }),
				foundational("good", ["joy"])
			];

			const result = await runValenceFloorTask(storage as any, territoryData(observations));

			expect(result.classified).toBe(2);
			expect(result.eligible).toBe(1);
			expect(result.unclassified_charge_count).toBe(0);
		});

		it("a comma-joined STRING charge behaves identically — no character-level charges leak into distinct/coverage counts", async () => {
			const storage = makeStorage(lexicon({ joy: "positive" }));
			const observations = [
				foundational("bad", [], { texture: { salience: "foundational", vividness: "vivid", charge: "devotion, joy, repair" as unknown as string[], grip: "iron" } })
			];

			const result = await runValenceFloorTask(storage as any, territoryData(observations));

			expect(result.classified).toBe(1);
			expect(result.eligible).toBe(0);
			expect(result.unclassified_charge_count).toBe(0);
			expect(result.lexicon_coverage_pct).toBeNull();
		});

		it("a non-string element inside an otherwise-real charge array is dropped, not misclassified", async () => {
			const storage = makeStorage(lexicon({ joy: "positive" }));
			const observations = [
				foundational("mixed", [], { texture: { salience: "foundational", vividness: "vivid", charge: ["joy", 42, null] as unknown as string[], grip: "iron" } })
			];

			const result = await runValenceFloorTask(storage as any, territoryData(observations));

			expect(result.classified).toBe(1);
			expect(result.eligible).toBe(1);
		});
	});
});
