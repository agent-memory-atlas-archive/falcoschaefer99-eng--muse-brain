// ============ RETRIEVAL SCORING ============
// Pure scoring helpers shared by postgres/sqlite hybridSearch implementations.
//
// Two scorers live here:
//   - scoreHybridCandidate       — RRF fusion over lane ranks (ADR-RETRIEVAL-FUSION-RETUNE §1). Default.
//   - scoreHybridCandidateLegacy — the frozen pre-RRF scorer. Kill switch: retrieval_profile
//     "legacy" routes here, unchanged logic, unchanged numbers. Delete NOT BEFORE 2026-10-05
//     AND not before the first public release carrying "fused" has dogfooded ≥ 1 daemon
//     night on our own worker (ADR §9/§12; pinned at the LEGACY SCORER block below).

import type { Observation } from "../types";
import {
	computeQuerySignalBoosts,
	computeQuerySignalBoostsFused,
	getRetrievalProfileConfig,
	normalizeRetrievalProfile,
	DEFAULT_RETRIEVAL_PROFILE,
	type QuerySignalBoostConfig,
	type QuerySignalIdfWeights,
	type QuerySignals,
	type RetrievalProfile,
	type RetrievalProfileConfig,
	type SignalDocumentFrequency,
	type SignalIdfStats
} from "./query-signals";
import { clamp } from "./utils";

/**
 * Full candidate-set stats for one hybridSearch call (ADR-RETRIEVAL-FUSION-RETUNE
 * §3 "Implementation seam") — postgres.ts/sqlite.ts build one of these once per
 * call, replacing/extending the old maxKeywordRank-only pre-pass, and pass it
 * into scoreHybridCandidate below. lane_sizes is a caller-side diagnostic the
 * scorer itself never reads; SignalIdfStats (candidate_count + signal_df) is
 * the structural subset the scorer actually needs — this type satisfies it.
 */
export interface CandidateSetStats {
	candidate_count: number;
	lane_sizes: { vector: number; keyword: number; entity: number; hint: number };
	signal_df: SignalDocumentFrequency;
}

const GRIP_MULTIPLIER: Record<string, number> = {
	iron: 1.3,
	strong: 1.15,
	present: 1.0,
	loose: 0.9,
	dormant: 0.7
};

const CHARGE_PHASE_MULTIPLIER: Record<string, number> = {
	fresh: 1.3,
	active: 1.15,
	processing: 1.0,
	metabolized: 0.85
};

function layerBMultiplier(observation: Observation, novelty_score: number | undefined, circadian_bias_matched: boolean) {
	const texture = observation.texture || {};
	const grip = texture.grip ?? "present";
	const chargePhase = texture.charge_phase ?? "processing";
	const noveltyScore = novelty_score ?? texture.novelty_score ?? 0.5;

	const gripMultiplier = GRIP_MULTIPLIER[grip] ?? 1.0;
	const chargePhaseMultiplier = CHARGE_PHASE_MULTIPLIER[chargePhase] ?? 1.0;
	const noveltyMultiplier = noveltyScore > 0.7 && chargePhase !== "metabolized"
		? 1 + (noveltyScore - 0.5) * 0.5
		: 1.0;
	const circadianMultiplier = circadian_bias_matched ? 1.15 : 1.0;
	const baseMultiplier = gripMultiplier * chargePhaseMultiplier * noveltyMultiplier * circadianMultiplier;

	return { gripMultiplier, chargePhaseMultiplier, noveltyMultiplier, circadianMultiplier, baseMultiplier };
}

// ============ SIGNALS (shared shape — identical on both scorers) ============

export interface HybridScoreSignals {
	quoted_phrases: string[];
	proper_names: string[];
	temporal_query: boolean;
	assistant_reference_query: boolean;
	emotional_state_query?: boolean;
	contradiction_query?: boolean;
	relational_query?: boolean;
	relational_intensity?: number;
	territory_cues?: string[];
	quoted_phrase_matches: string[];
	proper_name_matches: string[];
	temporal_matched: boolean;
	temporal_reasons: string[];
	assistant_reference_matched: boolean;
}

/** Structural subset shared by computeQuerySignalBoosts's QuerySignalMatch (legacy)
 * and computeQuerySignalBoostsFused's QuerySignalMatchFused (fused) — the only
 * fields buildSignalsBreakdown actually reads. Narrower than either return type
 * on purpose, so both scorers can call this one function without a union. */
interface SignalMatchDetection {
	quoted_phrase_matches: string[];
	proper_name_matches: string[];
	temporal_matched: boolean;
	temporal_reasons: string[];
	assistant_reference_matched: boolean;
}

function buildSignalsBreakdown(
	query_signals: QuerySignals,
	signalMatch: SignalMatchDetection
): HybridScoreSignals {
	return {
		quoted_phrases: query_signals.quoted_phrases,
		proper_names: query_signals.proper_names,
		temporal_query: query_signals.temporal.has_temporal_cue,
		assistant_reference_query: query_signals.assistant_reference.detected,
		quoted_phrase_matches: signalMatch.quoted_phrase_matches,
		proper_name_matches: signalMatch.proper_name_matches,
		temporal_matched: signalMatch.temporal_matched,
		temporal_reasons: signalMatch.temporal_reasons,
		assistant_reference_matched: signalMatch.assistant_reference_matched
	};
}

// ============ NEW SCORER — RRF fusion (ADR-RETRIEVAL-FUSION-RETUNE §1) ============

export interface HybridScoreBreakdown {
	profile: RetrievalProfile;
	layer_a: {
		/** Raw Σ w_lane / (K + position_lane), before the (K+1) normalization — diagnostic. */
		rrf_raw: number;
		/** (K+1) * rrf_raw — the fused relevance base, in [0,1]. Rank 1 in every lane == 1.0. */
		base_relevance: number;
		/** 1-based lane positions actually used by the formula — null when the lane didn't match.
		 * Named `*_position`, not `*_rank`, to avoid colliding with keyword_ts_rank below (a
		 * magnitude, not a position). */
		vector_position: number | null;
		keyword_position: number | null;
		entity_position: number | null;
		hint_position: number | null;
		/** Magnitudes — DIAGNOSTICS ONLY, never read by the scorer (ADR §1: "rank in, magnitude out"). */
		vector_similarity: number | null;
		keyword_ts_rank: number | null;
		signal_boost: number;
		/** Per-signal weight actually applied — cfg[s] * idf_w(s) (ADR §3). A value
		 * near zero means that signal matched almost the whole candidate set for
		 * this query and therefore carries no discriminating information. */
		signal_idf: QuerySignalIdfWeights;
		adjusted_relevance: number;
	};
	layer_b: {
		base_multiplier: number;
		/** grip × charge_phase × novelty × circadian, clamped to profile_config.layer_b_cap
		 * (ADR §2) — this is the value actually used in weighted_multiplier below.
		 * base_multiplier is kept alongside it as the honest, uncapped diagnostic. */
		capped_multiplier: number;
		grip_multiplier: number;
		charge_phase_multiplier: number;
		novelty_multiplier: number;
		circadian_multiplier: number;
		weighted_multiplier: number;
	};
	dynamic_weights?: {
		baseline: { relevance: number; cognition: number };
		modifiers: Array<Record<string, unknown>>;
		total_delta: { relevance: number; cognition: number };
		applied: { relevance: number; cognition: number };
	};
	signals: HybridScoreSignals;
	/** Attached by the rerank layer only — absent on a fresh scoring result. */
	rerank?: Record<string, unknown>;
}

export interface HybridCandidateScoreInput {
	observation: Observation;
	territory: string;
	/** Resolved (and possibly per-run overridden — see HybridSearchOptions.profile_overrides)
	 * profile config. The caller resolves this once per hybridSearch call, not per candidate. */
	profile_config: RetrievalProfileConfig;
	query_signals: QuerySignals;
	/** 1-based position within each lane's own ordered pool. Absent key == lane didn't return
	 * this candidate == that lane's RRF term is 0 (ADR §1 formula). */
	lane_positions: {
		vector?: number;
		keyword?: number;
		entity?: number;
		hint?: number;
	};
	/** Diagnostic only — never enters the score (ADR §1: "rank in, magnitude out"). */
	vector_similarity?: number;
	/** Diagnostic only — the raw ts_rank magnitude, not a position. */
	keyword_ts_rank?: number;
	novelty_score?: number;
	circadian_bias_matched?: boolean;
	/** Threshold below which a scored candidate is dropped. Defaults to profile_config.min_score
	 * — the caller (postgres.ts/sqlite.ts) resolves `options.min_similarity ?? profile_config.min_score`
	 * once and passes it through explicitly, matching how min_similarity always worked. */
	min_score?: number;
}

export interface HybridCandidateScoreResult {
	score: number;
	match_sources: string[];
	score_breakdown: HybridScoreBreakdown;
}

/** True only for a finite integer >= 1 — positions are 1-based by construction
 * in both backends (array index + 1 into an already-ordered pool), so anything
 * else reaching here (0, negative, NaN, non-integer) is a caller bug, not a
 * legitimate "matched at some rank" value. This guard is the trust boundary
 * for that invariant, not the CLI — a malformed position is treated exactly
 * like an absent lane (undefined), never fed into the RRF sum. */
function validLanePosition(position: number | undefined): number | undefined {
	return position !== undefined && Number.isFinite(position) && Number.isInteger(position) && position >= 1
		? position
		: undefined;
}

/**
 * `stats` is the candidate-set-statistics pre-pass (ADR §3 "Implementation seam")
 * — postgres.ts/sqlite.ts build one CandidateSetStats per hybridSearch call and
 * pass it through unchanged for every candidate in that call. Optional: when
 * omitted, computeQuerySignalBoostsFused falls back to applying NO signal boost
 * at all (see its own doc comment, Reeve MEDIUM 90) — safe for isolated/test use
 * of this pure function, never taken by either real backend.
 */
export function scoreHybridCandidate(
	input: HybridCandidateScoreInput,
	stats?: SignalIdfStats
): HybridCandidateScoreResult | null {
	const {
		observation,
		profile_config,
		query_signals,
		lane_positions,
		vector_similarity,
		keyword_ts_rank,
		novelty_score,
		circadian_bias_matched = false,
		min_score
	} = input;

	// A malformed rrf_k (0, negative, NaN) would blow up or invert the
	// (K + position) denominator; clamp to a minimum of 1 so the formula stays
	// well-defined without changing behavior for any legitimately-configured K
	// (every shipped profile uses 60).
	const K = Math.max(1, Number.isFinite(profile_config.rrf_k) ? profile_config.rrf_k : 60);
	const weights = profile_config.lane_weights;
	const matchSources: string[] = [];

	const vectorPosition = validLanePosition(lane_positions.vector);
	const keywordPosition = validLanePosition(lane_positions.keyword);
	const entityPosition = validLanePosition(lane_positions.entity);
	const hintPosition = validLanePosition(lane_positions.hint);

	let rrfRaw = 0;
	if (vectorPosition !== undefined) {
		rrfRaw += weights.vector / (K + vectorPosition);
		matchSources.push("vector");
	}
	if (keywordPosition !== undefined) {
		rrfRaw += weights.keyword / (K + keywordPosition);
		matchSources.push("keyword");
	}
	if (entityPosition !== undefined) {
		rrfRaw += weights.entity / (K + entityPosition);
		matchSources.push("entity");
	}
	if (hintPosition !== undefined) {
		rrfRaw += weights.hint / (K + hintPosition);
		matchSources.push("hint");
	}
	const baseRelevance = (K + 1) * rrfRaw;

	// ADR §3: fused-path-only, IDF-weighted signal boost — never the legacy
	// computeQuerySignalBoosts (match_count multiplier, no IDF; scoreHybridCandidateLegacy
	// below is its only caller, unchanged).
	const signalMatch = computeQuerySignalBoostsFused(
		query_signals,
		{
			content: observation.content,
			summary: observation.summary,
			context: observation.context,
			created: observation.created,
			type: observation.type,
			tags: observation.tags
		},
		profile_config.query_signal_boosts,
		stats
	);

	if (signalMatch.quoted_phrase_matches.length > 0) matchSources.push("quoted_phrase");
	if (signalMatch.proper_name_matches.length > 0) matchSources.push("proper_name");
	if (signalMatch.temporal_matched) matchSources.push("temporal");
	if (signalMatch.assistant_reference_matched) matchSources.push("assistant_reference");

	// score = (base + signal_boost) * layer_b_weighted — ADR §1 formula.
	const adjustedRelevance = Math.max(0, baseRelevance + signalMatch.total_boost);
	if (adjustedRelevance <= 0) return null;

	const { gripMultiplier, chargePhaseMultiplier, noveltyMultiplier, circadianMultiplier, baseMultiplier } =
		layerBMultiplier(observation, novelty_score, circadian_bias_matched);
	// ADR §2: cap the combined multiplier so Layer B can only reorder candidates
	// already close in relevance, never override a real Layer A gap. layerBMultiplier
	// itself stays uncapped — scoreHybridCandidateLegacy calls the same helper and
	// must keep its pre-retune, uncapped behavior unchanged.
	const cap = profile_config.layer_b_cap;
	const cappedMultiplier = clamp(baseMultiplier, cap.min, cap.max);
	const weightedMultiplier = 1 + ((cappedMultiplier - 1) * profile_config.layer_weights.cognition);
	const score = adjustedRelevance * weightedMultiplier;

	const threshold = min_score ?? profile_config.min_score;
	if (score < threshold) return null;

	return {
		score,
		match_sources: Array.from(new Set(matchSources)),
		score_breakdown: {
			profile: profile_config.name,
			layer_a: {
				rrf_raw: rrfRaw,
				base_relevance: baseRelevance,
				vector_position: vectorPosition ?? null,
				keyword_position: keywordPosition ?? null,
				entity_position: entityPosition ?? null,
				hint_position: hintPosition ?? null,
				vector_similarity: vector_similarity ?? null,
				keyword_ts_rank: keyword_ts_rank ?? null,
				signal_boost: signalMatch.total_boost,
				signal_idf: signalMatch.signal_idf,
				adjusted_relevance: adjustedRelevance
			},
			layer_b: {
				base_multiplier: baseMultiplier,
				capped_multiplier: cappedMultiplier,
				grip_multiplier: gripMultiplier,
				charge_phase_multiplier: chargePhaseMultiplier,
				novelty_multiplier: noveltyMultiplier,
				circadian_multiplier: circadianMultiplier,
				weighted_multiplier: weightedMultiplier
			},
			signals: buildSignalsBreakdown(query_signals, signalMatch)
		}
	};
}

/**
 * Discriminated on `mode` so postgres.ts/sqlite.ts can resolve which scorer +
 * config to use ONCE per hybridSearch call (not per candidate) while still
 * letting the compiler narrow `profile_config` for free inside a per-candidate
 * loop — no non-null assertion needed at the call site.
 *
 * "rrf" (Fischer note, pure rename) — not "fused" — because this mode covers
 * BOTH the "fused" and "flat" retrieval profiles; the discriminant names the
 * scorer path (RRF over lane ranks), not a specific profile. `profile_config.name`
 * still carries the actual "fused" | "flat" distinction.
 */
export type ScoringPlan =
	| { mode: "legacy" }
	| { mode: "rrf"; profile_config: RetrievalProfileConfig };

/** Resolves candidate_pool for ANY RetrievalProfile — including the frozen aliases
 * and "legacy" — without requiring the caller to pre-normalize. Single seam so
 * postgres.ts/sqlite.ts/harness.ts never hand-roll the legacy special-case. */
export function resolveCandidatePoolForProfile(
	profile: RetrievalProfile
): { vector: number; keyword: number; entity: number } {
	const canonical = normalizeRetrievalProfile(profile) ?? DEFAULT_RETRIEVAL_PROFILE;
	if (canonical === "legacy") return LEGACY_PROFILE_CONFIGS.legacy.candidate_pool;
	return getRetrievalProfileConfig(canonical).candidate_pool;
}

// ============ LEGACY SCORER (frozen, pre-RRF — ADR §9/§12) ============
// Kill switch for the RRF retune. Delete NOT BEFORE 2026-10-05 AND not before
// the first public muse-brain release carrying `fused` has been live on our
// own worker for ≥ 1 daemon night (dogfood rule). Until then:
// `retrieval_profile: "legacy"` restores the pre-retune scorer.
//
// Unchanged logic from the pre-retune scorer. "legacy" carries today's "native"
// config verbatim (ADR §1 "Band migration": min_similarity 0.3 semantics
// preserved). native/balanced/benchmark kept too, unchanged, so the pre-retune
// unit tests that call this function directly keep exercising their original
// numbers without modification.

const KEYWORD_MATCH_FLOOR = 0.35;

export type LegacyRetrievalProfile = "native" | "balanced" | "benchmark" | "legacy";

export interface LegacyRetrievalProfileConfig {
	name: LegacyRetrievalProfile;
	candidate_pool: { vector: number; keyword: number; entity: number };
	relevance_mix: { vector: number; keyword: number };
	layer_weights: { relevance: number; cognition: number };
	hint_component_scale: number;
	entity_only_base: number;
	entity_match_boost: number;
	query_signal_boosts: QuerySignalBoostConfig;
}

const LEGACY_NATIVE_CONFIG: LegacyRetrievalProfileConfig = {
	name: "native",
	candidate_pool: { vector: 50, keyword: 30, entity: 20 },
	relevance_mix: { vector: 0.7, keyword: 0.3 },
	layer_weights: { relevance: 1.0, cognition: 1.0 },
	hint_component_scale: 0.06,
	entity_only_base: 0.5,
	entity_match_boost: 0.08,
	query_signal_boosts: {
		quoted_phrase: 0.16,
		proper_name: 0.1,
		temporal: 0.1,
		assistant_reference: 0.09,
		max_total: 0.42
	}
};

const LEGACY_PROFILE_CONFIGS: Record<LegacyRetrievalProfile, LegacyRetrievalProfileConfig> = {
	native: LEGACY_NATIVE_CONFIG,
	balanced: {
		name: "balanced",
		candidate_pool: { vector: 80, keyword: 50, entity: 30 },
		relevance_mix: { vector: 0.65, keyword: 0.35 },
		layer_weights: { relevance: 1.1, cognition: 0.8 },
		hint_component_scale: 0.08,
		entity_only_base: 0.52,
		entity_match_boost: 0.1,
		query_signal_boosts: {
			quoted_phrase: 0.18,
			proper_name: 0.12,
			temporal: 0.12,
			assistant_reference: 0.1,
			max_total: 0.5
		}
	},
	benchmark: {
		name: "benchmark",
		candidate_pool: { vector: 120, keyword: 80, entity: 40 },
		relevance_mix: { vector: 0.55, keyword: 0.45 },
		layer_weights: { relevance: 1.2, cognition: 0.5 },
		hint_component_scale: 0.1,
		entity_only_base: 0.55,
		entity_match_boost: 0.12,
		query_signal_boosts: {
			quoted_phrase: 0.2,
			proper_name: 0.14,
			temporal: 0.14,
			assistant_reference: 0.12,
			max_total: 0.6
		}
	},
	// "legacy" IS today's "native", frozen under its own kill-switch name (ADR §9).
	legacy: { ...LEGACY_NATIVE_CONFIG, name: "legacy" }
};

export function getLegacyRetrievalProfileConfig(profile: LegacyRetrievalProfile): LegacyRetrievalProfileConfig {
	return LEGACY_PROFILE_CONFIGS[profile];
}

export interface HybridScoreBreakdownLegacy {
	profile: LegacyRetrievalProfile;
	layer_a: {
		base_relevance: number;
		vector_component: number;
		keyword_component: number;
		hint_component: number;
		entity_component: number;
		signal_boost: number;
		adjusted_relevance: number;
	};
	layer_b: {
		base_multiplier: number;
		grip_multiplier: number;
		charge_phase_multiplier: number;
		novelty_multiplier: number;
		circadian_multiplier: number;
		weighted_multiplier: number;
	};
	dynamic_weights?: {
		baseline: { relevance: number; cognition: number };
		modifiers: Array<Record<string, unknown>>;
		total_delta: { relevance: number; cognition: number };
		applied: { relevance: number; cognition: number };
	};
	signals: HybridScoreSignals;
	rerank?: Record<string, unknown>;
}

export interface HybridCandidateScoreInputLegacy {
	observation: Observation;
	territory: string;
	retrieval_profile: LegacyRetrievalProfile;
	query_signals: QuerySignals;
	max_keyword_rank: number;
	vector_similarity?: number;
	keyword_rank?: number;
	hint_score?: number;
	entity_matched?: boolean;
	novelty_score?: number;
	circadian_bias_matched?: boolean;
	min_similarity?: number;
}

export interface HybridCandidateScoreResultLegacy {
	score: number;
	match_sources: string[];
	score_breakdown: HybridScoreBreakdownLegacy;
}

function normalizeKeywordComponentLegacy(keywordRank: number | undefined, maxKeywordRank: number): number {
	if (keywordRank === undefined) return 0;
	if (maxKeywordRank <= 0) return KEYWORD_MATCH_FLOOR;
	return Math.max(0, keywordRank) / maxKeywordRank;
}

export function scoreHybridCandidateLegacy(input: HybridCandidateScoreInputLegacy): HybridCandidateScoreResultLegacy | null {
	const {
		observation,
		retrieval_profile,
		query_signals,
		max_keyword_rank,
		vector_similarity,
		keyword_rank,
		hint_score = 0,
		entity_matched = false,
		novelty_score,
		circadian_bias_matched = false,
		min_similarity = 0.3
	} = input;

	const profileConfig = getLegacyRetrievalProfileConfig(retrieval_profile);
	const matchSources: string[] = [];

	let baseRelevance = 0;
	let vectorComponent = 0;
	let keywordComponent = 0;
	let hintComponent = 0;
	let entityComponent = 0;

	if (vector_similarity !== undefined && keyword_rank !== undefined) {
		vectorComponent = vector_similarity * profileConfig.relevance_mix.vector;
		keywordComponent = normalizeKeywordComponentLegacy(keyword_rank, max_keyword_rank) * profileConfig.relevance_mix.keyword;
		baseRelevance = vectorComponent + keywordComponent;
		matchSources.push("vector", "keyword");
	} else if (vector_similarity !== undefined) {
		vectorComponent = vector_similarity;
		baseRelevance = vectorComponent;
		matchSources.push("vector");
	} else if (keyword_rank !== undefined) {
		keywordComponent = normalizeKeywordComponentLegacy(keyword_rank, max_keyword_rank);
		baseRelevance = keywordComponent;
		matchSources.push("keyword");
	} else if (entity_matched) {
		baseRelevance = profileConfig.entity_only_base;
	}

	if (hint_score > 0) {
		hintComponent = Math.min(Math.max(hint_score, 0), 1) * profileConfig.hint_component_scale;
		baseRelevance += hintComponent;
		matchSources.push("hint");
	}

	if (entity_matched) {
		entityComponent += profileConfig.entity_match_boost;
		matchSources.push("entity");
	}

	const signalMatch = computeQuerySignalBoosts(
		query_signals,
		{
			content: observation.content,
			summary: observation.summary,
			context: observation.context,
			created: observation.created,
			type: observation.type,
			tags: observation.tags
		},
		profileConfig.query_signal_boosts
	);

	if (signalMatch.quoted_phrase_matches.length > 0) matchSources.push("quoted_phrase");
	if (signalMatch.proper_name_matches.length > 0) matchSources.push("proper_name");
	if (signalMatch.temporal_matched) matchSources.push("temporal");
	if (signalMatch.assistant_reference_matched) matchSources.push("assistant_reference");

	const adjustedRelevance = Math.max(
		0,
		(baseRelevance + entityComponent + signalMatch.total_boost) * profileConfig.layer_weights.relevance
	);
	if (adjustedRelevance <= 0) return null;

	const { gripMultiplier, chargePhaseMultiplier, noveltyMultiplier, circadianMultiplier, baseMultiplier } =
		layerBMultiplier(observation, novelty_score, circadian_bias_matched);
	const weightedMultiplier = 1 + ((baseMultiplier - 1) * profileConfig.layer_weights.cognition);
	const score = adjustedRelevance * weightedMultiplier;

	if (score < min_similarity) return null;

	return {
		score,
		match_sources: Array.from(new Set(matchSources)),
		score_breakdown: {
			profile: retrieval_profile,
			layer_a: {
				base_relevance: baseRelevance,
				vector_component: vectorComponent,
				keyword_component: keywordComponent,
				hint_component: hintComponent,
				entity_component: entityComponent,
				signal_boost: signalMatch.total_boost,
				adjusted_relevance: adjustedRelevance
			},
			layer_b: {
				base_multiplier: baseMultiplier,
				grip_multiplier: gripMultiplier,
				charge_phase_multiplier: chargePhaseMultiplier,
				novelty_multiplier: noveltyMultiplier,
				circadian_multiplier: circadianMultiplier,
				weighted_multiplier: weightedMultiplier
			},
			signals: buildSignalsBreakdown(query_signals, signalMatch)
		}
	};
}

/** Whichever scorer produced a result — the new RRF scorer (HybridScoreBreakdown)
 * or the frozen legacy scorer (HybridScoreBreakdownLegacy, retrieval_profile:
 * "legacy"). Single definition, next to both constituents — re-exported from
 * storage/interface.ts and retrieval/rerank.ts rather than redeclared there. */
export type AnyHybridScoreBreakdown = HybridScoreBreakdown | HybridScoreBreakdownLegacy;
