import { describe, expect, it } from "vitest";
import type { Observation } from "../src/types";
import {
	extractQuerySignals,
	getRetrievalProfileConfig,
	type RetrievalProfileConfig,
	type SignalIdfStats
} from "../src/retrieval/query-signals";
import { scoreHybridCandidate, scoreHybridCandidateLegacy } from "../src/retrieval/scoring";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: overrides.id ?? "obs_score",
		content: overrides.content ?? "Assistant: memory palace notes for Mira",
		territory: overrides.territory ?? "craft",
		created: overrides.created ?? "2026-04-09T06:30:00.000Z",
		texture: overrides.texture ?? {
			salience: "active",
			vividness: "vivid",
			charge: [],
			grip: "present",
			charge_phase: "fresh"
		},
		access_count: overrides.access_count ?? 0,
		context: overrides.context,
		mood: overrides.mood,
		last_accessed: overrides.last_accessed,
		links: overrides.links,
		summary: overrides.summary,
		type: overrides.type,
		tags: overrides.tags,
		entity_id: overrides.entity_id
	};
}

// ============ LEGACY SCORER — frozen, pre-RRF (ADR-RETRIEVAL-FUSION-RETUNE §9/§12) ============
// Unchanged numbers from the pre-retune scorer, relocated to scoreHybridCandidateLegacy.
// retrieval_profile: "legacy" routes here in production; these tests still exercise
// native/balanced/benchmark directly since the legacy config map keeps all four frozen.

describe("retrieval scoring — legacy (frozen, pre-RRF)", () => {
	it("keeps keyword-only candidates alive when keyword normalization collapses to zero", () => {
		const observation = makeObservation({
			content: "plain keyword match",
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: [],
				grip: "present",
				charge_phase: "processing"
			}
		});

		const scored = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "native",
			query_signals: extractQuerySignals("plain keyword"),
			keyword_rank: 0,
			max_keyword_rank: 0,
			min_similarity: 0.3
		});

		expect(scored).not.toBeNull();
		expect(scored?.match_sources).toContain("keyword");
		expect(scored?.score_breakdown.layer_a.keyword_component).toBe(0.35);
	});

	it("separates Layer A relevance from Layer B cognition in the breakdown", () => {
		const observation = makeObservation({
			type: "assistant_response",
			tags: ["assistant"],
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: ["clarity"],
				grip: "iron",
				charge_phase: "fresh",
				novelty_score: 0.9
			}
		});

		const scored = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "balanced",
			query_signals: extractQuerySignals('What did you say about "memory palace" to Mira in April 2026?'),
			vector_similarity: 0.7,
			keyword_rank: 0.8,
			max_keyword_rank: 1,
			entity_matched: true,
			circadian_bias_matched: true,
			min_similarity: 0.01
		});

		expect(scored).not.toBeNull();
		expect(scored?.score_breakdown.layer_a.adjusted_relevance).toBeGreaterThan(
			scored?.score_breakdown.layer_a.base_relevance ?? 0
		);
		expect(scored?.score_breakdown.layer_b.base_multiplier).toBeGreaterThan(1);
		expect(scored?.score_breakdown.signals.quoted_phrase_matches).toContain("memory palace");
		expect(scored?.score_breakdown.signals.assistant_reference_matched).toBe(true);
	});

	it("reduces cognitive amplification in benchmark profile versus native", () => {
		const observation = makeObservation({
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: [],
				grip: "iron",
				charge_phase: "fresh",
				novelty_score: 0.9
			}
		});
		const signals = extractQuerySignals('What did you say about "memory palace"?');

		const native = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "native",
			query_signals: signals,
			vector_similarity: 0.6,
			max_keyword_rank: 0,
			circadian_bias_matched: true,
			min_similarity: 0.01
		});
		const benchmark = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "benchmark",
			query_signals: signals,
			vector_similarity: 0.6,
			max_keyword_rank: 0,
			circadian_bias_matched: true,
			min_similarity: 0.01
		});

		expect(native).not.toBeNull();
		expect(benchmark).not.toBeNull();
		expect(native?.score_breakdown.layer_b.weighted_multiplier).toBeGreaterThan(
			benchmark?.score_breakdown.layer_b.weighted_multiplier ?? 0
		);
	});

	it("applies profile-specific hint component scaling", () => {
		const observation = makeObservation({
			content: "quiet note with no direct keyword overlap",
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: [],
				grip: "present",
				charge_phase: "processing"
			}
		});
		const signals = extractQuerySignals("april memory");

		const native = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "native",
			query_signals: signals,
			hint_score: 1,
			max_keyword_rank: 0,
			min_similarity: 0.01
		});
		const benchmark = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "benchmark",
			query_signals: signals,
			hint_score: 1,
			max_keyword_rank: 0,
			min_similarity: 0.01
		});

		expect(native).not.toBeNull();
		expect(benchmark).not.toBeNull();
		expect((benchmark?.score_breakdown.layer_a.hint_component ?? 0)).toBeGreaterThan(
			native?.score_breakdown.layer_a.hint_component ?? 0
		);
	});

	it("defaults min_similarity to 0.3 when omitted (band migration, ADR §1: legacy keeps 0.3)", () => {
		const observation = makeObservation({
			texture: {
				salience: "active",
				vividness: "vivid",
				charge: [],
				grip: "present",
				charge_phase: "processing"
			}
		});
		// vector-only, cosine 0.2 -> baseRelevance = 0.2 (no keyword mix applied),
		// comfortably below the 0.3 default and above 0 — a real, non-null score
		// that only the default threshold filters.
		const scored = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "legacy",
			query_signals: extractQuerySignals("no overlap"),
			vector_similarity: 0.2,
			max_keyword_rank: 0
			// min_similarity omitted — must default to 0.3.
		});
		expect(scored).toBeNull();

		const explicitlyLowered = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "legacy",
			query_signals: extractQuerySignals("no overlap"),
			vector_similarity: 0.2,
			max_keyword_rank: 0,
			min_similarity: 0.01
		});
		expect(explicitlyLowered).not.toBeNull();
	});
});

// ============ NEW SCORER — weighted RRF over lane ranks (ADR §1) ============

const FUSED_CONFIG: RetrievalProfileConfig = getRetrievalProfileConfig("fused");
const NEUTRAL_TEXTURE: Observation["texture"] = {
	salience: "active",
	vividness: "vivid",
	charge: [],
	grip: "present",
	charge_phase: "processing"
};
const NO_SIGNALS = extractQuerySignals("");

function neutralObservation(overrides: Partial<Observation> = {}): Observation {
	return makeObservation({ texture: NEUTRAL_TEXTURE, ...overrides });
}

describe("retrieval scoring — RRF fusion (new default)", () => {
	it("I2: base_relevance stays within [0,1] across a spread of positions and pool sizes", () => {
		for (const k of [1, 5, 50, 500]) {
			for (const pos of [1, 2, 10, 100, 5000]) {
				const scored = scoreHybridCandidate({
					observation: neutralObservation(),
					territory: "craft",
					profile_config: { ...FUSED_CONFIG, rrf_k: k },
					query_signals: NO_SIGNALS,
					lane_positions: { vector: pos },
					min_score: 0
				});
				expect(scored).not.toBeNull();
				const base = scored!.score_breakdown.layer_a.base_relevance;
				expect(base).toBeGreaterThanOrEqual(0);
				expect(base).toBeLessThanOrEqual(1);
			}
		}
	});

	it("rank 1 in every lane sums to base_relevance 1.0 (ADR §1: '1.0 == rank 1 in every lane')", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 1, keyword: 1, entity: 1, hint: 1 },
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_a.base_relevance).toBeCloseTo(1.0, 10);
	});

	it("I4: rank-1 in a single lane scores exactly that lane's weight", () => {
		const cases: Array<["vector" | "keyword" | "entity" | "hint", number]> = [
			["vector", FUSED_CONFIG.lane_weights.vector],
			["keyword", FUSED_CONFIG.lane_weights.keyword],
			["entity", FUSED_CONFIG.lane_weights.entity],
			["hint", FUSED_CONFIG.lane_weights.hint]
		];
		for (const [lane, weight] of cases) {
			const scored = scoreHybridCandidate({
				observation: neutralObservation(),
				territory: "craft",
				profile_config: FUSED_CONFIG,
				query_signals: NO_SIGNALS,
				lane_positions: { [lane]: 1 },
				min_score: 0
			});
			expect(scored).not.toBeNull();
			expect(scored!.score_breakdown.layer_a.base_relevance).toBeCloseTo(weight, 10);
		}
	});

	it("I1: adding a lane never lowers the score (monotone in lane presence)", () => {
		const vectorOnly = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			min_score: 0
		});
		const vectorPlusKeyword = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5, keyword: 40 },
			min_score: 0
		});
		expect(vectorOnly).not.toBeNull();
		expect(vectorPlusKeyword).not.toBeNull();
		expect(vectorPlusKeyword!.score).toBeGreaterThanOrEqual(vectorOnly!.score);

		// Adding a weak/deep lane match must never punish a strong single-lane hit —
		// this is the actual bug ADR-RETRIEVAL-FUSION-RETUNE §1 is fixing.
		const vectorPlusDeepKeyword = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 1, keyword: 500 },
			min_score: 0
		});
		const vectorAlone = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 1 },
			min_score: 0
		});
		expect(vectorPlusDeepKeyword!.score).toBeGreaterThanOrEqual(vectorAlone!.score);
	});

	it("I3: intra-lane order is preserved — a better vector position outranks a worse one", () => {
		const better = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_better" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 2 },
			min_score: 0
		});
		const worse = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_worse" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 40 },
			min_score: 0
		});
		expect(better!.score).toBeGreaterThan(worse!.score);
	});

	it("worked example from ADR §1: vec#2+kw#1 (0.871) beats vec#1+kw#15 (0.818) at K=60", () => {
		// The ADR's example is stated at its starting values (K 60, vector .55 / keyword .33),
		// not at whatever the live fused default is after the golden sweep — pin them here.
		const ADR_EXAMPLE_CONFIG = {
			...FUSED_CONFIG,
			rrf_k: 60,
			lane_weights: { vector: 0.55, keyword: 0.33, entity: 0.07, hint: 0.05 }
		};
		const consensus = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_consensus" }),
			territory: "craft",
			profile_config: ADR_EXAMPLE_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 2, keyword: 1 },
			min_score: 0
		});
		const vectorOnlyTop = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_vector_top" }),
			territory: "craft",
			profile_config: ADR_EXAMPLE_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 1, keyword: 15 },
			min_score: 0
		});
		expect(consensus).not.toBeNull();
		expect(vectorOnlyTop).not.toBeNull();
		expect(consensus!.score_breakdown.layer_a.base_relevance).toBeCloseTo(0.871, 3);
		expect(vectorOnlyTop!.score_breakdown.layer_a.base_relevance).toBeCloseTo(0.818, 3);
		expect(consensus!.score).toBeGreaterThan(vectorOnlyTop!.score);
	});

	it("an absent lane contributes 0 — no lanes present scores 0 and is dropped by min_score", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: {},
			min_score: 0.0001
		});
		expect(scored).toBeNull();
	});

	it("tags score_breakdown.profile with the resolved profile config name, and keeps magnitudes as diagnostics only", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 3 },
			vector_similarity: 0.42,
			keyword_ts_rank: 0.9,
			min_score: 0
		});
		expect(scored?.score_breakdown.profile).toBe("fused");
		expect(scored?.score_breakdown.layer_a.vector_similarity).toBeCloseTo(0.42, 5);
		expect(scored?.score_breakdown.layer_a.keyword_ts_rank).toBeCloseTo(0.9, 5);
		expect(scored?.score_breakdown.layer_a.vector_position).toBe(3);
		expect(scored?.score_breakdown.layer_a.keyword_position).toBeNull();
	});

	it("min_score threshold: candidate scoring below the floor is dropped, at/above it survives", () => {
		// entity alone at rank 1 scores exactly lane_weights.entity (0.07 for fused).
		const belowFloor = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { entity: 1 },
			min_score: 0.5
		});
		const atFloor = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { entity: 1 },
			min_score: FUSED_CONFIG.lane_weights.entity
		});
		expect(belowFloor).toBeNull();
		expect(atFloor).not.toBeNull();
	});

	it("defaults the threshold to profile_config.min_score when min_score is omitted", () => {
		const veryDeep = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { hint: 4990 }
			// no min_score passed — falls back to FUSED_CONFIG.min_score (0.02)
		});
		expect(veryDeep).toBeNull();
	});

	// ---- Scorer guards (Fischer MEDIUM 85 + Michael LOW) ----
	// "positions are 1-based by construction in both backends; this guard is the
	// trust boundary, not the CLI" — a malformed rrf_k or lane position must never
	// blow up the formula or silently corrupt the RRF sum.

	it("rrf_k 0 or negative behaves as K=1, not as a broken/inverted denominator", () => {
		const asConfigured = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: { ...FUSED_CONFIG, rrf_k: 1 },
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 3 },
			min_score: 0
		});
		for (const badK of [0, -5]) {
			const scored = scoreHybridCandidate({
				observation: neutralObservation(),
				territory: "craft",
				profile_config: { ...FUSED_CONFIG, rrf_k: badK },
				query_signals: NO_SIGNALS,
				lane_positions: { vector: 3 },
				min_score: 0
			});
			expect(scored).not.toBeNull();
			expect(scored!.score_breakdown.layer_a.base_relevance).toBeCloseTo(
				asConfigured!.score_breakdown.layer_a.base_relevance,
				10
			);
		}
	});

	it("a non-finite rrf_k (NaN) falls back to the K=60 default", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: { ...FUSED_CONFIG, rrf_k: Number.NaN },
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 3 },
			min_score: 0
		});
		const defaultK = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: { ...FUSED_CONFIG, rrf_k: 60 },
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 3 },
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_a.base_relevance).toBeCloseTo(
			defaultK!.score_breakdown.layer_a.base_relevance,
			10
		);
	});

	it("an invalid lane position (0, -1, NaN) is treated as absent — score equals the other lanes alone", () => {
		const otherLanesAlone = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { keyword: 4 },
			min_score: 0
		});
		expect(otherLanesAlone).not.toBeNull();

		for (const badPosition of [0, -1, Number.NaN]) {
			const scored = scoreHybridCandidate({
				observation: neutralObservation(),
				territory: "craft",
				profile_config: FUSED_CONFIG,
				query_signals: NO_SIGNALS,
				lane_positions: { vector: badPosition, keyword: 4 },
				min_score: 0
			});
			expect(scored).not.toBeNull();
			expect(scored!.score).toBeCloseTo(otherLanesAlone!.score, 10);
			expect(scored!.score_breakdown.layer_a.vector_position).toBeNull();
			expect(scored!.match_sources).not.toContain("vector");
		}
	});
});

// ============ LAYER B CLAMP (ADR-RETRIEVAL-FUSION-RETUNE §2) ============

describe("retrieval scoring — Layer B multiplier clamp (fused only)", () => {
	const IRON_FRESH_NOVEL_TEXTURE: Observation["texture"] = {
		salience: "active",
		vividness: "vivid",
		charge: [],
		grip: "iron",
		charge_phase: "fresh",
		novelty_score: 0.95
	};
	const DORMANT_METABOLIZED_TEXTURE: Observation["texture"] = {
		salience: "background",
		vividness: "faint",
		charge: [],
		grip: "dormant",
		charge_phase: "metabolized"
	};

	it("clamps a high-end multiplier (iron/fresh/novel/circadian) to the configured max and reports both values", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ texture: IRON_FRESH_NOVEL_TEXTURE }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			circadian_bias_matched: true,
			min_score: 0
		});
		expect(scored).not.toBeNull();
		// Uncapped this combo is 1.3 * 1.3 * 1.225 * 1.15 ≈ 2.38 — comfortably above the cap.
		expect(scored!.score_breakdown.layer_b.base_multiplier).toBeGreaterThan(FUSED_CONFIG.layer_b_cap.max);
		expect(scored!.score_breakdown.layer_b.capped_multiplier).toBeCloseTo(FUSED_CONFIG.layer_b_cap.max, 10);
	});

	it("clamps a low-end multiplier (dormant/metabolized) up to the configured min and reports both values", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ texture: DORMANT_METABOLIZED_TEXTURE }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			min_score: 0
		});
		expect(scored).not.toBeNull();
		// 0.7 * 0.85 * 1.0 * 1.0 = 0.595 — comfortably below the cap.
		expect(scored!.score_breakdown.layer_b.base_multiplier).toBeLessThan(FUSED_CONFIG.layer_b_cap.min);
		expect(scored!.score_breakdown.layer_b.capped_multiplier).toBeCloseTo(FUSED_CONFIG.layer_b_cap.min, 10);
	});

	it("respects a narrowed layer_b_cap from profile_config — clamp bounds are config, not a hardcoded constant", () => {
		const NARROW_CAP_CONFIG: RetrievalProfileConfig = {
			...FUSED_CONFIG,
			layer_b_cap: { min: 0.99, max: 1.01 }
		};
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ texture: IRON_FRESH_NOVEL_TEXTURE }),
			territory: "craft",
			profile_config: NARROW_CAP_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			circadian_bias_matched: true,
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_b.capped_multiplier).toBeCloseTo(1.01, 10);
	});

	it("an iron/fresh/novel/circadian-matched candidate two fused ranks below cannot overtake the candidate above it — the actual bug being fixed", () => {
		const higherRank = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_top" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 1 },
			min_score: 0
		});
		const twoRanksBelowMaxedOutLayerB = scoreHybridCandidate({
			observation: neutralObservation({ id: "obs_hub", texture: IRON_FRESH_NOVEL_TEXTURE }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 3 },
			circadian_bias_matched: true,
			min_score: 0
		});
		expect(higherRank).not.toBeNull();
		expect(twoRanksBelowMaxedOutLayerB).not.toBeNull();
		// Pre-clamp this hub candidate would have won (2.38x vs 1.0x on a base_relevance
		// gap of ~9.5%). Capped at 1.10x weighted by cognition 0.8 (max +8%), it cannot.
		expect(twoRanksBelowMaxedOutLayerB!.score).toBeLessThan(higherRank!.score);
	});

	it("does not change the legacy scorer's uncapped Layer B behavior — layerBMultiplier stays shared and unmodified", () => {
		// scoreHybridCandidateLegacy's own tests (above) already pin its numbers; this
		// is an explicit cross-check that an iron/fresh/novel/circadian combo still
		// produces the pre-retune uncapped multiplier (~2.38x) through the legacy path.
		const observation = makeObservation({ texture: IRON_FRESH_NOVEL_TEXTURE });
		const scored = scoreHybridCandidateLegacy({
			observation,
			territory: "craft",
			retrieval_profile: "legacy",
			query_signals: extractQuerySignals("no overlap"),
			vector_similarity: 0.5,
			max_keyword_rank: 0,
			circadian_bias_matched: true,
			min_similarity: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_b.base_multiplier).toBeGreaterThan(FUSED_CONFIG.layer_b_cap.max);
		expect(scored!.score_breakdown.layer_b.weighted_multiplier).toBeCloseTo(
			scored!.score_breakdown.layer_b.base_multiplier,
			10
		); // legacy's native layer_weights.cognition is 1.0 — weighted == base, uncapped.
	});
});

// ============ B1 FIX — the novelty_score COLUMN feeds this multiplier (ops/ADR-JANITOR
// novelty-dimension fix). Postgres's hybridSearch passes the candidate's raw
// `novelty_score` DB column value as the `novelty_score` input field below —
// independent of (and read before falling back to) observation.texture.novelty_score.
// Before the fix, every row's column sat at the schema DEFAULT (0.5), so this input
// was always 0.5 no matter what the texture blob said, and the >0.7 gate never fired.
// See test/postgres-novelty-score-write.spec.ts for the write-side half — this is the
// read-side half of the same round-trip. ============

describe("retrieval scoring — B1 fix: the candidate's novelty_score column value feeds the multiplier", () => {
	it("novelty_score=1.0 (the post-fix INSERT default, texture carries none) produces a novelty_multiplier > 1.0", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			novelty_score: 1.0,
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_b.novelty_multiplier).toBeGreaterThan(1.0);
	});

	it("novelty_score=0.5 (the pre-fix schema DEFAULT every observation was stuck at, forever) leaves the multiplier at exactly 1.0 — the defect this commit fixes", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation(),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			novelty_score: 0.5,
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_b.novelty_multiplier).toBe(1.0);
	});

	it("an absent novelty_score input falls back to observation.texture.novelty_score before the 0.5 floor", () => {
		const scored = scoreHybridCandidate({
			observation: neutralObservation({
				texture: { salience: "active", vividness: "vivid", charge: [], grip: "present", charge_phase: "processing", novelty_score: 0.95 }
			}),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: NO_SIGNALS,
			lane_positions: { vector: 5 },
			min_score: 0
			// novelty_score input omitted on purpose — texture is the fallback.
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_b.novelty_multiplier).toBeGreaterThan(1.0);
	});
});

// ============ IDF-WEIGHTED SIGNAL BOOSTS — scoreHybridCandidate wiring (ADR §3) ============

describe("retrieval scoring — IDF-weighted signal boosts reach scoreHybridCandidate's stats param", () => {
	it("a signal_idf near zero (matches the whole set) produces a near-zero signal_boost in score_breakdown", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const stats: SignalIdfStats = {
			candidate_count: 3,
			signal_df: { quoted_phrase: 0, proper_name: 3, temporal: 0, assistant_reference: 0 }
		};
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ content: "Mira said hi" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: signals,
			lane_positions: { vector: 5 },
			min_score: 0
		}, stats);
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_a.signal_idf.proper_name).toBeCloseTo(0, 10);
		expect(scored!.score_breakdown.layer_a.signal_boost).toBeCloseTo(0, 10);
	});

	it("a signal matched by only one of ten candidates keeps close to its full config weight", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const stats: SignalIdfStats = {
			candidate_count: 10,
			signal_df: { quoted_phrase: 0, proper_name: 1, temporal: 0, assistant_reference: 0 }
		};
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ content: "Mira said hi" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: signals,
			lane_positions: { vector: 5 },
			min_score: 0
		}, stats);
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_a.signal_boost).toBeCloseTo(FUSED_CONFIG.query_signal_boosts.proper_name * 0.9, 10);
	});

	it("omitting stats falls back to zero boost rather than throwing (Reeve MEDIUM 90: conservative default)", () => {
		const signals = extractQuerySignals("please tell me about Mira");
		const scored = scoreHybridCandidate({
			observation: neutralObservation({ content: "Mira said hi" }),
			territory: "craft",
			profile_config: FUSED_CONFIG,
			query_signals: signals,
			lane_positions: { vector: 5 },
			min_score: 0
		});
		expect(scored).not.toBeNull();
		expect(scored!.score_breakdown.layer_a.signal_boost).toBe(0);
		expect(scored!.score_breakdown.layer_a.signal_idf.proper_name).toBe(0);
		// match_sources still records the match itself — only the score weighting is zeroed.
		expect(scored!.match_sources).toContain("proper_name");
	});
});
