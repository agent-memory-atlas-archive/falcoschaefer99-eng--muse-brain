// ============ RETRIEVAL PROFILES + QUERY SIGNALS (Sprint 1) ============
// Layer A (relevance) helpers:
// - retrieval profile baselines
// - query signal extraction
// - first heuristic boost set

import { unique } from "./utils";

/**
 * Retrieval profile identifiers. "native" | "balanced" | "benchmark" are frozen
 * ALIASES of "fused" (ADR-RETRIEVAL-FUSION-RETUNE §9, pulled forward into commit 3
 * — see normalizeRetrievalProfile). Kept as literal members here — rather than
 * deleted — so existing callers/CLI/stored configs referencing the old names
 * keep type-checking through the one-release-cycle deprecation window; they
 * resolve to "fused" at normalization time and never reach the config lookup
 * below directly. The canonical, config-bearing set is CanonicalRetrievalProfile.
 */
export type RetrievalProfile = "native" | "balanced" | "benchmark" | "fused" | "flat" | "legacy";

/** What normalizeRetrievalProfile always returns — RetrievalProfile minus the
 * frozen aliases. "legacy" has no entry in RETRIEVAL_PROFILE_CONFIGS below; its
 * frozen config lives with the frozen scorer in ./scoring (kept on its own
 * type per ADR §9 — "today's native config verbatim... on a separate legacy
 * config type"). */
export type CanonicalRetrievalProfile = "fused" | "flat" | "legacy";

export interface QueryTemporalSignals {
	has_temporal_cue: boolean;
	iso_dates: string[];
	years: number[];
	months: number[]; // 1-12
	relative_cues: string[];
	backward_cues?: string[];
}

export interface QueryAssistantReference {
	detected: boolean;
	cues: string[];
}

export interface QueryEmotionSignals {
	detected: boolean;
	cues: string[];
}

export interface QueryContradictionSignals {
	detected: boolean;
	cues: string[];
}

export interface QueryRelationalSignals {
	detected: boolean;
	cues: string[];
	/** 0-1 coarse intensity score for relationally loaded queries. */
	intensity: number;
}

export interface QueryTerritorySignals {
	mentioned: string[];
}

export interface QuerySignals {
	quoted_phrases: string[];
	proper_names: string[];
	temporal: QueryTemporalSignals;
	assistant_reference: QueryAssistantReference;
	emotional_state: QueryEmotionSignals;
	contradiction: QueryContradictionSignals;
	relational: QueryRelationalSignals;
	territory: QueryTerritorySignals;
}

export interface QuerySignalBoostConfig {
	quoted_phrase: number;
	proper_name: number;
	temporal: number;
	assistant_reference: number;
	max_total: number;
}

/**
 * "fused" | "flat" scoring config — RRF over lane ranks (ADR-RETRIEVAL-FUSION-RETUNE
 * §1). `relevance_mix` / `entity_only_base` / `entity_match_boost` /
 * `hint_component_scale` / `layer_weights.relevance` are gone: entity and hint are
 * RRF lanes now (lane_weights.entity / lane_weights.hint), and layer_weights.relevance
 * is pinned to 1.0 by deletion (it never changed an ordering — see ADR §2).
 */
export interface RetrievalProfileConfig {
	name: "fused" | "flat";
	candidate_pool: {
		vector: number;
		keyword: number;
		entity: number;
	};
	/** RRF K — see ADR §1 formula. Overridable per-run via the benchmark CLI's
	 * --rrf-k flag (fused profile only; see HybridSearchOptions.profile_overrides). */
	rrf_k: number;
	/** Must sum to 1 — enforced at config-authoring time here and again by the
	 * benchmark CLI's --lane-weights validator for runtime overrides. */
	lane_weights: {
		vector: number;
		keyword: number;
		entity: number;
		hint: number;
	};
	layer_weights: {
		cognition: number;
	};
	/** Bounds for the combined Layer B multiplier (grip × charge_phase × novelty ×
	 * circadian) before it's weighted by layer_weights.cognition — ADR-RETRIEVAL-
	 * FUSION-RETUNE §2. Uncapped, the combined multiplier reaches ~2.4x, enough to
	 * override any Layer A relevance difference; capping to a starting [0.92, 1.10]
	 * band lets Layer B only reorder candidates already close in relevance. Config
	 * (not a code constant) so a future re-measure can raise it without a code change. */
	layer_b_cap: { min: number; max: number };
	/** Floor that drops zero-evidence candidates on the new 0–1 rank band — not a
	 * confidence gate (ADR §1 "Band migration"). Replaces the old min_similarity
	 * default of 0.3, which assumed an absolute-cosine-shaped score. */
	min_score: number;
	query_signal_boosts: QuerySignalBoostConfig;
}

export const DEFAULT_RETRIEVAL_PROFILE: CanonicalRetrievalProfile = "fused";

export const RETRIEVAL_PROFILE_CONFIGS: Record<"fused" | "flat", RetrievalProfileConfig> = {
	fused: {
		name: "fused",
		candidate_pool: { vector: 100, keyword: 60, entity: 20 },
		// Chosen by the 2026-09-05 golden sweep (benchmarks/golden/SWEEP-2026-09-05.md):
		// K=20 doubled R@1 over K=60 and kw 0.20 was the R@5 balance point. Re-sweep after
		// the Layer B clamp (retune commit 5) — R@1 is still Layer-B-bound at this setting.
		rrf_k: 20,
		lane_weights: { vector: 0.68, keyword: 0.2, entity: 0.07, hint: 0.05 },
		layer_weights: { cognition: 0.8 },
		layer_b_cap: { min: 0.92, max: 1.10 },
		min_score: 0.02,
		// ADR §3: these are now IDF-weighted per-candidate (computeQuerySignalBoostsFused)
		// rather than applied at face value — a signal matching most of the candidate
		// set decays toward zero regardless of these ceilings. Values are the post-IDF
		// per-signal ceilings, not directly comparable to the pre-retune magnitudes.
		query_signal_boosts: {
			quoted_phrase: 0.05,
			proper_name: 0.03,
			temporal: 0.04,
			assistant_reference: 0.02,
			max_total: 0.08
		}
	},
	flat: {
		name: "flat",
		candidate_pool: { vector: 30, keyword: 120, entity: 15 },
		rrf_k: 60,
		lane_weights: { vector: 0.15, keyword: 0.8, entity: 0.03, hint: 0.02 },
		layer_weights: { cognition: 0.2 },
		layer_b_cap: { min: 0.92, max: 1.10 },
		min_score: 0.02,
		query_signal_boosts: {
			quoted_phrase: 0.02,
			proper_name: 0.02,
			temporal: 0.02,
			assistant_reference: 0.01,
			max_total: 0.06
		}
	}
};

/** Resolves the frozen aliases ("native" -> "fused" etc.) and passes canonical
 * values through unchanged. Always returns a CanonicalRetrievalProfile (or
 * undefined for anything unrecognized) — this is the ONE place the alias
 * mapping lives (ADR §9, pulled forward into commit 3). */
export function normalizeRetrievalProfile(value: unknown): CanonicalRetrievalProfile | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.trim().toLowerCase();
	if (clean === "native" || clean === "balanced" || clean === "benchmark") return "fused";
	if (clean === "fused" || clean === "flat" || clean === "legacy") return clean;
	return undefined;
}

export function getRetrievalProfileConfig(profile: "fused" | "flat"): RetrievalProfileConfig {
	return RETRIEVAL_PROFILE_CONFIGS[profile];
}

/**
 * Module-load invariant check over RETRIEVAL_PROFILE_CONFIGS (Fischer LOW 85):
 * every profile's layer_b_cap must be a well-formed [min, max] band — both
 * finite, min > 0 (a non-positive floor could zero out or invert a candidate's
 * score in scoreHybridCandidate's clamp()), and min <= max (an inverted band
 * would make clamp() always return min, silently discarding the configured
 * max). Exported (rather than a private top-level side effect only) so the
 * exact same check can be exercised against a deliberately malformed config
 * in tests without reloading the module — called unconditionally below so a
 * malformed shipped config fails at import time, not the first time a search
 * happens to hit the affected profile.
 */
export function validateRetrievalProfileConfigs(configs: Record<string, RetrievalProfileConfig>): void {
	for (const config of Object.values(configs)) {
		const { min, max } = config.layer_b_cap;
		if (!Number.isFinite(min) || !Number.isFinite(max)) {
			throw new Error(`RETRIEVAL_PROFILE_CONFIGS["${config.name}"].layer_b_cap must be finite; got {min: ${min}, max: ${max}}`);
		}
		if (min <= 0) {
			throw new Error(`RETRIEVAL_PROFILE_CONFIGS["${config.name}"].layer_b_cap.min must be > 0; got ${min}`);
		}
		if (min > max) {
			throw new Error(`RETRIEVAL_PROFILE_CONFIGS["${config.name}"].layer_b_cap must satisfy min <= max; got {min: ${min}, max: ${max}}`);
		}
	}
}

validateRetrievalProfileConfigs(RETRIEVAL_PROFILE_CONFIGS);

/** Shape of HybridSearchOptions.profile_overrides — declared here (not imported
 * from storage/interface.ts) so this file has no dependency on the storage layer;
 * both HybridSearchOptions.profile_overrides and CliOptions.profile_overrides are
 * structurally identical to this. */
export interface ProfileOverridesInput {
	rrf_k?: number;
	lane_weights?: { vector: number; keyword: number; entity: number; hint: number };
}

const PROFILE_OVERRIDE_LANE_KEYS = ["vector", "keyword", "entity", "hint"] as const;

/**
 * The one definition of "valid" for a fused-profile rrf_k/lane_weights override
 * (ADR-RETRIEVAL-FUSION-RETUNE §1 "Rook's note" sweep). Called at the
 * postgres.ts/sqlite.ts merge point — where `options.profile_overrides` merges
 * into the resolved ScoringPlan — and by the benchmark CLI's --rrf-k /
 * --lane-weights parsing (cli.ts). The merge point is authoritative; cli.ts
 * fully delegates the rrf_k range and the lane_weights sum-to-1 tolerance here,
 * but still pre-checks lane_weights' per-key [0,1] range and four-key
 * completeness inline to produce its own flag-specific messages — keep those
 * two in step if either bound ever changes. This is a programming-error
 * boundary, not user-facing input validation:
 * a malformed override reaching either backend is a caller bug (a hand-rolled
 * HybridSearchOptions or a CLI parsing bug), so this throws rather than
 * clamping or silently dropping the override.
 */
export function validateProfileOverrides(overrides: ProfileOverridesInput): void {
	if (overrides.rrf_k !== undefined) {
		if (!Number.isFinite(overrides.rrf_k) || overrides.rrf_k < 1 || overrides.rrf_k > 500) {
			throw new Error(`profile_overrides.rrf_k must be finite and in [1, 500]; got ${overrides.rrf_k}`);
		}
	}
	if (overrides.lane_weights !== undefined) {
		const weights = overrides.lane_weights;
		const keys = Object.keys(weights);
		const hasExactlyFourKeys = keys.length === PROFILE_OVERRIDE_LANE_KEYS.length
			&& PROFILE_OVERRIDE_LANE_KEYS.every(key => keys.includes(key));
		if (!hasExactlyFourKeys) {
			throw new Error(`profile_overrides.lane_weights must have exactly the four keys: ${PROFILE_OVERRIDE_LANE_KEYS.join(", ")}`);
		}
		for (const key of PROFILE_OVERRIDE_LANE_KEYS) {
			const value = weights[key];
			if (!Number.isFinite(value) || value < 0 || value > 1) {
				throw new Error(`profile_overrides.lane_weights.${key} must be finite and in [0, 1]; got ${value}`);
			}
		}
		const sum = weights.vector + weights.keyword + weights.entity + weights.hint;
		if (Math.abs(sum - 1) > 0.001) {
			throw new Error(`profile_overrides.lane_weights must sum to 1 (±0.001); got ${sum.toFixed(4)}`);
		}
	}
}

const MONTHS: Record<string, number> = {
	january: 1, jan: 1,
	february: 2, feb: 2,
	march: 3, mar: 3,
	april: 4, apr: 4,
	may: 5,
	june: 6, jun: 6,
	july: 7, jul: 7,
	august: 8, aug: 8,
	september: 9, sep: 9, sept: 9,
	october: 10, oct: 10,
	november: 11, nov: 11,
	december: 12, dec: 12
};

const PROPER_NAME_BLOCKLIST = new Set([
	"The", "A", "An", "And", "Or", "But",
	"What", "When", "Where", "Why", "How", "Who",
	"I", "You", "We", "They", "He", "She", "It",
	"Today", "Tomorrow", "Yesterday", "Last", "Next", "This"
]);

/**
 * Sentence-initial discourse markers/interjections — capitalized purely by
 * English orthography (sentence-start capitalization), not because they're
 * names. Distinct from PROPER_NAME_BLOCKLIST above, which blocks these tokens
 * everywhere; this set only applies the position-sensitive rule in
 * extractQuerySignals below ("Yeah this is what my debt advisor said" should
 * not extract "Yeah" as a proper name, but "Falco said" must still keep
 * "Falco" — an arbitrary single-occurrence sentence-initial name has no
 * signal to distinguish it from a filler word other than NOT being one).
 */
const SENTENCE_INITIAL_FILLER_WORDS = new Set([
	"Yeah", "Yes", "Yep", "Yup", "No", "Nope", "Nah",
	"Okay", "Ok", "Alright", "Well", "So", "Actually",
	"Basically", "Honestly", "Look", "Listen", "Right",
	"Sure", "Hey", "Oh", "Anyway", "Anyways", "Now",
	"Also", "Then", "Still", "Wait", "Hmm", "Huh", "Ugh"
]);

const RELATIVE_TEMPORAL_CUES = [
	"today",
	"yesterday",
	"tomorrow",
	"last week",
	"this week",
	"next week",
	"last month",
	"this month",
	"next month",
	"last year",
	"this year",
	"next year",
	"recent",
	"recently",
	"latest"
];

const BACKWARD_TEMPORAL_CUES = [
	"earlier",
	"before",
	"previously",
	"prior",
	"used to",
	"was still"
];

const BACKWARD_TEMPORAL_CUE_SET = new Set(BACKWARD_TEMPORAL_CUES);

const EMOTIONAL_STATE_CUES = [
	"worried",
	"upset",
	"anxious",
	"anxiety",
	"stressed",
	"overwhelmed",
	"sad",
	"grief",
	"angry",
	"fear",
	"afraid",
	"emotional",
	"emotion",
	"feeling",
	"felt",
	"mood"
];

const CONTRADICTION_CUES = [
	"contradiction",
	"contradict",
	"contradicts",
	"contradicting",
	"contradicted",
	"inconsistent",
	"inconsistency",
	"doesn't add up",
	"does not add up",
	"vs",
	"versus",
	"but now",
	"changed from",
	"conflict with"
];

const RELATIONAL_CUES = [
	"relationship",
	"partner",
	"between us",
	"we",
	"us",
	"intimacy",
	"rupture",
	"repair",
	"conflict",
	"apology",
	"argument",
	"fight",
	"trust",
	"distance",
	"no contact",
	"check-in"
];

const RELATIONAL_HIGH_INTENSITY_CUES = new Set([
	"rupture",
	"repair",
	"conflict",
	"apology",
	"argument",
	"fight",
	"intimacy",
	"no contact"
]);

const TERRITORY_TOKENS = [
	"self",
	"us",
	"craft",
	"body",
	"emotional",
	"episodic",
	"philosophy",
	"kin"
];

const BACKWARD_LOOKBACK_MIN_AGE_DAYS = 7;

export function hasAnchoredTemporalReference(temporal: QueryTemporalSignals): boolean {
	return temporal.iso_dates.length > 0
		|| temporal.years.length > 0
		|| temporal.months.length > 0
		|| (temporal.relative_cues?.length ?? 0) > 0;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `index` is the query's first non-whitespace character, or the
 * first non-whitespace character after a `.`/`!`/`?` — i.e. this is where an
 * English sentence starts. Used only to scope SENTENCE_INITIAL_FILLER_WORDS
 * filtering below; not a general sentence-splitter. */
function isSentenceInitialPosition(raw: string, index: number): boolean {
	const prefix = raw.slice(0, index).replace(/\s+$/, "");
	if (prefix.length === 0) return true;
	return /[.!?]$/.test(prefix);
}

function buildCueRegexMap(cues: string[]): Map<string, RegExp> {
	const map = new Map<string, RegExp>();
	for (const cue of cues) {
		const escaped = escapeRegex(cue).replace(/\s+/g, "\\s+");
		map.set(cue, new RegExp(`\\b${escaped}\\b`, "i"));
	}
	return map;
}

function detectCues(text: string, cueRegex: Map<string, RegExp>): string[] {
	return unique(
		Array.from(cueRegex.entries())
			.filter(([, regex]) => regex.test(text))
			.map(([cue]) => cue)
	);
}

const MONTH_TOKEN_REGEX = new Map<string, RegExp>(
	Object.keys(MONTHS).map(token => [token, new RegExp(`\\b${escapeRegex(token)}\\b`, "i")])
);
const RELATIVE_TEMPORAL_CUE_REGEX = buildCueRegexMap(RELATIVE_TEMPORAL_CUES);
const BACKWARD_TEMPORAL_CUE_REGEX = buildCueRegexMap(BACKWARD_TEMPORAL_CUES);
const EMOTIONAL_STATE_CUE_REGEX = buildCueRegexMap(EMOTIONAL_STATE_CUES);
const CONTRADICTION_CUE_REGEX = buildCueRegexMap(CONTRADICTION_CUES);
const RELATIONAL_CUE_REGEX = buildCueRegexMap(RELATIONAL_CUES);
const TERRITORY_TOKEN_REGEX = buildCueRegexMap(TERRITORY_TOKENS);

const NATURAL_MONTH_DAY_REGEX = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/gi;
const NATURAL_DAY_MONTH_REGEX = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:,\s*(\d{4}))?\b/gi;
const MAY_MONTH_CONTEXT_REGEX = /\b(?:in|on|during|throughout|by)\s+may\b|\bmay\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{4})\b/i;

function toIsoDate(year: number, month: number, day: number): string | undefined {
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
	if (day < 1 || day > 31) return undefined;
	const normalized = new Date(Date.UTC(year, month - 1, day));
	if (normalized.getUTCFullYear() !== year || (normalized.getUTCMonth() + 1) !== month || normalized.getUTCDate() !== day) {
		return undefined;
	}
	return normalized.toISOString().slice(0, 10);
}

function extractNaturalLanguageIsoDates(raw: string, defaultYear: number): string[] {
	const isoDates: string[] = [];
	for (const match of raw.matchAll(NATURAL_MONTH_DAY_REGEX)) {
		const monthToken = String(match[1] ?? "").toLowerCase();
		const month = MONTHS[monthToken];
		const day = Number.parseInt(String(match[2] ?? ""), 10);
		const explicitYear = Number.parseInt(String(match[3] ?? ""), 10);
		const year = Number.isFinite(explicitYear) ? explicitYear : defaultYear;
		const iso = toIsoDate(year, month, day);
		if (iso) isoDates.push(iso);
	}
	for (const match of raw.matchAll(NATURAL_DAY_MONTH_REGEX)) {
		const day = Number.parseInt(String(match[1] ?? ""), 10);
		const monthToken = String(match[2] ?? "").toLowerCase();
		const month = MONTHS[monthToken];
		const explicitYear = Number.parseInt(String(match[3] ?? ""), 10);
		const year = Number.isFinite(explicitYear) ? explicitYear : defaultYear;
		const iso = toIsoDate(year, month, day);
		if (iso) isoDates.push(iso);
	}
	return unique(isoDates);
}

function monthMentioned(raw: string, token: string): boolean {
	if (token === "may") {
		return MAY_MONTH_CONTEXT_REGEX.test(raw);
	}
	return MONTH_TOKEN_REGEX.get(token)?.test(raw) ?? false;
}

function matchRelativeTemporalCue(cue: string, ageDays: number): boolean {
	switch (cue) {
		case "today":
			return ageDays < 1;
		case "yesterday":
			return ageDays >= 1 && ageDays < 2;
		case "recent":
			return ageDays <= 10;
		case "recently":
			return ageDays <= 14;
		case "latest":
			return ageDays <= 7;
		case "this week":
			return ageDays <= 7;
		case "last week":
			return ageDays > 7 && ageDays <= 14;
		case "this month":
			return ageDays <= 31;
		case "last month":
			return ageDays > 31 && ageDays <= 62;
		case "this year":
			return ageDays <= 366;
		case "last year":
			return ageDays > 366 && ageDays <= 730;
		default:
			return false;
	}
}

function matchBackwardTemporalCue(cue: string, createdMs: number, ageDays: number, referenceDateMs: number | undefined): boolean {
	if (!BACKWARD_TEMPORAL_CUE_SET.has(cue)) return false;
	if (Number.isFinite(referenceDateMs)) {
		const dayEnd = (referenceDateMs as number) + (24 * 60 * 60 * 1000) - 1;
		return createdMs <= dayEnd;
	}
	return ageDays >= BACKWARD_LOOKBACK_MIN_AGE_DAYS;
}

export function extractQuerySignals(query: string): QuerySignals {
	const raw = String(query ?? "");
	const lowered = raw.toLowerCase();

	const quoted_phrases = unique(
		Array.from(raw.matchAll(/"([^"\n]{2,160})"/g))
			.map(m => m[1].trim())
			.filter(Boolean)
	);

	const proper_names = unique(
		Array.from(raw.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g))
			// A sentence-initial SINGLE-token match that's a known discourse filler
			// ("Yeah this is...", "Okay so...") is capitalized by English sentence-start
			// orthography, not because it's a name — drop it, UNLESS the same token
			// recurs capitalized elsewhere in the query (then it's being used as a
			// real name/reference, not just starting a sentence). Multi-word matches
			// and non-sentence-initial matches ("But Hetzner is...") are never touched
			// by this rule — a multi-word capitalized phrase at sentence start is
			// already almost certainly a real name.
			.filter(m => {
				const name = m[0].trim();
				if (name.includes(" ")) return true;
				if (!isSentenceInitialPosition(raw, m.index ?? 0)) return true;
				if (!SENTENCE_INITIAL_FILLER_WORDS.has(name)) return true;
				const recurs = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
				return (raw.match(recurs) ?? []).length > 1;
			})
			.map(m => m[0].trim())
			.filter(name => !PROPER_NAME_BLOCKLIST.has(name))
			.filter(name => !MONTHS[name.toLowerCase()])
	);

	const explicitIsoDates = unique(
		Array.from(lowered.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)).map(m => m[0])
	);
	const years = unique(
		Array.from(lowered.matchAll(/\b(?:19|20)\d{2}\b/g))
			.map(m => Number(m[0]))
			.filter(n => Number.isFinite(n))
	);
	const defaultYear = years[0] ?? new Date().getUTCFullYear();
	const naturalIsoDates = extractNaturalLanguageIsoDates(raw, defaultYear);
	const iso_dates = unique([...explicitIsoDates, ...naturalIsoDates]);
	const months = unique(
		Object.entries(MONTHS)
			.filter(([token]) => monthMentioned(raw, token))
			.map(([, month]) => month)
	);
	const relative_cues = detectCues(raw, RELATIVE_TEMPORAL_CUE_REGEX);
	const backward_cues = detectCues(raw, BACKWARD_TEMPORAL_CUE_REGEX);
	const has_temporal_cue = iso_dates.length > 0
		|| years.length > 0
		|| months.length > 0
		|| relative_cues.length > 0
		|| backward_cues.length > 0;

	const assistantCues: string[] = [];
	if (/\bwhat did you\b/i.test(raw)) assistantCues.push("what_did_you");
	if (/\b(?:you|assistant|ai|rainer|rook)\s+(?:said|told|wrote|replied|mentioned|recommended|answered)\b/i.test(raw)) {
		assistantCues.push("assistant_verb_reference");
	}
	if (/\byour\s+(?:response|answer|message|advice)\b/i.test(raw)) assistantCues.push("your_response_reference");
	if (/\bassistant\b/i.test(raw)) assistantCues.push("assistant_term");

	const emotionalCues = detectCues(raw, EMOTIONAL_STATE_CUE_REGEX);
	const contradictionCues = detectCues(raw, CONTRADICTION_CUE_REGEX);
	const relationalCues = detectCues(raw, RELATIONAL_CUE_REGEX);
	const territoryMentioned = detectCues(raw, TERRITORY_TOKEN_REGEX);
	const relationalHighIntensity = relationalCues.some(cue => RELATIONAL_HIGH_INTENSITY_CUES.has(cue));
	const relationalIntensity = relationalCues.length === 0
		? 0
		: Math.min(
			1,
			0.35
			+ (relationalHighIntensity ? 0.35 : 0)
			+ (emotionalCues.length > 0 ? 0.15 : 0)
			+ (territoryMentioned.includes("us") ? 0.15 : 0)
		);

	return {
		quoted_phrases,
		proper_names,
		temporal: {
			has_temporal_cue,
			iso_dates,
			years,
			months,
			relative_cues,
			backward_cues
		},
		assistant_reference: {
			detected: assistantCues.length > 0,
			cues: unique(assistantCues)
		},
		emotional_state: {
			detected: emotionalCues.length > 0,
			cues: emotionalCues
		},
		contradiction: {
			detected: contradictionCues.length > 0,
			cues: contradictionCues
		},
		relational: {
			detected: relationalCues.length > 0,
			cues: relationalCues,
			intensity: relationalIntensity
		},
		territory: {
			mentioned: territoryMentioned
		}
	};
}

export interface SignalScorableObservation {
	content?: string;
	summary?: string;
	context?: string;
	created?: string;
	type?: string;
	tags?: string[];
}

export interface QuerySignalMatch {
	components: {
		quoted_phrase: number;
		proper_name: number;
		temporal: number;
		assistant_reference: number;
	};
	total_boost: number;
	quoted_phrase_matches: string[];
	proper_name_matches: string[];
	temporal_matched: boolean;
	temporal_reasons: string[];
	assistant_reference_matched: boolean;
}

function isAssistantAuthoredObservation(observation: SignalScorableObservation): boolean {
	const type = String(observation.type ?? "").toLowerCase();
	const context = String(observation.context ?? "").toLowerCase();
	const content = String(observation.content ?? "").toLowerCase();
	const tags = (observation.tags ?? []).map(tag => tag.toLowerCase());

	if (/(assistant|reply|response)/.test(type)) return true;
	if (/(assistant|rainer|rook)/.test(context)) return true;
	if (tags.some(tag => /(assistant|ai|response|reply|rainer|rook)/.test(tag))) return true;
	if (/^(assistant|rainer|rook)\s*:/.test(content.trim())) return true;
	return false;
}

interface TemporalMatchContext {
	anchoredTemporalReference: boolean;
	referenceDateMs?: number;
}

const TEMPORAL_MATCH_CONTEXT_CACHE = new WeakMap<QueryTemporalSignals, TemporalMatchContext>();

function getTemporalReferenceDateMs(temporal: QueryTemporalSignals): number | undefined {
	let latest: number | undefined;
	for (const date of temporal.iso_dates) {
		const timestamp = Date.parse(`${date}T00:00:00.000Z`);
		if (!Number.isFinite(timestamp)) continue;
		if (latest === undefined || timestamp > latest) latest = timestamp;
	}
	return latest;
}

function getTemporalMatchContext(temporal: QueryTemporalSignals): TemporalMatchContext {
	const cached = TEMPORAL_MATCH_CONTEXT_CACHE.get(temporal);
	if (cached) return cached;
	const context: TemporalMatchContext = {
		anchoredTemporalReference: hasAnchoredTemporalReference(temporal),
		referenceDateMs: getTemporalReferenceDateMs(temporal)
	};
	TEMPORAL_MATCH_CONTEXT_CACHE.set(temporal, context);
	return context;
}

function matchTemporalSignals(
	temporal: QueryTemporalSignals,
	createdIso: string | undefined,
	nowMs: number,
	context: TemporalMatchContext
): { matched: boolean; reasons: string[] } {
	if (!createdIso) return { matched: false, reasons: [] };
	const createdMs = Date.parse(createdIso);
	if (!Number.isFinite(createdMs)) return { matched: false, reasons: [] };
	const DAY_MS = 24 * 60 * 60 * 1000;

	const created = new Date(createdMs);
	const createdDate = created.toISOString().slice(0, 10);
	const reasons: string[] = [];

	if (temporal.iso_dates.includes(createdDate)) reasons.push("iso_date");
	if (temporal.years.includes(created.getUTCFullYear())) reasons.push("year");
	if (temporal.months.includes(created.getUTCMonth() + 1)) reasons.push("month");

	const temporalCues = unique([...(temporal.relative_cues ?? []), ...(temporal.backward_cues ?? [])]);
	if (temporalCues.length > 0) {
		const ageDays = (nowMs - createdMs) / DAY_MS;
		for (const cue of temporalCues) {
			const isBackwardCue = BACKWARD_TEMPORAL_CUE_SET.has(cue);
			if (isBackwardCue && !context.anchoredTemporalReference) continue;
			if (matchRelativeTemporalCue(cue, ageDays) || matchBackwardTemporalCue(cue, createdMs, ageDays, context.referenceDateMs)) {
				reasons.push(`relative:${cue}`);
			}
		}
	}

	return { matched: reasons.length > 0, reasons: unique(reasons) };
}

export function computeQuerySignalBoosts(
	signals: QuerySignals,
	observation: SignalScorableObservation,
	config: QuerySignalBoostConfig,
	nowMs = Date.now()
): QuerySignalMatch {
	const haystack = `${observation.content ?? ""}\n${observation.summary ?? ""}\n${observation.context ?? ""}`.toLowerCase();

	const temporalContext = getTemporalMatchContext(signals.temporal);
	const quoted_phrase_matches = signals.quoted_phrases.filter(phrase => haystack.includes(phrase.toLowerCase()));
	const proper_name_matches = signals.proper_names.filter(name => {
		if (haystack.includes(name.toLowerCase())) return true;
		const parts = name.split(/\s+/).map(p => p.trim()).filter(Boolean);
		return parts.length > 1 && parts.every(part => haystack.includes(part.toLowerCase()));
	});
	const temporalMatch = matchTemporalSignals(signals.temporal, observation.created, nowMs, temporalContext);
	const assistant_reference_matched = signals.assistant_reference.detected && isAssistantAuthoredObservation(observation);

	let components = {
		quoted_phrase: Math.min(config.quoted_phrase * quoted_phrase_matches.length, config.quoted_phrase * 2.5),
		proper_name: Math.min(config.proper_name * proper_name_matches.length, config.proper_name * 2.5),
		temporal: temporalMatch.matched ? config.temporal : 0,
		assistant_reference: assistant_reference_matched ? config.assistant_reference : 0
	};

	let total = components.quoted_phrase + components.proper_name + components.temporal + components.assistant_reference;
	if (total > config.max_total && total > 0) {
		const scale = config.max_total / total;
		components = {
			quoted_phrase: components.quoted_phrase * scale,
			proper_name: components.proper_name * scale,
			temporal: components.temporal * scale,
			assistant_reference: components.assistant_reference * scale
		};
		total = config.max_total;
	}

	return {
		components,
		total_boost: total,
		quoted_phrase_matches,
		proper_name_matches,
		temporal_matched: temporalMatch.matched,
		temporal_reasons: temporalMatch.reasons,
		assistant_reference_matched
	};
}

// ============ FUSED SCORER — IDF-weighted signal boosts (ADR §3) ============
// computeQuerySignalBoosts above is untouched and stays the legacy scorer's
// exclusive caller (match_count multiplier, no IDF). Everything below is new,
// fused-path-only, and reuses computeQuerySignalBoosts purely for its match
// DETECTION (haystack construction, temporal/proper-name/quoted-phrase logic)
// — the magnitudes it also computes are discarded here. This keeps match
// semantics identical between the two scorers without duplicating that logic,
// and without the legacy scorer ever calling into or being touched by this code.

export interface SignalDocumentFrequency {
	quoted_phrase: number;
	proper_name: number;
	temporal: number;
	assistant_reference: number;
}

/** What computeQuerySignalBoostsFused actually needs from a candidate-set stats
 * pre-pass — candidate_count and signal_df, not the full CandidateSetStats shape
 * (which also carries lane_sizes, a caller-side diagnostic the scorer never
 * reads). scoring.ts's CandidateSetStats is a structural superset of this. */
export interface SignalIdfStats {
	candidate_count: number;
	signal_df: SignalDocumentFrequency;
}

export interface QuerySignalIdfWeights {
	quoted_phrase: number;
	proper_name: number;
	temporal: number;
	assistant_reference: number;
}

export interface QuerySignalMatchFused {
	/** Per-signal weight actually applied — cfg[s] * idf_w(s) — before the
	 * matched(s) gate (ADR §3: "signal_idf (per-signal weights applied)"). Same
	 * value for every candidate scored against one stats object; a value near
	 * zero is the direct evidence that signal matched almost the whole
	 * candidate set and therefore carries no discriminating information. */
	signal_idf: QuerySignalIdfWeights;
	total_boost: number;
	quoted_phrase_matches: string[];
	proper_name_matches: string[];
	temporal_matched: boolean;
	temporal_reasons: string[];
	assistant_reference_matched: boolean;
}

/**
 * Document frequency, over the FULL merged candidate set for one hybridSearch
 * call, of each query signal category — "how many candidates does this signal
 * match at all" (boolean per candidate, never a match count). Feeds
 * computeQuerySignalBoostsFused's IDF weighting: a signal matching most of the
 * set carries no information and should decay toward zero weight (ADR §3).
 *
 * `config` only scales the magnitudes computeQuerySignalBoosts also returns
 * (`.components` / `.total_boost`), which this function discards immediately —
 * any valid QuerySignalBoostConfig produces identical match booleans, so the
 * caller's own profile config is the natural (and only) one to pass through.
 */
export function computeSignalDocumentFrequency(
	signals: QuerySignals,
	observations: Iterable<SignalScorableObservation>,
	config: QuerySignalBoostConfig,
	nowMs = Date.now()
): SignalDocumentFrequency {
	const df: SignalDocumentFrequency = { quoted_phrase: 0, proper_name: 0, temporal: 0, assistant_reference: 0 };
	for (const observation of observations) {
		const match = computeQuerySignalBoosts(signals, observation, config, nowMs);
		if (match.quoted_phrase_matches.length > 0) df.quoted_phrase += 1;
		if (match.proper_name_matches.length > 0) df.proper_name += 1;
		if (match.temporal_matched) df.temporal += 1;
		if (match.assistant_reference_matched) df.assistant_reference += 1;
	}
	return df;
}

/**
 * Post-fusion, IDF-weighted query signal boost — ADR-RETRIEVAL-FUSION-RETUNE §3.
 * Fully separate from computeQuerySignalBoosts (the frozen legacy path); the
 * fused scorer calls this instead, never the legacy function's weighting.
 *
 * idf_w(s)     = 1 - df_s / candidate_count
 * signal_boost = min(Σ_s cfg[s] * idf_w(s) * matched(s), cfg.max_total)
 *
 * matched(s) is a 0/1 gate, not a match count — repeating a phrase or name
 * inside one observation is length bias, not additional evidence (ADR §3:
 * "drop the × match_count").
 *
 * `stats` is optional: when omitted (e.g. a caller scoring one candidate in
 * isolation, with no corpus context), the function CANNOT tell a discriminating
 * signal from a ubiquitous one — exactly the ambiguity this IDF weighting
 * exists to resolve (Reeve MEDIUM 90) — so it applies NO boost at all rather
 * than guessing. This is the conservative direction: a caller that forgets to
 * pass stats silently loses the boost, never silently gains the un-discounted
 * ceiling back (an earlier version defaulted to candidate_count=1/zero-df,
 * which resolves to idf_w=1 for every signal — the MAXIMUM possible weight,
 * the opposite of "unknown"). Every production caller (postgres.ts, sqlite.ts)
 * always supplies real stats from the merged candidate set; this path only
 * matters for isolated/test use of this pure function.
 */
const NO_STATS_NO_BOOST: QuerySignalIdfWeights = {
	quoted_phrase: 0,
	proper_name: 0,
	temporal: 0,
	assistant_reference: 0
};

export function computeQuerySignalBoostsFused(
	signals: QuerySignals,
	observation: SignalScorableObservation,
	config: QuerySignalBoostConfig,
	stats?: SignalIdfStats,
	nowMs = Date.now()
): QuerySignalMatchFused {
	const matches = computeQuerySignalBoosts(signals, observation, config, nowMs);

	if (stats === undefined) {
		return {
			signal_idf: NO_STATS_NO_BOOST,
			total_boost: 0,
			quoted_phrase_matches: matches.quoted_phrase_matches,
			proper_name_matches: matches.proper_name_matches,
			temporal_matched: matches.temporal_matched,
			temporal_reasons: matches.temporal_reasons,
			assistant_reference_matched: matches.assistant_reference_matched
		};
	}

	const denom = Math.max(stats.candidate_count, 1);
	const idf: QuerySignalIdfWeights = {
		quoted_phrase: config.quoted_phrase * (1 - stats.signal_df.quoted_phrase / denom),
		proper_name: config.proper_name * (1 - stats.signal_df.proper_name / denom),
		temporal: config.temporal * (1 - stats.signal_df.temporal / denom),
		assistant_reference: config.assistant_reference * (1 - stats.signal_df.assistant_reference / denom)
	};
	const rawTotal =
		(matches.quoted_phrase_matches.length > 0 ? idf.quoted_phrase : 0) +
		(matches.proper_name_matches.length > 0 ? idf.proper_name : 0) +
		(matches.temporal_matched ? idf.temporal : 0) +
		(matches.assistant_reference_matched ? idf.assistant_reference : 0);
	const total_boost = Math.min(Math.max(rawTotal, 0), config.max_total);

	return {
		signal_idf: idf,
		total_boost,
		quoted_phrase_matches: matches.quoted_phrase_matches,
		proper_name_matches: matches.proper_name_matches,
		temporal_matched: matches.temporal_matched,
		temporal_reasons: matches.temporal_reasons,
		assistant_reference_matched: matches.assistant_reference_matched
	};
}
