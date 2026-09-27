import { describe, expect, it, vi } from "vitest";

import { adaptBenchmarkDataset } from "../src/benchmarks/adapters/index";
import { adaptCognitiveAdvantage } from "../src/benchmarks/adapters/cognitive-advantage";
import { adaptLongMemEval } from "../src/benchmarks/adapters/longmemeval";
import { adaptLoCoMo } from "../src/benchmarks/adapters/locomo";
import { parseBenchmarkCliArgs } from "../src/benchmarks/cli";
import {
	buildCaseResult,
	renderBenchmarkSummaryMarkdown,
	runBenchmarkHarness,
	scoreCaseAtK,
	summarizeProfile
} from "../src/benchmarks/harness";
import type { BenchmarkCase } from "../src/benchmarks/types";
import { createStorage } from "../src/storage/factory";
import type { LaneProbeResult } from "../src/storage/interface";

function makeCase(overrides?: Partial<BenchmarkCase>): BenchmarkCase {
	return {
		id: "case_1",
		dataset: "longmemeval",
		query: "alpha",
		evidence_ids: ["doc_hit"],
		documents: [
			{
				id: "doc_hit",
				content: "alpha memory",
				created: "2026-04-01T00:00:00.000Z"
			}
		],
		...overrides
	};
}

describe("benchmark adapters", () => {
	it("adapts LongMemEval instances into benchmark cases", () => {
		const cases = adaptLongMemEval([{
			question_id: "q_1",
			question_type: "single-session-user",
			question: "What tea do I like?",
			answer: "oolong",
			question_date: "2026-04-01T00:00:00.000Z",
			haystack_session_ids: ["sess_1", "sess_2"],
			haystack_dates: ["2026-03-01T00:00:00.000Z", "2026-03-05T00:00:00.000Z"],
			haystack_sessions: [
				[{ role: "user", content: "I like oolong tea." }],
				[{ role: "assistant", content: "Noted." }]
			],
			answer_session_ids: ["sess_1"]
		}]);

		expect(cases).toHaveLength(1);
		expect(cases[0].documents).toHaveLength(2);
		expect(cases[0].evidence_ids).toEqual(["sess_1"]);
		expect(cases[0].documents[0].content).toContain("user: I like oolong tea.");
	});

	it("adapts LoCoMo QA entries and skips missing-evidence cases", () => {
		const cases = adaptLoCoMo([{
			sample_id: "sample_1",
			conversation: {
				speaker_a: "Alice",
				speaker_b: "Bob",
				session_1_date_time: "2026-03-01T00:00:00.000Z",
				session_1: [
					{ speaker: "Alice", dia_id: "d1", text: "I adopted a cat." },
					{ speaker: "Bob", dia_id: "d2", text: "Cute." }
				]
			},
			qa: [
				{ question: "What pet did Alice adopt?", answer: "a cat", category: "memory", evidence: ["d1"] },
				{ question: "What color was the moon?", answer: "unknown", category: "abstention", evidence: [] }
			]
		}]);

		expect(cases).toHaveLength(2);
		expect(cases[0].documents).toHaveLength(2);
		expect(cases[1].skip_retrieval_reason).toBe("missing_evidence");
	});

	it("validates adapter input shape", () => {
		expect(() => adaptBenchmarkDataset("longmemeval", { bad: true })).toThrow(/json array/i);
		expect(() => adaptBenchmarkDataset("locomo", [null])).toThrow(/contain objects/i);
	});

	it("handles LongMemEval abstention signals and emits adapter warnings", () => {
		const abstention = adaptLongMemEval([{
			question_id: "q_abs",
			question_type: "abstention",
			question: "What was never said?",
			answer: "unknown",
			haystack_session_ids: ["sess_1", "sess_2"],
			haystack_dates: ["2026-03-01T00:00:00.000Z"],
			haystack_sessions: [
				[{ role: "user", content: "hello" }]
			],
			answer_session_ids: []
		}])[0];
		expect(abstention.skip_retrieval_reason).toBe("abstention");
		expect(abstention.metadata?.abstention_source).toBe("question_type");
		expect((abstention.metadata?.adapter_warnings as string[]).some(w => w.includes("haystack_session_ids"))).toBe(true);

		const missingEvidence = adaptLongMemEval([{
			question_id: "q_missing",
			question_type: "single-session-user",
			question: "What did I say?",
			answer: "I don't know",
			haystack_session_ids: ["sess_1"],
			haystack_dates: ["2026-03-01T00:00:00.000Z"],
			haystack_sessions: [
				[{ role: "user", content: "hello" }]
			],
			answer_session_ids: []
		}])[0];
		expect(missingEvidence.skip_retrieval_reason).toBe("missing_evidence");
	});

	it("cognitive_advantage: a zero-evidence case is skipped as missing_evidence by default", () => {
		const cases = adaptCognitiveAdvantage([{
			case_id: "neg_default",
			query: "what's the GPU price again?",
			family: "surfacer_rook",
			evidence_ids: [],
			documents: [],
			use_existing_memory: true
		}]);

		expect(cases[0].skip_retrieval_reason).toBe("missing_evidence");
		expect(cases[0].expect_no_results).toBeUndefined();
	});

	it("cognitive_advantage: expect_no_results:true overrides the missing_evidence skip", () => {
		const cases = adaptCognitiveAdvantage([{
			case_id: "neg_probe",
			query: "what's the GPU price again?",
			family: "surfacer_rook",
			evidence_ids: [],
			documents: [],
			use_existing_memory: true,
			expect_no_results: true
		}]);

		expect(cases[0].skip_retrieval_reason).toBeUndefined();
		expect(cases[0].expect_no_results).toBe(true);
	});
});

describe("benchmark scoring math", () => {
	it("computes true recall@k for multi-evidence questions", () => {
		const scored = scoreCaseAtK(["a", "noise"], ["a", "b", "c"], 2);
		expect(scored.recall).toBeCloseTo(1 / 3, 6);
	});

	it("computes NDCG and handles misses", () => {
		expect(scoreCaseAtK(["a"], ["a"], 1)).toEqual({ recall: 1, ndcg: 1 });
		expect(scoreCaseAtK(["x", "y"], ["a", "b"], 2)).toEqual({ recall: 0, ndcg: 0 });
	});
});

describe("benchmark pure helpers", () => {
	it("honors miss-category precedence including run_error override", () => {
		const baseCase = makeCase({ evidence_ids: ["doc_hit"] });
		expect(buildCaseResult(
			{ ...baseCase, skip_retrieval_reason: "abstention" },
			"native",
			[],
			[],
			[1]
		).miss_category).toBe("abstention");
		expect(buildCaseResult(
			{ ...baseCase, skip_retrieval_reason: "missing_evidence" },
			"native",
			[],
			[],
			[1]
		).miss_category).toBe("missing_evidence");
		expect(buildCaseResult(baseCase, "native", [], [], [1]).miss_category).toBe("no_results");
		expect(buildCaseResult(baseCase, "native", ["doc_noise"], [], [1]).miss_category).toBe("candidate_miss");
		expect(buildCaseResult(
			baseCase,
			"native",
			[],
			[],
			[1],
			{ force_miss_category: "run_error", run_error: "boom" }
		).miss_category).toBe("run_error");
	});

	it("excludes skipped + run_error from profile denominators", () => {
		const evalResult = buildCaseResult(
			makeCase({ evidence_ids: ["doc_hit", "doc_missing"] }),
			"native",
			["doc_hit"],
			[],
			[1, 5]
		);
		const skippedResult = buildCaseResult(
			makeCase({ id: "case_abs", skip_retrieval_reason: "abstention" }),
			"native",
			[],
			[],
			[1, 5]
		);
		const runErrorResult = buildCaseResult(
			makeCase({ id: "case_err" }),
			"native",
			[],
			[],
			[1, 5],
			{ force_miss_category: "run_error", run_error: "query failed" }
		);

		const summary = summarizeProfile("native", [evalResult, skippedResult, runErrorResult], [1, 5]);
		expect(summary.evaluated_cases).toBe(1);
		expect(summary.skipped_cases).toBe(2);
		expect(summary.recall_at["1"]).toBe(0.5);
		expect(summary.recall_at["5"]).toBe(0.5);
	});

	it("scores expect_no_results cases as false-positive probes, not recall misses", () => {
		const probeCase = makeCase({ id: "case_probe", evidence_ids: [], documents: [], expect_no_results: true });

		const clean = buildCaseResult(probeCase, "native", [], [], [1]);
		expect(clean.expect_no_results).toBe(true);
		expect(clean.returned_count).toBe(0);
		expect(clean.top_score).toBeUndefined();
		expect(clean.false_positive).toBe(false);

		const leaky = buildCaseResult(
			probeCase,
			"native",
			["doc_unexpected"],
			[{ id: "doc_unexpected", score: 0.42, match_sources: ["keyword"] }],
			[1]
		);
		expect(leaky.false_positive).toBe(true);
		expect(leaky.top_score).toBe(0.42);
		// Zero evidence ids means recall/ndcg are structurally 0 regardless — the
		// signal lives in false_positive, not in the recall aggregate.
		expect(leaky.recall_at["1"]).toBe(0);
		// A leaky probe must NOT be tallied as a real recall miss (candidate_miss) —
		// it gets its own category so miss_categories stays honest.
		expect(leaky.miss_category).toBe("false_positive_probe");
		expect(leaky.miss_category).not.toBe("candidate_miss");
		expect(clean.miss_category).toBe("false_positive_probe");
		expect(clean.miss_category).not.toBe("no_results");
	});

	it("a normal case (expect_no_results unset) never gets a false_positive verdict", () => {
		const result = buildCaseResult(makeCase(), "native", ["doc_hit"], [], [1]);
		expect(result.expect_no_results).toBeUndefined();
		expect(result.false_positive).toBeUndefined();
	});

	it("rolls false-positive probes into false_positive_rate, excluded from recall/ndcg", () => {
		const cleanProbe = buildCaseResult(
			makeCase({ id: "probe_clean", evidence_ids: [], documents: [], expect_no_results: true }),
			"native", [], [], [1]
		);
		const leakyProbe = buildCaseResult(
			makeCase({ id: "probe_leaky", evidence_ids: [], documents: [], expect_no_results: true }),
			"native", ["doc_unexpected"], [{ id: "doc_unexpected", score: 0.9, match_sources: ["vector"] }], [1]
		);
		const realHit = buildCaseResult(makeCase(), "native", ["doc_hit"], [], [1]);

		const summary = summarizeProfile("native", [cleanProbe, leakyProbe, realHit], [1]);

		expect(summary.false_positive_rate).toBe(0.5);
		// Only the real recall case counts toward evaluated_cases/recall — both probes
		// are excluded, same as abstention/missing_evidence.
		expect(summary.evaluated_cases).toBe(1);
		expect(summary.recall_at["1"]).toBe(1);
		// Both probes (clean + leaky) land under their own category, not mixed into
		// candidate_miss/no_results — miss_categories must stay a real-miss tally.
		expect(summary.miss_categories.false_positive_probe).toBe(2);
		expect(summary.miss_categories.candidate_miss).toBeUndefined();
		expect(summary.miss_categories.no_results).toBeUndefined();
	});

	it("omits false_positive_rate entirely when a profile ran no expect_no_results probes", () => {
		const realHit = buildCaseResult(makeCase(), "native", ["doc_hit"], [], [1]);
		const summary = summarizeProfile("native", [realHit], [1]);
		expect(summary.false_positive_rate).toBeUndefined();
	});

	it("omits lane_recall/fusion_fidelity/pool_ceiling entirely when lane_probe never ran", () => {
		const realHit = buildCaseResult(makeCase(), "native", ["doc_hit"], [], [1]);
		const summary = summarizeProfile("native", [realHit], [1]);
		expect(summary.lane_recall).toBeUndefined();
		expect(summary.fusion_fidelity).toBeUndefined();
		expect(summary.pool_ceiling).toBeUndefined();
	});

	it("computes fusion_fidelity, pool_ceiling, and lane_recall arithmetic from lane_probe data (native pools: vector 50 / keyword 30)", () => {
		// Case 1: e1 is a vector top-10 hit that survives fusion (final_rank 1);
		// e2 is vector top-50-but-not-top-10, and is never returned at all.
		const probe1: LaneProbeResult = {
			depth: 50,
			lanes: { vector: { returned: 50, top1: 0, at_depth: 2 }, keyword: { returned: 0, top1: 0, at_depth: 0 } },
			items: [
				{ id: "e1", vector_position: 3, vector_similarity: 0.9, keyword_position: null, keyword_ts_rank: null },
				{ id: "e2", vector_position: 15, vector_similarity: 0.7, keyword_position: null, keyword_ts_rank: null }
			]
		};
		const case1 = buildCaseResult(
			makeCase({ id: "case_1", evidence_ids: ["e1", "e2"] }),
			"native",
			["e1", "other"],
			[],
			[10],
			{ lane_probe: probe1 }
		);

		// Case 2: e3 is ALSO a vector top-10 hit, but is discarded by fusion entirely
		// (final_rank null) — mirrors the ADR's "fusion discards vector top-10 hits" disease.
		const probe2: LaneProbeResult = {
			depth: 50,
			lanes: { vector: { returned: 50, top1: 0, at_depth: 1 }, keyword: { returned: 0, top1: 0, at_depth: 0 } },
			items: [
				{ id: "e3", vector_position: 5, vector_similarity: 0.8, keyword_position: null, keyword_ts_rank: null }
			]
		};
		const case2 = buildCaseResult(
			makeCase({ id: "case_2", evidence_ids: ["e3"] }),
			"native",
			["other2", "other3"],
			[],
			[10],
			{ lane_probe: probe2 }
		);

		// buildCaseResult derives final_rank from returnedIds — confirm the fixture landed as designed.
		expect(case1.lane_probe?.items.find(i => i.evidence_id === "e1")?.final_rank).toBe(1);
		expect(case1.lane_probe?.items.find(i => i.evidence_id === "e2")?.final_rank).toBeNull();
		expect(case2.lane_probe?.items.find(i => i.evidence_id === "e3")?.final_rank).toBeNull();

		const summary = summarizeProfile("native", [case1, case2], [10]);

		// 2 of 3 total evidence items sit in vector top-10 (e1 rank3, e3 rank5); only
		// e1 survives into the final top-10 → 1/2 = 0.5.
		expect(summary.fusion_fidelity).toEqual({ lane_top10_items: 2, retained_in_final_top10: 1, ratio: 0.5 });

		// All 3 items are reachable within native pools (vector 50): case1 has 2/2
		// reachable (ceiling 1.0), case2 has 1/1 (ceiling 1.0) → mean 1.0.
		expect(summary.pool_ceiling).toEqual({ reachable_items: 3, total_items: 3, max_mean_recall: 1 });

		// vector recall@10 = 2/3 (e1, e3); @50 and @100 = 3/3 (all three ranks <= 50).
		expect(summary.lane_recall?.vector["10"]).toBeCloseTo(2 / 3, 4);
		expect(summary.lane_recall?.vector["50"]).toBe(1);
		expect(summary.lane_recall?.vector["100"]).toBe(1);
		// No keyword data in this fixture — keyword recall is structurally 0 throughout.
		expect(summary.lane_recall?.keyword["10"]).toBe(0);
		expect(summary.lane_recall?.keyword["30"]).toBe(0);
		expect(summary.lane_recall?.keyword["100"]).toBe(0);
		// Union@100 doesn't improve on vector alone here (keyword contributes nothing).
		expect(summary.lane_recall?.union["100"]).toBe(1);
	});

	it("returns null (not 0) for fusion_fidelity.ratio when zero evidence items sit in the vector lane's top-10", () => {
		// e1 is reachable (rank 15) but never inside the top-10 — laneTop10Items stays 0,
		// so "0 of 0 survived" must read as n/a, not as 0% fidelity.
		const probe: LaneProbeResult = {
			depth: 50,
			lanes: { vector: { returned: 50, top1: 0, at_depth: 1 }, keyword: { returned: 0, top1: 0, at_depth: 0 } },
			items: [
				{ id: "e1", vector_position: 15, vector_similarity: 0.6, keyword_position: null, keyword_ts_rank: null }
			]
		};
		const result = buildCaseResult(
			makeCase({ id: "case_no_top10", evidence_ids: ["e1"] }),
			"native",
			[],
			[],
			[10],
			{ lane_probe: probe }
		);

		const summary = summarizeProfile("native", [result], [10]);

		expect(summary.fusion_fidelity).toEqual({ lane_top10_items: 0, retained_in_final_top10: 0, ratio: null });
		// totalItems is still 1 here (e1 exists, just outside top-10) — lane_recall and
		// pool_ceiling denominators are unaffected by fusion_fidelity's own zero.
		expect(summary.lane_recall?.vector["10"]).toBe(0);
		expect(summary.pool_ceiling?.max_mean_recall).not.toBeNull();
	});
});

describe("benchmark harness integration", () => {
	it("runs profile-based retrieval and produces summaries + miss analysis", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native", "balanced", "benchmark"],
				top_k: [1, 5, 10],
				result_limit: 10,
				min_similarity: 0.01
			},
			cases: adaptLongMemEval([{
				question_id: "q_tea",
				question_type: "single-session-user",
				question: "What tea do I like?",
				answer: "oolong",
				question_date: "2026-04-01T00:00:00.000Z",
				haystack_session_ids: ["sess_hit", "sess_noise"],
				haystack_dates: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
				haystack_sessions: [
					[{ role: "user", content: "I like oolong tea." }],
					[{ role: "assistant", content: "The weather is mild." }]
				],
				answer_session_ids: ["sess_hit"]
			}])
		});

		expect(artifact.profile_summaries).toHaveLength(3);
		expect(artifact.profile_summaries.every(summary => summary.recall_at["1"] === 1)).toBe(true);
		expect(artifact.case_results).toHaveLength(3);
		expect(artifact.run_issues).toEqual([]);
		expect(artifact.profile_comparison[0].recall_at["1"]).toBe(1);
		expect(renderBenchmarkSummaryMarkdown(artifact)).toContain("Run issues: 0");
	});

	it("uses fractional recall when only part of evidence set is retrieved", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-multi-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase({
				id: "case_multi",
				query: "alpha memory",
				evidence_ids: ["doc_hit", "doc_missing"],
				documents: [
					{ id: "doc_hit", content: "alpha memory", created: "2026-03-01T00:00:00.000Z" },
					{ id: "doc_noise", content: "unrelated", created: "2026-03-01T00:00:00.000Z" }
				]
			})]
		});

		expect(artifact.case_results).toHaveLength(1);
		expect(artifact.case_results[0].recall_at["1"]).toBe(0.5);
	});

	it("runs hybridSearch for real on an expect_no_results case (no skip) and scores it as a false-positive probe", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-fp-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		let hybridSearchCalls = 0;
		const originalHybridSearch = storage.hybridSearch.bind(storage);
		(storage as any).hybridSearch = async (options: any) => {
			hybridSearchCalls += 1;
			return originalHybridSearch(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "cognitive_advantage",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: adaptCognitiveAdvantage([{
				case_id: "probe_live",
				query: "GPU price comparison for the P40",
				family: "surfacer_rook",
				evidence_ids: [],
				documents: [],
				use_existing_memory: true,
				expect_no_results: true
			}])
		});

		// A bare missing_evidence case never reaches hybridSearch (see the
		// "skips abstention cases before document insert" test below for the
		// contrast) — expect_no_results must actually run the query.
		expect(hybridSearchCalls).toBe(1);
		expect(artifact.case_results).toHaveLength(1);
		const [result] = artifact.case_results;
		expect(result.miss_category).not.toBe("missing_evidence");
		expect(result.miss_category).toBe("false_positive_probe");
		expect(result.expect_no_results).toBe(true);
		expect(result.returned_count).toBe(0);
		expect(result.false_positive).toBe(false);
		expect(artifact.profile_summaries[0].false_positive_rate).toBe(0);
		// Excluded from the recall aggregate, same as any other zero-evidence skip lane.
		expect(artifact.profile_summaries[0].evaluated_cases).toBe(0);
		expect(artifact.profile_summaries[0].miss_categories.no_results).toBeUndefined();
		expect(artifact.profile_summaries[0].miss_categories.candidate_miss).toBeUndefined();
	});

	it("skips abstention cases before document insert", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-skip-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		let appendCalls = 0;
		const originalAppend = storage.appendToTerritory.bind(storage);
		(storage as any).appendToTerritory = async (...args: any[]) => {
			appendCalls += 1;
			return originalAppend(...args);
		};

		await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native", "benchmark"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase({
				id: "case_abs",
				skip_retrieval_reason: "abstention",
				documents: [
					{ id: "doc1", content: "will not insert", created: "2026-03-01T00:00:00.000Z" }
				]
			})]
		});

		expect(appendCalls).toBe(0);
	});

	it("records query failures and continues other profiles", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-errors-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const originalHybridSearch = storage.hybridSearch.bind(storage);
		(storage as any).hybridSearch = async (options: any) => {
			if (options.retrieval_profile === "balanced") throw new Error("synthetic failure");
			return originalHybridSearch(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native", "balanced", "benchmark"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()]
		});

		expect(artifact.case_results).toHaveLength(3);
		expect(artifact.case_results.find(result => result.profile === "balanced")?.miss_category).toBe("run_error");
		expect(artifact.run_issues).toHaveLength(1);
		expect(artifact.profile_summaries.find(summary => summary.profile === "balanced")?.evaluated_cases).toBe(0);
	});

	it("executes vector path when embed_text is provided, and the query embedding reaches hybridSearch", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-vector-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const embedded: string[] = [];
		const hybridSearchEmbeddings: (number[] | undefined)[] = [];
		const originalHybridSearch = storage.hybridSearch.bind(storage);
		(storage as any).hybridSearch = async (options: any) => {
			hybridSearchEmbeddings.push(options.embedding);
			return originalHybridSearch(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native", "balanced", "benchmark"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()],
			embed_text: async (text: string) => {
				embedded.push(text);
				return [0.5, 0.2, 0.1];
			}
		});

		expect(artifact.config.vector_enabled).toBe(true);
		// One document embed + one query embed — NOT re-embedded per profile
		// (the case's queryEmbedding is computed once and reused across all
		// three profiles below).
		expect(embedded).toEqual(["alpha memory", "alpha"]);
		expect(hybridSearchEmbeddings).toHaveLength(3);
		expect(hybridSearchEmbeddings.every(embedding => embedding && embedding[0] === 0.5)).toBe(true);
	});

	it("without embed_text, vector_enabled is false and hybridSearch receives no embedding", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-no-vector-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const hybridSearchEmbeddings: (number[] | undefined)[] = [];
		const originalHybridSearch = storage.hybridSearch.bind(storage);
		(storage as any).hybridSearch = async (options: any) => {
			hybridSearchEmbeddings.push(options.embedding);
			return originalHybridSearch(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()]
		});

		expect(artifact.config.vector_enabled).toBe(false);
		expect(hybridSearchEmbeddings).toEqual([undefined]);
	});

	it("uses embed_query for the query and embed_text for documents when both are supplied (ADR-RETRIEVAL-FUSION-RETUNE §5 item 1)", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-embed-query-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const documentTexts: string[] = [];
		const queryTexts: string[] = [];

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()],
			embed_text: async (text: string) => {
				documentTexts.push(text);
				return [0.5, 0.2, 0.1];
			},
			embed_query: async (text: string) => {
				queryTexts.push(text);
				return [0.9, 0.1, 0.1];
			},
			embed_query_prefix: true
		});

		// Document embedding still goes through embed_text — never embed_query.
		expect(documentTexts).toEqual(["alpha memory"]);
		// Query embedding goes through embed_query — never embed_text.
		expect(queryTexts).toEqual(["alpha"]);
		expect(artifact.config.embed_query_prefix).toBe(true);
		expect(renderBenchmarkSummaryMarkdown(artifact)).toContain("- Embed query prefix: true");
	});

	it("falls back to embed_text for the query when embed_query is absent", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-embed-query-fallback-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()],
			embed_text: async () => [0.5, 0.2, 0.1]
		});

		// embed_query_prefix defaults to false when not supplied, regardless of vector_enabled.
		expect(artifact.config.embed_query_prefix).toBe(false);
	});

	it("uses configured top_k values in profile comparison and markdown", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-topk-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [2],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()]
		});

		expect(artifact.profile_comparison[0].recall_at["2"]).toBe(1);
		expect(artifact.profile_comparison[0].ndcg_at["2"]).toBe(1);
		const markdown = renderBenchmarkSummaryMarkdown(artifact);
		expect(markdown).toContain("| Profile | R@2 | NDCG@2 | Candidate Hit | Evaluated | Skipped |");
	});

	it("attaches lane_probe per case (once, shared across profiles) when run_config.lane_probe.enabled, and renders the lane table", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-laneprobe-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		let probeLanesCalls = 0;
		const originalProbeLanes = storage.probeLanes.bind(storage);
		(storage as any).probeLanes = async (options: any) => {
			probeLanesCalls += 1;
			return originalProbeLanes(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native", "balanced"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01,
				lane_probe: { enabled: true, depth: 50 }
			},
			cases: [makeCase()]
		});

		// One case, two profiles — probeLanes must run once per CASE, not once per
		// (case, profile) pair (query/embedding don't vary by profile).
		expect(probeLanesCalls).toBe(1);
		expect(artifact.case_results).toHaveLength(2);
		for (const result of artifact.case_results) {
			// Configured depth was 50, but "native"/"balanced" both alias to "fused"
			// (ADR-RETRIEVAL-FUSION-RETUNE §9), whose vector pool is 100 — the harness
			// raises the effective depth to cover it (never lowers), and reports that
			// raised value back on the result.
			expect(result.lane_probe?.depth).toBe(100);
			const item = result.lane_probe?.items.find(i => i.evidence_id === "doc_hit");
			expect(item?.keyword_position).toBe(1);
			expect(item?.final_rank).toBe(1);
		}

		const markdown = renderBenchmarkSummaryMarkdown(artifact);
		expect(markdown).toContain("## Lane diagnostics — native");
		expect(markdown).toContain("| Case | Evidence ID | Vector Position | Vector Sim | Keyword Position | Keyword ts_rank | Final Rank |");
		expect(markdown).toContain("| case_1 | doc_hit |");
		expect(markdown).toMatch(/- Fusion fidelity: \d+\/\d+ = /);
		expect(markdown).toMatch(/- Pool ceiling \(native\): \d+\/\d+ evidence items reachable/);
	});

	it("does not raise the configured depth when it already covers every run profile's pools", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-laneprobe-nocap-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01,
				// native's own pools (vector 50 / keyword 30) are both <= 200.
				lane_probe: { enabled: true, depth: 200 }
			},
			cases: [makeCase()]
		});

		expect(artifact.case_results[0].lane_probe?.depth).toBe(200);
	});

	it("does not call probeLanes or attach lane_probe when lane_probe is absent from run_config", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-nolaneprobe-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		let probeLanesCalls = 0;
		const originalProbeLanes = storage.probeLanes.bind(storage);
		(storage as any).probeLanes = async (options: any) => {
			probeLanesCalls += 1;
			return originalProbeLanes(options);
		};

		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["native"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01
			},
			cases: [makeCase()]
		});

		expect(probeLanesCalls).toBe(0);
		expect(artifact.case_results[0].lane_probe).toBeUndefined();
		expect(renderBenchmarkSummaryMarkdown(artifact)).not.toContain("Lane diagnostics");
	});
});

describe("benchmark CLI parsing", () => {
	it("parses CLI args for benchmark runner", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--profiles", "native,benchmark"
		]);

		expect(parsed.dataset).toBe("longmemeval");
		// "native" and "benchmark" are frozen aliases of "fused" (ADR §9) — normalizeRetrievalProfile
		// resolves both at CLI-parse time, so requesting two aliases yields two (identical) "fused" runs.
		expect(parsed.profiles).toEqual(["fused", "fused"]);
		expect(parsed.backend).toBe("sqlite");
	});

	it("rejects invalid profile names and missing values", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--profiles", "native,typo"
		])).toThrow(/Invalid profile: typo/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input"
		])).toThrow(/Missing value for --input/);
	});

	it("requires DATABASE_URL (env or flag) when backend is postgres and neither is set", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "locomo",
			"--input", "fixtures/locomo.json",
			"--backend", "postgres"
		])).toThrow(/DATABASE_URL must be set in the environment/);
	});

	it("leaves database_url undefined for the sqlite backend when neither flag nor env is set (unaffected by the postgres requirement)", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.backend).toBe("sqlite");
		expect(parsed.database_url).toBeUndefined();
	});

	it("falls back to the DATABASE_URL env var when --database-url is absent (no /proc/*/cmdline exposure)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const parsed = parseBenchmarkCliArgs([
			"--dataset", "locomo",
			"--input", "fixtures/locomo.json",
			"--backend", "postgres"
		], { DATABASE_URL: "postgres://user:pass@host/db" });

		expect(parsed.database_url).toBe("postgres://user:pass@host/db");
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("still accepts --database-url as a flag, but warns exactly once that the command line is readable by other users on the host", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const parsed = parseBenchmarkCliArgs([
			"--dataset", "locomo",
			"--input", "fixtures/locomo.json",
			"--backend", "postgres",
			"--database-url", "postgres://user:pass@host/db"
		]);

		expect(parsed.database_url).toBe("postgres://user:pass@host/db");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[bench] --database-url passed on the command line"));
		// The warning names the exposure mechanism, never the URL/credential itself.
		expect(warn.mock.calls[0][0]).not.toContain("user:pass");
		warn.mockRestore();
	});

	it("prefers the --database-url flag over the DATABASE_URL env var when both are present", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const parsed = parseBenchmarkCliArgs([
			"--dataset", "locomo",
			"--input", "fixtures/locomo.json",
			"--backend", "postgres",
			"--database-url", "postgres://flag-wins/db"
		], { DATABASE_URL: "postgres://env-loses/db" });

		expect(parsed.database_url).toBe("postgres://flag-wins/db");
		// The flag was used, so the exposure warning fires here too — exactly once.
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("parses --allowed-tenants so a real tenant (e.g. rook) can clear the compiled-in allowlist", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "cognitive_advantage",
			"--input", "fixtures/cognitive_advantage.json",
			"--tenant", "rook",
			"--allowed-tenants", "companion,rainer,rook"
		]);

		expect(parsed.tenant).toBe("rook");
		expect(parsed.allowed_tenants).toEqual(["companion", "rainer", "rook"]);
	});

	it("falls back to the ALLOWED_TENANTS env var (passed in by the caller — cli.ts touches no Node globals) when --allowed-tenants is absent", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "cognitive_advantage",
			"--input", "fixtures/cognitive_advantage.json",
			"--tenant", "rook"
		], { ALLOWED_TENANTS: "companion,rook" });

		expect(parsed.allowed_tenants).toEqual(["companion", "rook"]);
	});

	it("leaves allowed_tenants undefined (compiled-in default) when neither flag nor env var is set", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.allowed_tenants).toBeUndefined();
	});

	it("parsed allowed_tenants actually clears the compiled-in allowlist at the storage layer (the whole point of the flag)", () => {
		const dbPath = `/tmp/muse-brain-benchmark-allowlist-${crypto.randomUUID()}.sqlite`;
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "cognitive_advantage",
			"--input", "fixtures/cognitive_advantage.json",
			"--tenant", "rook",
			"--allowed-tenants", "companion,rainer,rook",
			"--sqlite-path", dbPath
		]);

		// Mirrors benchmarks/run.ts's own createStorage call shape.
		expect(() => createStorage(
			{ backend: "sqlite", sqlitePath: parsed.sqlite_path, allowedTenants: parsed.allowed_tenants },
			parsed.tenant
		)).not.toThrow();

		// Without the override, the same tenant is rejected by the compiled-in default.
		expect(() => createStorage(
			{ backend: "sqlite", sqlitePath: `${dbPath}-bare` },
			"rook"
		)).toThrow(/rook/i);
	});

	it("--allowed-tenants takes priority over the env var when both are present", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "cognitive_advantage",
			"--input", "fixtures/cognitive_advantage.json",
			"--allowed-tenants", "companion,rainer,rook"
		], { ALLOWED_TENANTS: "companion,rainer" });

		expect(parsed.allowed_tenants).toEqual(["companion", "rainer", "rook"]);
	});

	it("defaults embed_mode to \"auto\" when neither --no-embed nor --embed=required is given", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.embed_mode).toBe("auto");
	});

	it("--no-embed sets embed_mode to \"off\"", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--no-embed"
		]);
		expect(parsed.embed_mode).toBe("off");
	});

	it("--embed=required sets embed_mode to \"required\"", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed=required"
		]);
		expect(parsed.embed_mode).toBe("required");
	});

	it("rejects an unsupported --embed value", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed=optional"
		])).toThrow(/Unsupported --embed value: optional/);
	});

	it("rejects combining --no-embed with --embed=required, in either order", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--no-embed",
			"--embed=required"
		])).toThrow(/Cannot combine --no-embed with --embed=required/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed=required",
			"--no-embed"
		])).toThrow(/Cannot combine --no-embed with --embed=required/);
	});

	it("defaults embed_query_prefix to true when neither flag nor env var is set (A/B 2026-09-05 kept it — SWEEP-2026-09-05.md §prefix)", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.embed_query_prefix).toBe(true);
	});

	it("--embed-query-prefix sets embed_query_prefix to true", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed-query-prefix"
		]);
		expect(parsed.embed_query_prefix).toBe(true);
	});

	it("--no-embed-query-prefix sets embed_query_prefix to false", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--no-embed-query-prefix"
		]);
		expect(parsed.embed_query_prefix).toBe(false);
	});

	it("falls back to the EMBED_QUERY_PREFIX env var when neither flag is given", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		], { EMBED_QUERY_PREFIX: "0" });
		expect(parsed.embed_query_prefix).toBe(false);
	});

	it("--embed-query-prefix overrides a falsy EMBED_QUERY_PREFIX env var for the run", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed-query-prefix"
		], { EMBED_QUERY_PREFIX: "0" });
		expect(parsed.embed_query_prefix).toBe(true);
	});

	it("--no-embed-query-prefix overrides a truthy EMBED_QUERY_PREFIX env var for the run", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--no-embed-query-prefix"
		], { EMBED_QUERY_PREFIX: "true" });
		expect(parsed.embed_query_prefix).toBe(false);
	});

	it("rejects combining --embed-query-prefix with --no-embed-query-prefix, in either order", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--embed-query-prefix",
			"--no-embed-query-prefix"
		])).toThrow(/Cannot combine --embed-query-prefix with --no-embed-query-prefix/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--no-embed-query-prefix",
			"--embed-query-prefix"
		])).toThrow(/Cannot combine --embed-query-prefix with --no-embed-query-prefix/);
	});

	it("--embed-query-prefix doesn't get swallowed by the generic --flag value parser", () => {
		// Regression guard, same shape as the --no-embed guard above: boolean/inline
		// flags must be pulled out of argv before the generic --flag value loop.
		const parsed = parseBenchmarkCliArgs([
			"--embed-query-prefix",
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--profiles", "native"
		]);
		expect(parsed.embed_query_prefix).toBe(true);
		expect(parsed.dataset).toBe("longmemeval");
		expect(parsed.profiles).toEqual(["fused"]);
	});

	it("--no-embed-query-prefix doesn't get swallowed by the generic --flag value parser", () => {
		const parsed = parseBenchmarkCliArgs([
			"--no-embed-query-prefix",
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--profiles", "native"
		]);
		expect(parsed.embed_query_prefix).toBe(false);
		expect(parsed.dataset).toBe("longmemeval");
		expect(parsed.profiles).toEqual(["fused"]);
	});

	it("--no-embed and --embed=required don't get swallowed by the generic --flag value parser", () => {
		// Regression guard: these are boolean/inline flags, not "--flag value"
		// pairs — if parseEmbedMode's argv-stripping regresses, the generic loop
		// throws "Missing value for --no-embed" here instead of parsing cleanly.
		const parsed = parseBenchmarkCliArgs([
			"--no-embed",
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--profiles", "native"
		]);
		expect(parsed.embed_mode).toBe("off");
		expect(parsed.dataset).toBe("longmemeval");
		expect(parsed.profiles).toEqual(["fused"]);
	});

	it("parses --lane-probe <depth> into an enabled lane_probe config", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-probe", "200"
		]);
		expect(parsed.lane_probe).toEqual({ enabled: true, depth: 200 });
	});

	it("leaves lane_probe undefined when --lane-probe is absent", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.lane_probe).toBeUndefined();
	});

	it("rejects a non-positive-integer --lane-probe value", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-probe", "0"
		])).toThrow(/--lane-probe must be a positive integer depth/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-probe", "not-a-number"
		])).toThrow(/--lane-probe must be a positive integer depth/);
	});

	it("rejects a --lane-probe depth above the 5000 ceiling", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-probe", "5001"
		])).toThrow(/--lane-probe depth must not exceed 5000/);

		// The ceiling itself is still accepted.
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-probe", "5000"
		]);
		expect(parsed.lane_probe).toEqual({ enabled: true, depth: 5000 });
	});

	it("parses --rrf-k into profile_overrides.rrf_k", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--rrf-k", "20"
		]);
		expect(parsed.profile_overrides).toEqual({ rrf_k: 20 });
	});

	it("rejects a --rrf-k value outside [1,500]", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--rrf-k", "0"
		])).toThrow(/--rrf-k must be an integer between 1 and 500/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--rrf-k", "501"
		])).toThrow(/--rrf-k must be an integer between 1 and 500/);
	});

	it("parses --lane-weights into profile_overrides.lane_weights when the four keys sum to 1", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=0.55,keyword=0.33,entity=0.07,hint=0.05"
		]);
		expect(parsed.profile_overrides).toEqual({
			lane_weights: { vector: 0.55, keyword: 0.33, entity: 0.07, hint: 0.05 }
		});
	});

	it("combines --rrf-k and --lane-weights into one profile_overrides object", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--rrf-k", "20",
			"--lane-weights", "vector=0.5,keyword=0.4,entity=0.05,hint=0.05"
		]);
		expect(parsed.profile_overrides).toEqual({
			rrf_k: 20,
			lane_weights: { vector: 0.5, keyword: 0.4, entity: 0.05, hint: 0.05 }
		});
	});

	it("leaves profile_overrides undefined when neither flag is passed", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.profile_overrides).toBeUndefined();
	});

	it("rejects --lane-weights entries that don't sum to 1", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=0.5,keyword=0.5,entity=0.5,hint=0.5"
		])).toThrow(/--lane-weights must sum to 1/);
	});

	it("rejects --lane-weights missing a required key", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=0.7,keyword=0.3"
		])).toThrow(/--lane-weights must set all four keys/);
	});

	it("rejects --lane-weights with an unknown key or an out-of-range value", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=0.5,keyword=0.3,entity=0.1,hintz=0.1"
		])).toThrow(/Unknown --lane-weights key/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=1.5,keyword=0.3,entity=0.1,hint=0.1"
		])).toThrow(/--lane-weights vector must be a number in \[0,1\]/);
	});

	it("--lane-weights tolerates float rounding within ±0.001 of summing to 1", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--lane-weights", "vector=0.33,keyword=0.33,entity=0.33,hint=0.01"
		]);
		expect(parsed.profile_overrides).toEqual({
			lane_weights: { vector: 0.33, keyword: 0.33, entity: 0.33, hint: 0.01 }
		});
	});

	it("defaults --top-k to [1, 5, 10] when absent", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json"
		]);
		expect(parsed.top_k).toEqual([1, 5, 10]);
	});

	it("parses --top-k into a deduped, ascending-sorted list of cutoffs", () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "10,3,1,3,5"
		]);
		expect(parsed.top_k).toEqual([1, 3, 5, 10]);
	});

	it("rejects an empty --top-k value, whether the whole flag or a bare comma entry", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", ""
		])).toThrow(/--top-k must not be empty/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "1,,3"
		])).toThrow(/Invalid --top-k entry/);
	});

	it("rejects non-integer --top-k entries", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "1,abc,5"
		])).toThrow(/--top-k entries must be integers; got "abc"/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "1,3.5,5"
		])).toThrow(/--top-k entries must be integers; got "3.5"/);
	});

	it("rejects out-of-range --top-k entries (outside [1,100])", () => {
		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "0,5"
		])).toThrow(/--top-k entries must be between 1 and 100; got 0/);

		expect(() => parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "1,101"
		])).toThrow(/--top-k entries must be between 1 and 100; got 101/);
	});

	it("threads --top-k through parseBenchmarkCliArgs into run_config, producing exactly the requested R@k/NDCG@k markdown columns", async () => {
		const parsed = parseBenchmarkCliArgs([
			"--dataset", "longmemeval",
			"--input", "fixtures/longmemeval.json",
			"--top-k", "3,1"
		]);
		expect(parsed.top_k).toEqual([1, 3]);

		const dbPath = `/tmp/muse-brain-benchmark-cli-topk-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const artifact = await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: parsed.dataset,
				profiles: ["native"],
				top_k: parsed.top_k,
				result_limit: parsed.result_limit,
				min_similarity: parsed.min_similarity
			},
			cases: [makeCase()]
		});

		expect(artifact.config.top_k).toEqual([1, 3]);
		const markdown = renderBenchmarkSummaryMarkdown(artifact);
		expect(markdown).toContain("| Profile | R@1 | R@3 | NDCG@1 | NDCG@3 | Candidate Hit | Evaluated | Skipped |");
	});
});

describe("benchmark harness — profile_overrides reach hybridSearch (ADR §1 Rook's note sweep)", () => {
	it("threads run_config.profile_overrides into every storage.hybridSearch call for this run", async () => {
		const dbPath = `/tmp/muse-brain-benchmark-overrides-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
		const seenOverrides: unknown[] = [];
		const originalHybridSearch = storage.hybridSearch.bind(storage);
		(storage as any).hybridSearch = async (options: any) => {
			seenOverrides.push(options.profile_overrides);
			return originalHybridSearch(options);
		};

		await runBenchmarkHarness({
			storage,
			backend: "sqlite",
			run_config: {
				dataset: "longmemeval",
				profiles: ["fused", "legacy"],
				top_k: [1],
				result_limit: 5,
				min_similarity: 0.01,
				profile_overrides: { rrf_k: 20, lane_weights: { vector: 0.5, keyword: 0.4, entity: 0.05, hint: 0.05 } }
			},
			cases: [makeCase()]
		});

		expect(seenOverrides).toHaveLength(2);
		expect(seenOverrides.every(o => (o as any)?.rrf_k === 20)).toBe(true);
	});
});
