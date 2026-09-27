import { describe, expect, it } from "vitest";
import {
	extractQuerySignals,
	computeQuerySignalBoosts,
	computeQuerySignalBoostsFused,
	computeSignalDocumentFrequency,
	getRetrievalProfileConfig,
	normalizeRetrievalProfile,
	validateProfileOverrides,
	validateRetrievalProfileConfigs,
	RETRIEVAL_PROFILE_CONFIGS,
	type SignalIdfStats
} from "../src/retrieval/query-signals";

describe("retrieval query signals", () => {
	it("extracts quoted phrases, proper names, temporal cues, and assistant references", () => {
		const signals = extractQuerySignals('What did you say about "memory palace" to Mira in March 2026?');

		expect(signals.quoted_phrases).toContain("memory palace");
		expect(signals.proper_names).toContain("Mira");
		expect(signals.temporal.has_temporal_cue).toBe(true);
		expect(signals.temporal.months).toContain(3);
		expect(signals.temporal.years).toContain(2026);
		expect(signals.assistant_reference.detected).toBe(true);
	});

	it("computes heuristic boosts for matching observations", () => {
		const signals = extractQuerySignals('What did you say about "memory palace" to Mira in March 2026?');
		const profile = getRetrievalProfileConfig("fused");

		const boost = computeQuerySignalBoosts(signals, {
			content: "Assistant: We discussed memory palace methods with Mira yesterday.",
			context: "assistant response",
			type: "assistant_response",
			created: "2026-03-12T10:00:00.000Z",
			tags: ["assistant", "response"]
		}, profile.query_signal_boosts, Date.parse("2026-03-14T00:00:00.000Z"));

		expect(boost.total_boost).toBeGreaterThan(0);
		expect(boost.quoted_phrase_matches).toContain("memory palace");
		expect(boost.proper_name_matches).toContain("Mira");
		expect(boost.temporal_matched).toBe(true);
		expect(boost.assistant_reference_matched).toBe(true);
	});

	it("normalizes retrieval profile values — native/balanced/benchmark are frozen aliases of fused", () => {
		expect(normalizeRetrievalProfile("NATIVE")).toBe("fused");
		expect(normalizeRetrievalProfile("balanced")).toBe("fused");
		expect(normalizeRetrievalProfile("benchmark")).toBe("fused");
		expect(normalizeRetrievalProfile("fused")).toBe("fused");
		expect(normalizeRetrievalProfile("flat")).toBe("flat");
		expect(normalizeRetrievalProfile("legacy")).toBe("legacy");
		expect(normalizeRetrievalProfile("weird-profile")).toBeUndefined();
	});

	it("every RETRIEVAL_PROFILE_CONFIGS entry satisfies its own config invariants (Fischer LOW)", () => {
		for (const config of Object.values(RETRIEVAL_PROFILE_CONFIGS)) {
			const sum = config.lane_weights.vector + config.lane_weights.keyword
				+ config.lane_weights.entity + config.lane_weights.hint;
			expect(sum, `${config.name}.lane_weights must sum to 1`).toBeCloseTo(1, 6);
			expect(config.rrf_k, `${config.name}.rrf_k must be >= 1`).toBeGreaterThanOrEqual(1);
			expect(config.min_score, `${config.name}.min_score must be in [0,1]`).toBeGreaterThanOrEqual(0);
			expect(config.min_score, `${config.name}.min_score must be in [0,1]`).toBeLessThanOrEqual(1);
		}
	});

	it("validateRetrievalProfileConfigs passes the real shipped configs and throws (naming the profile) on a malformed layer_b_cap (Fischer LOW 85)", () => {
		expect(() => validateRetrievalProfileConfigs(RETRIEVAL_PROFILE_CONFIGS)).not.toThrow();

		const base = getRetrievalProfileConfig("fused");
		expect(() => validateRetrievalProfileConfigs({ fused: { ...base, layer_b_cap: { min: 1.1, max: 0.9 } } }))
			.toThrow(/fused/);
		expect(() => validateRetrievalProfileConfigs({ fused: { ...base, layer_b_cap: { min: 0, max: 1.1 } } }))
			.toThrow(/fused/);
		expect(() => validateRetrievalProfileConfigs({ fused: { ...base, layer_b_cap: { min: Number.NaN, max: 1.1 } } }))
			.toThrow(/fused/);
	});
});

describe("validateProfileOverrides (the one definition of valid for profile_overrides)", () => {
	it("accepts a well-formed rrf_k and lane_weights override", () => {
		expect(() => validateProfileOverrides({
			rrf_k: 20,
			lane_weights: { vector: 0.5, keyword: 0.4, entity: 0.05, hint: 0.05 }
		})).not.toThrow();
	});

	it("accepts an empty override (both fields optional)", () => {
		expect(() => validateProfileOverrides({})).not.toThrow();
	});

	it("rejects rrf_k outside [1,500] or non-finite", () => {
		expect(() => validateProfileOverrides({ rrf_k: 0 })).toThrow(/rrf_k/);
		expect(() => validateProfileOverrides({ rrf_k: 501 })).toThrow(/rrf_k/);
		expect(() => validateProfileOverrides({ rrf_k: Number.NaN })).toThrow(/rrf_k/);
	});

	it("rejects lane_weights missing a required key", () => {
		expect(() => validateProfileOverrides({
			lane_weights: { vector: 0.7, keyword: 0.3 } as never
		})).toThrow(/exactly the four keys/);
	});

	it("rejects lane_weights carrying an unexpected extra key (a malformed caller object, not a real four-lane weight map)", () => {
		expect(() => validateProfileOverrides({
			lane_weights: { vector: 0.5, keyword: 0.3, entity: 0.1, hint: 0.1, surprise: 0 } as never
		})).toThrow(/exactly the four keys/);
	});

	it("rejects a lane_weights entry outside [0,1]", () => {
		expect(() => validateProfileOverrides({
			lane_weights: { vector: 1.5, keyword: 0.3, entity: 0.1, hint: 0.1 }
		})).toThrow(/vector/);
	});

	it("rejects lane_weights that don't sum to 1", () => {
		expect(() => validateProfileOverrides({
			lane_weights: { vector: 0.5, keyword: 0.5, entity: 0.5, hint: 0.5 }
		})).toThrow(/sum to 1/);
	});

	it("tolerates float rounding within ±0.001 of summing to 1", () => {
		expect(() => validateProfileOverrides({
			lane_weights: { vector: 0.33, keyword: 0.33, entity: 0.33, hint: 0.01 }
		})).not.toThrow();
	});
});

// ============ IDF-WEIGHTED SIGNAL BOOSTS — fused only (ADR-RETRIEVAL-FUSION-RETUNE §3) ============

describe("computeSignalDocumentFrequency + computeQuerySignalBoostsFused", () => {
	const FUSED_SIGNAL_CONFIG = getRetrievalProfileConfig("fused").query_signal_boosts;

	it("idf weight decays to ~0 when every candidate in the set matches the signal (case-006 shape)", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const observations = [
			{ content: "Mira said hi" },
			{ content: "talked to Mira again" },
			{ content: "Mira replied yesterday" }
		];
		const signal_df = computeSignalDocumentFrequency(signals, observations, FUSED_SIGNAL_CONFIG);
		expect(signal_df.proper_name).toBe(3);

		const stats: SignalIdfStats = { candidate_count: 3, signal_df };
		const boost = computeQuerySignalBoostsFused(signals, observations[0], FUSED_SIGNAL_CONFIG, stats);
		expect(boost.signal_idf.proper_name).toBeCloseTo(0, 10);
		expect(boost.total_boost).toBeCloseTo(0, 10);
	});

	it("idf weight is the full config weight when exactly one candidate in the set matches", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const stats: SignalIdfStats = {
			candidate_count: 10,
			signal_df: { quoted_phrase: 0, proper_name: 1, temporal: 0, assistant_reference: 0 }
		};
		const boost = computeQuerySignalBoostsFused(signals, { content: "Mira said hi" }, FUSED_SIGNAL_CONFIG, stats);
		// idf_w = 1 - 1/10 = 0.9
		expect(boost.signal_idf.proper_name).toBeCloseTo(FUSED_SIGNAL_CONFIG.proper_name * 0.9, 10);
		expect(boost.total_boost).toBeCloseTo(FUSED_SIGNAL_CONFIG.proper_name * 0.9, 10);
	});

	it("caps total_boost at config.max_total when multiple signals stack, even at full idf weight", () => {
		const signals = extractQuerySignals('What did you say about "memory palace" to Mira in March 2026?');
		const uncappedSum = FUSED_SIGNAL_CONFIG.quoted_phrase + FUSED_SIGNAL_CONFIG.proper_name
			+ FUSED_SIGNAL_CONFIG.temporal + FUSED_SIGNAL_CONFIG.assistant_reference;
		expect(uncappedSum).toBeGreaterThan(FUSED_SIGNAL_CONFIG.max_total);

		// candidate_count 1, zero df -> idf_w = 1 for every signal -> maximum possible stacking.
		const stats: SignalIdfStats = {
			candidate_count: 1,
			signal_df: { quoted_phrase: 0, proper_name: 0, temporal: 0, assistant_reference: 0 }
		};
		const boost = computeQuerySignalBoostsFused(signals, {
			content: "Assistant: We discussed memory palace methods with Mira yesterday.",
			context: "assistant response",
			type: "assistant_response",
			created: "2026-03-12T10:00:00.000Z",
			tags: ["assistant", "response"]
		}, FUSED_SIGNAL_CONFIG, stats, Date.parse("2026-03-14T00:00:00.000Z"));
		expect(boost.total_boost).toBeCloseTo(FUSED_SIGNAL_CONFIG.max_total, 10);
	});

	it("does not multiply by match_count — repeating a proper name in one observation is not extra evidence (ADR §3 'drop the × match_count')", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const stats: SignalIdfStats = {
			candidate_count: 10,
			signal_df: { quoted_phrase: 0, proper_name: 1, temporal: 0, assistant_reference: 0 }
		};
		const once = computeQuerySignalBoostsFused(signals, { content: "Mira said hi" }, FUSED_SIGNAL_CONFIG, stats);
		const repeatedFiveTimes = computeQuerySignalBoostsFused(
			signals,
			{ content: "Mira Mira Mira Mira Mira said hi" },
			FUSED_SIGNAL_CONFIG,
			stats
		);
		expect(repeatedFiveTimes.total_boost).toBeCloseTo(once.total_boost, 10);
	});

	it("applies zero boost when stats is omitted, even with a real matching signal (Reeve MEDIUM 90: conservative default, not the un-discounted ceiling)", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const boost = computeQuerySignalBoostsFused(signals, { content: "Mira said hi" }, FUSED_SIGNAL_CONFIG);
		// Match detection still runs (it's used for match_sources) — only the
		// weighting collapses to zero without candidate-set statistics.
		expect(boost.proper_name_matches).toContain("Mira");
		expect(boost.signal_idf.quoted_phrase).toBe(0);
		expect(boost.signal_idf.proper_name).toBe(0);
		expect(boost.signal_idf.temporal).toBe(0);
		expect(boost.signal_idf.assistant_reference).toBe(0);
		expect(boost.total_boost).toBe(0);
	});
});

// ============ SENTENCE-INITIAL PROPER-NAME FILTERING (ADR §3) ============

describe("extractQuerySignals — sentence-initial proper-name filtering", () => {
	it("drops a sentence-initial discourse-filler word used only once", () => {
		expect(extractQuerySignals("Yeah this is what my debt advisor said about the plan").proper_names)
			.not.toContain("Yeah");
		expect(extractQuerySignals("Okay so what happened next?").proper_names)
			.not.toContain("Okay");
	});

	it("keeps a sentence-initial real name even at position 0 (not in the filler set)", () => {
		expect(extractQuerySignals("Falco said we should try again.").proper_names).toContain("Falco");
	});

	it("leaves a non-sentence-initial capitalized word untouched", () => {
		// "wait," between "But" and "Hetzner" keeps them as two separate regex matches
		// (adjacent capitalized words glob into one match — a separate, pre-existing
		// quirk of the extractor unrelated to this fix) so this isolates the rule
		// under test: "Hetzner" isn't sentence-initial, so it's never even considered.
		expect(extractQuerySignals("But wait, Hetzner is down again.").proper_names).toContain("Hetzner");
	});

	it("keeps a sentence-initial filler word when it recurs capitalized elsewhere in the query", () => {
		const signals = extractQuerySignals("Well, ask Well about it.");
		expect(signals.proper_names).toContain("Well");
	});
});
