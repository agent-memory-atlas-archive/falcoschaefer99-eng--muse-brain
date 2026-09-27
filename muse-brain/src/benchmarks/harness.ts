import type { Observation } from "../types";
import type { IBrainStorage, LaneProbeResult } from "../storage/interface";
import type { RetrievalProfile } from "../retrieval/query-signals";
import { resolveCandidatePoolForProfile } from "../retrieval/scoring";
import type {
	BenchmarkArtifact,
	BenchmarkCase,
	BenchmarkCaseResult,
	BenchmarkProfileSummary,
	BenchmarkRunIssue,
	BenchmarkRunConfig
} from "./types";

function makeObservationFromDocument(doc: BenchmarkCase["documents"][number]): Observation {
	return {
		id: doc.id,
		content: doc.content,
		territory: doc.territory ?? "episodic",
		created: doc.created,
		// Intentional benchmark neutral texture:
		// keep Layer B flat for injected benchmark docs so profile deltas are mostly Layer A retrieval behavior.
		texture: doc.texture ?? {
			salience: "background",
			vividness: "soft",
			charge: [],
			grip: "present",
			charge_phase: "fresh"
		},
		context: doc.context,
		type: doc.type,
		tags: doc.tags,
		access_count: 0
	};
}

export function scoreCaseAtK(returnedIds: string[], evidenceIds: string[], k: number): { recall: number; ndcg: number } {
	const relevant = new Set(evidenceIds);
	const window = returnedIds.slice(0, k);
	const hits = window.filter(id => relevant.has(id)).length;

	let dcg = 0;
	for (let i = 0; i < window.length; i++) {
		if (relevant.has(window[i])) {
			dcg += 1 / Math.log2(i + 2);
		}
	}
	const idealCount = Math.min(relevant.size, k);
	let idcg = 0;
	for (let i = 0; i < idealCount; i++) {
		idcg += 1 / Math.log2(i + 2);
	}

	return {
		recall: relevant.size > 0 ? hits / relevant.size : 0,
		ndcg: idcg > 0 ? dcg / idcg : 0
	};
}

export function buildCaseResult(
	testCase: BenchmarkCase,
	profile: RetrievalProfile,
	returnedIds: string[],
	topResults: Array<{ id: string; score: number; match_sources: string[] }>,
	topK: number[],
	options?: {
		force_miss_category?: BenchmarkCaseResult["miss_category"];
		run_error?: string;
		/** Profile-independent probe (same query/embedding); final_rank is derived here, per-profile. */
		lane_probe?: LaneProbeResult;
	}
): BenchmarkCaseResult {
	const recallAt: Record<string, number> = {};
	const ndcgAt: Record<string, number> = {};
	for (const k of topK) {
		const scored = scoreCaseAtK(returnedIds, testCase.evidence_ids, k);
		recallAt[String(k)] = scored.recall;
		ndcgAt[String(k)] = Number(scored.ndcg.toFixed(4));
	}

	const evidenceSet = new Set(testCase.evidence_ids);
	const hitRanks = returnedIds
		.map((id, index) => evidenceSet.has(id) ? index + 1 : 0)
		.filter(rank => rank > 0);

	let missCategory: BenchmarkCaseResult["miss_category"] | undefined;
	if (options?.force_miss_category) missCategory = options.force_miss_category;
	else if (testCase.skip_retrieval_reason === "abstention") missCategory = "abstention";
	else if (testCase.skip_retrieval_reason === "missing_evidence") missCategory = "missing_evidence";
	// Probes have zero evidence_ids by construction, so hitRanks is always empty —
	// without this branch they'd fall into "no_results" (clean) or "candidate_miss"
	// (leaky), silently polluting those tallies with a case type that isn't a real
	// recall miss. See BenchmarkCaseResult.miss_category in types.ts.
	else if (testCase.expect_no_results === true) missCategory = "false_positive_probe";
	else if (returnedIds.length === 0) missCategory = "no_results";
	else if (hitRanks.length === 0) missCategory = "candidate_miss";

	const topScore = topResults.length > 0 ? topResults[0].score : undefined;
	// min_similarity already gates what hybridSearch can return, so "returned
	// something" already means "cleared the confidence bar" — see the field doc.
	const falsePositive = testCase.expect_no_results === true ? returnedIds.length > 0 : undefined;

	const laneProbeResult = options?.lane_probe;
	const laneProbe = laneProbeResult
		? {
			depth: laneProbeResult.depth,
			vector_top1: laneProbeResult.lanes.vector.top1,
			vector_at_depth: laneProbeResult.lanes.vector.at_depth,
			items: laneProbeResult.items.map(item => {
				const finalIndex = returnedIds.indexOf(item.id);
				return {
					evidence_id: item.id,
					vector_position: item.vector_position,
					vector_similarity: item.vector_similarity,
					keyword_position: item.keyword_position,
					keyword_ts_rank: item.keyword_ts_rank,
					final_rank: finalIndex === -1 ? null : finalIndex + 1
				};
			})
		}
		: undefined;

	return {
		case_id: testCase.id,
		dataset: testCase.dataset,
		profile,
		query: testCase.query,
		question_type: testCase.question_type,
		evidence_ids: testCase.evidence_ids,
		returned_ids: returnedIds,
		returned_count: returnedIds.length,
		hit_ranks: hitRanks,
		recall_at: recallAt,
		ndcg_at: ndcgAt,
		candidate_hit: hitRanks.length > 0,
		miss_category: missCategory,
		run_error: options?.run_error,
		top_results: topResults,
		top_score: topScore,
		expect_no_results: testCase.expect_no_results,
		false_positive: falsePositive,
		metadata: testCase.metadata,
		...(laneProbe ? { lane_probe: laneProbe } : {})
	};
}

const VECTOR_RECALL_CUTOFFS = [10, 50, 100] as const;
const KEYWORD_RECALL_CUTOFFS = [10, 30, 100] as const;

/**
 * Aggregates lane_probe data across a profile's evaluated cases into the three
 * §7/§8 diagnostics. Returns undefined when no case in this run carried a
 * lane_probe (i.e. lane_probe wasn't enabled) — there's nothing to report.
 */
export function computeLaneDiagnostics(
	evaluated: BenchmarkCaseResult[],
	profile: RetrievalProfile
): Pick<BenchmarkProfileSummary, "lane_recall" | "fusion_fidelity" | "pool_ceiling"> | undefined {
	const probed = evaluated.filter(result => result.lane_probe);
	if (probed.length === 0) return undefined;

	const pools = resolveCandidatePoolForProfile(profile);

	let totalItems = 0;
	const vectorHits: Record<number, number> = { 10: 0, 50: 0, 100: 0 };
	const keywordHits: Record<number, number> = { 10: 0, 30: 0, 100: 0 };
	let unionHits100 = 0;
	let laneTop10Items = 0;
	let retainedInFinalTop10 = 0;
	let reachableItems = 0;
	let ceilingSum = 0;

	for (const result of probed) {
		const items = result.lane_probe!.items;
		totalItems += items.length;
		let reachableInCase = 0;

		for (const item of items) {
			for (const cutoff of VECTOR_RECALL_CUTOFFS) {
				if (item.vector_position !== null && item.vector_position <= cutoff) vectorHits[cutoff]++;
			}
			for (const cutoff of KEYWORD_RECALL_CUTOFFS) {
				if (item.keyword_position !== null && item.keyword_position <= cutoff) keywordHits[cutoff]++;
			}
			const inVectorTop100 = item.vector_position !== null && item.vector_position <= 100;
			const inKeywordTop100 = item.keyword_position !== null && item.keyword_position <= 100;
			if (inVectorTop100 || inKeywordTop100) unionHits100++;

			if (item.vector_position !== null && item.vector_position <= 10) {
				laneTop10Items++;
				if (item.final_rank !== null && item.final_rank <= 10) retainedInFinalTop10++;
			}

			const reachableInLane =
				(item.vector_position !== null && item.vector_position <= pools.vector)
				|| (item.keyword_position !== null && item.keyword_position <= pools.keyword);
			if (reachableInLane) reachableInCase++;
		}

		reachableItems += reachableInCase;
		if (items.length > 0) ceilingSum += Math.min(reachableInCase, 10) / items.length;
	}

	// null (not 0) on a zero denominator — "nothing to measure" is not "measured
	// and it was zero". A caller printing a bare 0 would read as "0% fidelity" /
	// "0% ceiling" instead of "n/a, no evidence reached this lane at all".
	const fraction = (hits: number): number | null => totalItems > 0 ? Number((hits / totalItems).toFixed(4)) : null;

	return {
		lane_recall: {
			vector: { "10": fraction(vectorHits[10]), "50": fraction(vectorHits[50]), "100": fraction(vectorHits[100]) },
			keyword: { "10": fraction(keywordHits[10]), "30": fraction(keywordHits[30]), "100": fraction(keywordHits[100]) },
			union: { "100": fraction(unionHits100) }
		},
		fusion_fidelity: {
			lane_top10_items: laneTop10Items,
			retained_in_final_top10: retainedInFinalTop10,
			ratio: laneTop10Items > 0 ? Number((retainedInFinalTop10 / laneTop10Items).toFixed(4)) : null
		},
		pool_ceiling: {
			reachable_items: reachableItems,
			total_items: totalItems,
			max_mean_recall: probed.length > 0 ? Number((ceilingSum / probed.length).toFixed(4)) : null
		}
	};
}

export function summarizeProfile(
	profile: RetrievalProfile,
	results: BenchmarkCaseResult[],
	topK: number[]
): BenchmarkProfileSummary {
	const evaluated = results.filter(
		result =>
			result.miss_category !== "abstention"
			&& result.miss_category !== "missing_evidence"
			&& result.miss_category !== "run_error"
			// False-positive probes run hybridSearch for real, but recall/ndcg against
			// zero evidence ids is always 0 by construction — mixing that into the
			// recall aggregate would silently tank it. They get their own metric below.
			&& result.expect_no_results !== true
	);
	const skipped = results.length - evaluated.length;
	const recallAt: Record<string, number> = {};
	const ndcgAt: Record<string, number> = {};

	for (const k of topK) {
		const key = String(k);
		const recallSum = evaluated.reduce((sum, result) => sum + (result.recall_at[key] ?? 0), 0);
		const ndcgSum = evaluated.reduce((sum, result) => sum + (result.ndcg_at[key] ?? 0), 0);
		recallAt[key] = evaluated.length ? Number((recallSum / evaluated.length).toFixed(4)) : 0;
		ndcgAt[key] = evaluated.length ? Number((ndcgSum / evaluated.length).toFixed(4)) : 0;
	}

	const missCategories: Record<string, number> = {};
	for (const result of results) {
		if (!result.miss_category) continue;
		missCategories[result.miss_category] = (missCategories[result.miss_category] ?? 0) + 1;
	}

	const candidateHitRate = evaluated.length
		? Number((evaluated.filter(result => result.candidate_hit).length / evaluated.length).toFixed(4))
		: 0;

	const falsePositiveProbes = results.filter(result => result.expect_no_results === true);
	const falsePositiveRate = falsePositiveProbes.length > 0
		? Number((falsePositiveProbes.filter(result => result.false_positive === true).length / falsePositiveProbes.length).toFixed(4))
		: undefined;

	const laneDiagnostics = computeLaneDiagnostics(evaluated, profile);

	return {
		profile,
		evaluated_cases: evaluated.length,
		skipped_cases: skipped,
		recall_at: recallAt,
		ndcg_at: ndcgAt,
		candidate_hit_rate: candidateHitRate,
		miss_categories: missCategories,
		...(falsePositiveRate !== undefined ? { false_positive_rate: falsePositiveRate } : {}),
		...(laneDiagnostics ?? {})
	};
}

export interface BenchmarkHarnessOptions {
	storage: IBrainStorage;
	backend: "sqlite" | "postgres";
	run_config: BenchmarkRunConfig;
	cases: BenchmarkCase[];
	/** Document-side embedder — always unprefixed (ADR-RETRIEVAL-FUSION-RETUNE §5 item 1). */
	embed_text?: (text: string) => Promise<number[]>;
	/**
	 * Query-side embedder. Falls back to embed_text when absent, so a caller that
	 * only supplies embed_text keeps embedding queries and documents identically
	 * (today's behavior, and the only path exercised before this option existed).
	 */
	embed_query?: (text: string) => Promise<number[]>;
	/**
	 * Echoed verbatim into BenchmarkArtifact.config for provenance, same role as
	 * vector_enabled below — the harness never reads this to decide anything, it
	 * just calls whichever function(s) it's given. Records whether the supplied
	 * embed_query applied the BGE query instruction prefix.
	 */
	embed_query_prefix?: boolean;
}

/**
 * A depth smaller than a benchmarked profile's own candidate_pool would silently
 * understate reachability for that profile (a case's evidence could sit at
 * position 60 in the vector lane — reachable within `balanced`'s pool of 80 —
 * but probeLanes at depth 50 would never see it, reporting an artificially low
 * ceiling). Raise (never lower) the configured depth to cover the largest
 * vector/keyword pool among the profiles actually being run this call.
 */
function computeEffectiveLaneProbeDepth(configuredDepth: number, profiles: RetrievalProfile[]): number {
	let maxPool = 0;
	for (const profile of profiles) {
		const pools = resolveCandidatePoolForProfile(profile);
		maxPool = Math.max(maxPool, pools.vector, pools.keyword);
	}
	return Math.max(configuredDepth, maxPool);
}

export async function runBenchmarkHarness(options: BenchmarkHarnessOptions): Promise<BenchmarkArtifact> {
	const startedAt = new Date().toISOString();
	const storage = options.storage;
	const caseResults: BenchmarkCaseResult[] = [];
	const runIssues: BenchmarkRunIssue[] = [];

	let effectiveLaneProbeDepth: number | undefined;
	if (options.run_config.lane_probe?.enabled) {
		effectiveLaneProbeDepth = computeEffectiveLaneProbeDepth(
			options.run_config.lane_probe.depth,
			options.run_config.profiles
		);
		if (effectiveLaneProbeDepth > options.run_config.lane_probe.depth) {
			console.log(
				`[lane_probe] raised depth ${options.run_config.lane_probe.depth} -> ${effectiveLaneProbeDepth} to cover the largest run profile's candidate_pool`
			);
		}
	}

	for (const testCase of options.cases) {
		if (testCase.skip_retrieval_reason) {
			for (const profile of options.run_config.profiles) {
				caseResults.push(buildCaseResult(
					testCase,
					profile,
					[],
					[],
					options.run_config.top_k
				));
			}
			continue;
		}

		const observations = testCase.documents.map(makeObservationFromDocument);
		let caseReadyForQuery = true;
		try {
			for (const observation of observations) {
				await storage.appendToTerritory("episodic", observation);
				if (options.embed_text) {
					const embedding = await options.embed_text(observation.content);
					await storage.updateObservationEmbedding(observation.id, embedding);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			runIssues.push({
				case_id: testCase.id,
				stage: "insert_documents",
				message
			});
			caseReadyForQuery = false;
		}

		let queryEmbedding: number[] | undefined;
		if (caseReadyForQuery && options.embed_text) {
			try {
				queryEmbedding = await (options.embed_query ?? options.embed_text)(testCase.query);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runIssues.push({
					case_id: testCase.id,
					stage: "query",
					message: `query_embedding: ${message}`
				});
				caseReadyForQuery = false;
			}
		}

		// Profile-independent: same query/embedding regardless of which profile scores
		// it, so probe once per case, not once per (case, profile) pair.
		let laneProbe: LaneProbeResult | undefined;
		if (caseReadyForQuery && options.run_config.lane_probe?.enabled && testCase.evidence_ids.length > 0) {
			try {
				laneProbe = await storage.probeLanes({
					query: testCase.query,
					embedding: queryEmbedding,
					ids: testCase.evidence_ids,
					depth: effectiveLaneProbeDepth ?? options.run_config.lane_probe.depth
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runIssues.push({
					case_id: testCase.id,
					stage: "lane_probe",
					message
				});
			}
		}

		for (const profile of options.run_config.profiles) {
			if (!caseReadyForQuery) {
				caseResults.push(buildCaseResult(
					testCase,
					profile,
					[],
					[],
					options.run_config.top_k,
					{
						force_miss_category: "run_error",
						run_error: "case_setup_failed"
					}
				));
				continue;
			}

			try {
				const results = await storage.hybridSearch({
					query: testCase.query,
					embedding: queryEmbedding,
					retrieval_profile: profile,
					limit: options.run_config.result_limit,
					min_similarity: options.run_config.min_similarity,
					rerank_mode: options.run_config.rerank_mode,
					rerank_top_n: options.run_config.rerank_top_n,
					profile_overrides: options.run_config.profile_overrides
				});

				caseResults.push(buildCaseResult(
					testCase,
					profile,
					results.map(result => result.observation.id),
					results.map(result => ({
						id: result.observation.id,
						score: Number(result.score.toFixed(4)),
						match_sources: result.match_sources
					})),
					options.run_config.top_k,
					laneProbe ? { lane_probe: laneProbe } : undefined
				));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runIssues.push({
					case_id: testCase.id,
					profile,
					stage: "query",
					message
				});
				caseResults.push(buildCaseResult(
					testCase,
					profile,
					[],
					[],
					options.run_config.top_k,
					{
						force_miss_category: "run_error",
						run_error: message
					}
				));
			}
		}

		for (const observation of observations) {
			try {
				await storage.deleteObservation(observation.id);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runIssues.push({
					case_id: testCase.id,
					stage: "delete_documents",
					message: `${observation.id}: ${message}`
				});
			}
		}
	}

	const profileSummaries = options.run_config.profiles.map(profile =>
		summarizeProfile(
			profile,
			caseResults.filter(result => result.profile === profile),
			options.run_config.top_k
		)
	);

	const completedAt = new Date().toISOString();
	return {
		dataset: options.run_config.dataset,
		run_started_at: startedAt,
		run_completed_at: completedAt,
		config: {
			...options.run_config,
			backend: options.backend,
			vector_enabled: Boolean(options.embed_text),
			embed_query_prefix: Boolean(options.embed_query_prefix)
		},
		profile_summaries: profileSummaries,
		profile_comparison: profileSummaries.map(summary => ({
			profile: summary.profile,
			recall_at: summary.recall_at,
			ndcg_at: summary.ndcg_at,
			candidate_hit_rate: summary.candidate_hit_rate,
			evaluated_cases: summary.evaluated_cases,
			skipped_cases: summary.skipped_cases
		})),
		case_results: caseResults,
		run_issues: runIssues
	};
}

export function renderBenchmarkSummaryMarkdown(artifact: BenchmarkArtifact): string {
	const topK = Array.from(
		new Set(
			(artifact.config.top_k ?? [])
				.map(value => Number(value))
				.filter(value => Number.isFinite(value) && value > 0)
		)
	).sort((a, b) => a - b);
	const effectiveTopK = topK.length > 0 ? topK : [1, 5, 10];
	const recallHeaders = effectiveTopK.map(k => `R@${k}`);
	const ndcgHeaders = effectiveTopK.map(k => `NDCG@${k}`);
	const headerColumns = ["Profile", ...recallHeaders, ...ndcgHeaders, "Candidate Hit", "Evaluated", "Skipped"];
	const lines = [
		`# MUSE Brain Benchmark Run — ${artifact.dataset}`,
		"",
		`- Started: ${artifact.run_started_at}`,
		`- Completed: ${artifact.run_completed_at}`,
		`- Backend: ${artifact.config.backend}`,
		`- Vector enabled: ${artifact.config.vector_enabled}`,
		`- Embed query prefix: ${artifact.config.embed_query_prefix}`,
		`- Run issues: ${artifact.run_issues.length}`,
		"",
		`| ${headerColumns.join(" | ")} |`,
		`| ${["---", ...headerColumns.slice(1).map(() => "---:")].join(" | ")} |`
	];

	for (const summary of artifact.profile_summaries) {
		const recallCells = effectiveTopK.map(k => summary.recall_at[String(k)] ?? 0);
		const ndcgCells = effectiveTopK.map(k => summary.ndcg_at[String(k)] ?? 0);
		lines.push(`| ${summary.profile} | ${[...recallCells, ...ndcgCells, summary.candidate_hit_rate, summary.evaluated_cases, summary.skipped_cases].join(" | ")} |`);
	}

	// Lane diagnostics (ADR-RETRIEVAL-FUSION-RETUNE §8) — only present when
	// `BenchmarkRunConfig.lane_probe.enabled` was true for this run.
	for (const summary of artifact.profile_summaries) {
		if (!summary.lane_recall && !summary.fusion_fidelity && !summary.pool_ceiling) continue;

		lines.push("", `## Lane diagnostics — ${summary.profile}`);

		const probedCases = artifact.case_results.filter(result => result.profile === summary.profile && result.lane_probe);
		if (probedCases.length > 0) {
			lines.push(
				"",
				"| Case | Evidence ID | Vector Position | Vector Sim | Keyword Position | Keyword ts_rank | Final Rank |",
				"| --- | --- | ---: | ---: | ---: | ---: | ---: |"
			);
			for (const result of probedCases) {
				for (const item of result.lane_probe!.items) {
					const vectorSim = item.vector_similarity !== null ? item.vector_similarity.toFixed(4) : "-";
					const keywordTsRank = item.keyword_ts_rank !== null ? item.keyword_ts_rank.toFixed(4) : "-";
					lines.push(
						`| ${result.case_id} | ${item.evidence_id} | ${item.vector_position ?? "-"} | ${vectorSim} | ${item.keyword_position ?? "-"} | ${keywordTsRank} | ${item.final_rank ?? "-"} |`
					);
				}
			}
		}

		if (summary.lane_recall) {
			const { vector, keyword, union } = summary.lane_recall;
			const pct = (value: number | null): string => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
			lines.push(
				"",
				`- Lane recall: vector@10 ${pct(vector["10"])}, vector@50 ${pct(vector["50"])}, vector@100 ${pct(vector["100"])}, `
				+ `keyword@10 ${pct(keyword["10"])}, keyword@30 ${pct(keyword["30"])}, keyword@100 ${pct(keyword["100"])}, `
				+ `union@100 ${pct(union["100"])}`
			);
		}
		if (summary.fusion_fidelity) {
			const { retained_in_final_top10, lane_top10_items, ratio } = summary.fusion_fidelity;
			const ratioText = ratio === null ? "n/a (0 items)" : String(ratio);
			lines.push("", `- Fusion fidelity: ${retained_in_final_top10}/${lane_top10_items} = ${ratioText}`);
		}
		if (summary.pool_ceiling) {
			const { reachable_items, total_items, max_mean_recall } = summary.pool_ceiling;
			const ceilingText = max_mean_recall === null ? "n/a (0 items)" : String(max_mean_recall);
			lines.push(`- Pool ceiling (${summary.profile}): ${reachable_items}/${total_items} evidence items reachable, max mean R@10 = ${ceilingText}`);
		}
	}

	return lines.join("\n");
}
