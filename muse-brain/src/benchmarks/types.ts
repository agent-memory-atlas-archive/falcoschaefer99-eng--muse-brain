import type { RetrievalProfile } from "../retrieval/query-signals";
import type { RetrievalRerankMode } from "../retrieval/rerank";
import type { Observation } from "../types";

export interface BenchmarkDocument {
	id: string;
	content: string;
	created: string;
	type?: string;
	context?: string;
	tags?: string[];
	territory?: string;
	texture?: Observation["texture"];
}

export interface BenchmarkCase {
	id: string;
	dataset: string;
	query: string;
	answer?: string;
	question_type?: string;
	question_date?: string;
	evidence_ids: string[];
	documents: BenchmarkDocument[];
	skip_retrieval_reason?: string;
	/**
	 * True for a false-positive probe: a case built to prove nothing relevant exists
	 * (evidence_ids: []) that should still run hybridSearch — as opposed to a bare
	 * zero-evidence case, which the harness treats as "no evidence provided yet" and
	 * skips. Scored separately (BenchmarkCaseResult.false_positive /
	 * BenchmarkProfileSummary.false_positive_rate), not folded into recall/ndcg —
	 * those formulas are meaningless against zero evidence ids.
	 */
	expect_no_results?: boolean;
	metadata?: Record<string, unknown>;
}

export interface BenchmarkRunConfig {
	dataset: string;
	profiles: RetrievalProfile[];
	top_k: number[];
	result_limit: number;
	min_similarity: number;
	rerank_mode?: RetrievalRerankMode;
	rerank_top_n?: number;
	/**
	 * Diagnostic-only, off by default. When enabled, the harness calls
	 * `storage.probeLanes` once per case (query/embedding are profile-independent)
	 * to locate each case's evidence ids inside the vector/keyword lanes' own
	 * ordered pools at `depth`, independent of scoring/fusion. See
	 * ops/ADR-RETRIEVAL-FUSION-RETUNE.md §8.
	 */
	lane_probe?: { enabled: boolean; depth: number };
	/**
	 * Per-run overrides for the "fused" profile's rrf_k / lane_weights — the K x
	 * w_keyword sweep from ADR §1 "Rook's note". Threaded straight through to every
	 * `storage.hybridSearch` call this run (HybridSearchOptions.profile_overrides)
	 * and recorded verbatim in BenchmarkArtifact.config for provenance. Ignored by
	 * any profile other than "fused".
	 */
	profile_overrides?: {
		rrf_k?: number;
		lane_weights?: { vector: number; keyword: number; entity: number; hint: number };
	};
}

export interface BenchmarkCaseResult {
	case_id: string;
	dataset: string;
	profile: RetrievalProfile;
	query: string;
	question_type?: string;
	evidence_ids: string[];
	returned_ids: string[];
	returned_count: number;
	hit_ranks: number[];
	recall_at: Record<string, number>;
	ndcg_at: Record<string, number>;
	candidate_hit: boolean;
	/**
	 * "false_positive_probe" is its own category (not folded into no_results/
	 * candidate_miss) because an expect_no_results probe always has an empty
	 * evidence_ids set, so hit_ranks is structurally empty regardless of what
	 * hybridSearch returns — scoring it under those categories would silently
	 * mix a "should return nothing" probe into the real recall-miss tallies.
	 * Its actual pass/fail verdict lives in `false_positive` instead.
	 */
	miss_category?: "abstention" | "missing_evidence" | "no_results" | "candidate_miss" | "run_error" | "false_positive_probe";
	run_error?: string;
	top_results: Array<{
		id: string;
		score: number;
		match_sources: string[];
	}>;
	/** Score of top_results[0], if any returned — undefined when returned_count is 0. */
	top_score?: number;
	/** Mirrors BenchmarkCase.expect_no_results — carried onto the result so
	 * summarizeProfile can identify false-positive probes without re-deriving them. */
	expect_no_results?: boolean;
	/**
	 * Only meaningful when expect_no_results is true: did the probe actually return
	 * something? min_similarity already gates hybridSearch's results, so returned_count > 0
	 * IS "top score cleared the profile's confidence threshold" — there is no separate
	 * per-profile threshold to apply on top of it today.
	 */
	false_positive?: boolean;
	metadata?: Record<string, unknown>;
	/**
	 * Present only when `BenchmarkRunConfig.lane_probe.enabled` — the same probe result
	 * is reused across every profile for this case (query/embedding don't vary by
	 * profile); `final_rank` is the one field that DOES vary, computed per-profile from
	 * that profile's actual `returned_ids`.
	 */
	lane_probe?: {
		depth: number;
		vector_top1: number | null;
		vector_at_depth: number | null;
		items: Array<{
			evidence_id: string;
			/**
			 * 1-based POSITION within the lane's own ordered pool. Named `*_position`,
			 * not `*_rank`, to avoid colliding with `HybridSearchResult.keyword_rank`,
			 * which is a ts_rank MAGNITUDE, not a position.
			 */
			vector_position: number | null;
			vector_similarity: number | null;
			keyword_position: number | null;
			keyword_ts_rank: number | null;
			/** 1-based position of evidence_id in this profile's actual returned_ids, or null if absent. */
			final_rank: number | null;
		}>;
	};
}

export interface BenchmarkProfileSummary {
	profile: RetrievalProfile;
	evaluated_cases: number;
	skipped_cases: number;
	recall_at: Record<string, number>;
	ndcg_at: Record<string, number>;
	candidate_hit_rate: number;
	miss_categories: Record<string, number>;
	/** Share of expect_no_results probes that returned something anyway. Omitted
	 * entirely when this profile's run had zero such probes — there's nothing to rate. */
	false_positive_rate?: number;
	/**
	 * Present only when lane_probe ran. Fraction of evaluated-case evidence items
	 * reachable within each lane at the given cutoffs (recall ceiling per lane), plus
	 * a union-at-100 figure. See ops/ADR-RETRIEVAL-FUSION-RETUNE.md §7/§8. Each
	 * fraction is `null` (not 0) when its denominator (total probed evidence items)
	 * is zero — there is nothing to rate, not a 0% ceiling.
	 */
	lane_recall?: {
		vector: Record<"10" | "50" | "100", number | null>;
		keyword: Record<"10" | "30" | "100", number | null>;
		union: Record<"100", number | null>;
	};
	/**
	 * Of the evidence items sitting in the vector lane's top-10 (across evaluated
	 * cases), the fraction that also survive into this profile's final top-10. The
	 * direct measurement of the fusion-discards-vector-hits disease (§0/§1). `ratio`
	 * is `null` (not 0) when `lane_top10_items` is zero — no vector-lane top-10 hits
	 * means there is nothing to measure fidelity against, not 0% fidelity.
	 */
	fusion_fidelity?: {
		lane_top10_items: number;
		retained_in_final_top10: number;
		ratio: number | null;
	};
	/**
	 * Structural recall ceiling given each evaluated case's evidence reachability
	 * inside this profile's actual candidate pools (vector/keyword LIMIT sizes) — the
	 * best any fusion formula could possibly score, independent of the formula. §7.
	 * `max_mean_recall` is `null` (not 0) when no case was probed.
	 */
	pool_ceiling?: {
		reachable_items: number;
		total_items: number;
		max_mean_recall: number | null;
	};
}

export interface BenchmarkRunIssue {
	case_id: string;
	profile?: RetrievalProfile;
	stage: "insert_documents" | "query" | "lane_probe" | "delete_documents";
	message: string;
}

export interface BenchmarkArtifact {
	dataset: string;
	run_started_at: string;
	run_completed_at: string;
	config: BenchmarkRunConfig & {
		backend: "sqlite" | "postgres";
		vector_enabled: boolean;
		/** ADR-RETRIEVAL-FUSION-RETUNE §5 item 1 — whether the query embedder used
		 * this run applied the BGE asymmetric-retrieval instruction prefix. */
		embed_query_prefix: boolean;
	};
	profile_summaries: BenchmarkProfileSummary[];
	profile_comparison: Array<{
		profile: RetrievalProfile;
		recall_at: Record<string, number>;
		ndcg_at: Record<string, number>;
		candidate_hit_rate: number;
		evaluated_cases: number;
		skipped_cases: number;
	}>;
	case_results: BenchmarkCaseResult[];
	run_issues: BenchmarkRunIssue[];
}
