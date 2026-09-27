import type { RetrievalProfile } from "../retrieval/query-signals";
import { normalizeRetrievalProfile, validateProfileOverrides } from "../retrieval/query-signals";
import type { RetrievalRerankMode } from "../retrieval/rerank";
import { parseEmbedQueryPrefixEnv } from "../embedding/index";
import type { SupportedBenchmarkDataset } from "./adapters/index";

export interface CliOptions {
	dataset: SupportedBenchmarkDataset;
	input: string;
	output_dir: string;
	backend: "sqlite" | "postgres";
	sqlite_path?: string;
	database_url?: string;
	tenant: string;
	/** Overrides the compiled-in ["companion", "rainer"] default so real tenants
	 * (e.g. "rook") can be benchmarked. --allowed-tenants, then the ALLOWED_TENANTS
	 * env var (passed in via CliEnv — this file stays Node-global-free so it can be
	 * typechecked under the Worker's src/ tsconfig, which has no "node" types),
	 * then undefined (factory falls back to the compiled default). */
	allowed_tenants?: readonly string[];
	profiles: RetrievalProfile[];
	/** --top-k 1,3,5,10 — recall/ndcg cutoffs the harness scores against. Defaults
	 * to [1, 5, 10] when the flag is absent. The ADR-RETRIEVAL-FUSION-RETUNE §7
	 * gate needs R@3, which was previously unreachable from the CLI (the harness
	 * hardcoded [1, 5, 10] in benchmarks/run.ts). See parseTopK below. */
	top_k: number[];
	result_limit: number;
	min_similarity: number;
	rerank_mode?: RetrievalRerankMode;
	rerank_top_n?: number;
	/** "auto" (default) = use the Workers AI vector lane when CF_ACCOUNT_ID/CF_AI_TOKEN
	 * are present in env, keyword-only otherwise. "off" = --no-embed forces
	 * keyword-only regardless of env. "required" = --embed=required fails loudly
	 * if the env vars are missing instead of silently falling back. */
	embed_mode: "auto" | "off" | "required";
	/** --embed-query-prefix / --no-embed-query-prefix — ADR-RETRIEVAL-FUSION-RETUNE
	 * §5 item 1 A/B lever, kept reproducible after the A/B (SWEEP-2026-09-05.md
	 * §prefix) made the prefix the default. Either flag, when present, forces the
	 * BGE query instruction prefix on/off for this run regardless of the
	 * EMBED_QUERY_PREFIX env var (mutually exclusive — combining both throws);
	 * when neither is given, falls back to the env var (default on — see
	 * parseEmbedQueryPrefixEnv). Has no effect when the vector lane itself is
	 * disabled (embed_mode "off" or auto-with-no-credentials). */
	embed_query_prefix: boolean;
	/** --lane-probe <depth> — diagnostic-only, off by default, depth 1-5000. The
	 * harness may RAISE (never lower) the effective depth above this value to
	 * cover every benchmarked profile's own candidate_pool size. See
	 * BenchmarkRunConfig.lane_probe. */
	lane_probe?: { enabled: boolean; depth: number };
	/** --rrf-k <int> / --lane-weights vector=..,keyword=..,entity=..,hint=.. — the
	 * ADR §1 "Rook's note" K x w_keyword sweep. Applies to the "fused" profile only
	 * for this run. See BenchmarkRunConfig.profile_overrides. */
	profile_overrides?: {
		rrf_k?: number;
		lane_weights?: { vector: number; keyword: number; entity: number; hint: number };
	};
}

function requireValue(flag: string, value: string | undefined): string {
	if (!value) throw new Error(`Missing value for ${flag}`);
	return value;
}

function parseAllowedTenants(value: string | undefined): readonly string[] | undefined {
	if (!value) return undefined;
	const list = value.split(",").map(t => t.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

/** Caller-supplied env, so this file never touches the Node `process` global
 * directly — everything under src/ is typechecked under the Worker's
 * node-types-free root tsconfig. */
export interface CliEnv {
	ALLOWED_TENANTS?: string;
	DATABASE_URL?: string;
	EMBED_QUERY_PREFIX?: string;
}

function parseProfiles(value: string | undefined): RetrievalProfile[] {
	if (!value || value === "all") return ["native", "balanced", "benchmark"];
	const parsed: RetrievalProfile[] = [];
	for (const raw of value.split(",")) {
		const normalized = normalizeRetrievalProfile(raw);
		if (!normalized) throw new Error(`Invalid profile: ${raw}`);
		parsed.push(normalized);
	}
	return parsed;
}

const DEFAULT_TOP_K: readonly number[] = [1, 5, 10];

/** --top-k 1,3,5,10 — comma-separated positive integers, deduped and sorted
 * ascending, each in [1,100]. Defaults to [1, 5, 10] when the flag is absent.
 * Rejects an empty value (whole flag or an empty comma-separated entry),
 * a non-integer entry, and an out-of-range entry, each with its own message. */
function parseTopK(value: string | undefined): number[] {
	if (value === undefined) return [...DEFAULT_TOP_K];
	if (value.trim().length === 0) throw new Error("--top-k must not be empty");
	const cutoffs = new Set<number>();
	for (const rawEntry of value.split(",")) {
		const entry = rawEntry.trim();
		if (entry.length === 0) {
			throw new Error(`Invalid --top-k entry: "${rawEntry}" (expected a positive integer)`);
		}
		const parsed = Number(entry);
		if (!Number.isInteger(parsed)) {
			throw new Error(`--top-k entries must be integers; got "${entry}"`);
		}
		if (parsed < 1 || parsed > 100) {
			throw new Error(`--top-k entries must be between 1 and 100; got ${parsed}`);
		}
		cutoffs.add(parsed);
	}
	return Array.from(cutoffs).sort((a, b) => a - b);
}

const LANE_WEIGHT_KEYS = ["vector", "keyword", "entity", "hint"] as const;
type LaneWeightKey = (typeof LANE_WEIGHT_KEYS)[number];

/** --lane-weights vector=0.55,keyword=0.33,entity=0.07,hint=0.05 — ADR §1 "Rook's
 * note" sweep flag. All four keys required, each in [0,1], summing to 1 within
 * ±0.001 (float rounding tolerance). Returns undefined when the flag is absent. */
function parseLaneWeights(value: string | undefined): { vector: number; keyword: number; entity: number; hint: number } | undefined {
	if (value === undefined) return undefined;
	const weights: Partial<Record<LaneWeightKey, number>> = {};
	for (const part of value.split(",")) {
		const [rawKey, rawValue] = part.split("=");
		const key = rawKey?.trim();
		if (!key || rawValue === undefined) {
			throw new Error(`Invalid --lane-weights entry: "${part}" (expected key=value)`);
		}
		if (!(LANE_WEIGHT_KEYS as readonly string[]).includes(key)) {
			throw new Error(`Unknown --lane-weights key: "${key}" (expected one of: ${LANE_WEIGHT_KEYS.join(", ")})`);
		}
		const parsed = Number.parseFloat(rawValue.trim());
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
			throw new Error(`--lane-weights ${key} must be a number in [0,1]`);
		}
		weights[key as LaneWeightKey] = parsed;
	}
	for (const key of LANE_WEIGHT_KEYS) {
		if (weights[key] === undefined) {
			throw new Error(`--lane-weights must set all four keys: ${LANE_WEIGHT_KEYS.join(", ")}`);
		}
	}
	const resolved = weights as Record<LaneWeightKey, number>;
	// Per-key range and key-completeness are already enforced above; the only
	// rule validateProfileOverrides can still reject here is sum-to-1 — delegate
	// that one check to the shared definition (src/retrieval/query-signals.ts)
	// so the ±0.001 tolerance lives in exactly one place, re-labeled into this
	// flag's own message for CLI users.
	try {
		validateProfileOverrides({ lane_weights: resolved });
	} catch {
		const sum = resolved.vector + resolved.keyword + resolved.entity + resolved.hint;
		throw new Error(`--lane-weights must sum to 1 (±0.001); got ${sum.toFixed(4)}`);
	}
	return resolved;
}

/** --no-embed and --embed=required are boolean/inline flags (no separate value
 * token), so they're pulled out of argv before the generic --flag value loop
 * below — that loop throws "Missing value for X" for any flag not immediately
 * followed by a non-flag token. */
function parseEmbedMode(argv: string[]): { embedMode: CliOptions["embed_mode"]; rest: string[] } {
	let embedMode: CliOptions["embed_mode"] = "auto";
	const rest: string[] = [];
	for (const token of argv) {
		if (token === "--no-embed") {
			if (embedMode === "required") throw new Error("Cannot combine --no-embed with --embed=required");
			embedMode = "off";
			continue;
		}
		if (token.startsWith("--embed=")) {
			const value = token.slice("--embed=".length);
			if (value !== "required") throw new Error(`Unsupported --embed value: ${value} (only "required" is supported)`);
			if (embedMode === "off") throw new Error("Cannot combine --no-embed with --embed=required");
			embedMode = "required";
			continue;
		}
		rest.push(token);
	}
	return { embedMode, rest };
}

/** --embed-query-prefix / --no-embed-query-prefix are boolean/inline flags
 * (ADR §5 item 1 A/B lever, kept reproducible after the A/B — see
 * SWEEP-2026-09-05.md §prefix — made the prefix the default) — same pre-pass
 * treatment as --no-embed/--embed=required above: pulled out of argv before
 * the generic --flag value loop, which would otherwise throw "Missing value
 * for --embed-query-prefix" whenever it's the last token or is immediately
 * followed by another --flag. Mutually exclusive, same shape as
 * --no-embed/--embed=required. */
function parseEmbedQueryPrefixArg(argv: string[]): { mode: "on" | "off" | undefined; rest: string[] } {
	let mode: "on" | "off" | undefined;
	const rest: string[] = [];
	for (const token of argv) {
		if (token === "--embed-query-prefix") {
			if (mode === "off") throw new Error("Cannot combine --embed-query-prefix with --no-embed-query-prefix");
			mode = "on";
			continue;
		}
		if (token === "--no-embed-query-prefix") {
			if (mode === "on") throw new Error("Cannot combine --embed-query-prefix with --no-embed-query-prefix");
			mode = "off";
			continue;
		}
		rest.push(token);
	}
	return { mode, rest };
}

export function parseBenchmarkCliArgs(argv: string[], env: CliEnv = {}): CliOptions {
	const { embedMode, rest: afterEmbedMode } = parseEmbedMode(argv);
	const { mode: embedQueryPrefixMode, rest } = parseEmbedQueryPrefixArg(afterEmbedMode);
	const args = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (!token.startsWith("--")) continue;
		if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) {
			throw new Error(`Missing value for ${token}`);
		}
		args.set(token, rest[i + 1]);
		i += 1;
	}

	const dataset = requireValue("--dataset", args.get("--dataset")) as SupportedBenchmarkDataset;
	if (dataset !== "longmemeval" && dataset !== "locomo" && dataset !== "cognitive_advantage") {
		throw new Error(`Unsupported dataset: ${dataset}`);
	}

	const backend = (args.get("--backend") ?? "sqlite") as "sqlite" | "postgres";
	if (backend !== "sqlite" && backend !== "postgres") {
		throw new Error(`Unsupported backend: ${backend}`);
	}

	// --database-url is discouraged: any argv flag lands in /proc/<pid>/cmdline,
	// world-readable on Linux by default, so a postgres password passed this way
	// is visible to every other user on the host for the duration of the run.
	// The env var is the safe path; the flag wins if both are given (same
	// precedence as --allowed-tenants above), so it stays available as an
	// explicit override — just a discouraged one.
	const databaseUrlFlag = args.get("--database-url");
	const databaseUrl = databaseUrlFlag ?? env.DATABASE_URL;
	if (backend === "postgres" && !databaseUrl) {
		throw new Error(
			"DATABASE_URL must be set in the environment (or pass --database-url; discouraged — the command line is readable by other users on the host)"
		);
	}
	if (databaseUrlFlag) {
		// Never log the URL itself — only the fact that the flag was used.
		console.warn(
			"[bench] --database-url passed on the command line is visible in /proc/*/cmdline to every user on this host; prefer the DATABASE_URL environment variable"
		);
	}
	const rerankModeRaw = args.get("--rerank-mode");
	const rerankMode = rerankModeRaw as RetrievalRerankMode | undefined;
	if (rerankMode !== undefined && rerankMode !== "off" && rerankMode !== "heuristic" && rerankMode !== "model") {
		throw new Error(`Unsupported rerank mode: ${rerankModeRaw}`);
	}
	const rerankTopN = args.has("--rerank-top-n")
		? Number.parseInt(args.get("--rerank-top-n") ?? "", 10)
		: undefined;
	if (rerankTopN !== undefined && (!Number.isInteger(rerankTopN) || rerankTopN <= 0)) {
		throw new Error("--rerank-top-n must be a positive integer");
	}

	const laneProbeDepth = args.has("--lane-probe")
		? Number.parseInt(args.get("--lane-probe") ?? "", 10)
		: undefined;
	if (laneProbeDepth !== undefined && (!Number.isInteger(laneProbeDepth) || laneProbeDepth <= 0)) {
		throw new Error("--lane-probe must be a positive integer depth");
	}
	if (laneProbeDepth !== undefined && laneProbeDepth > 5000) {
		throw new Error("--lane-probe depth must not exceed 5000");
	}

	const rrfK = args.has("--rrf-k")
		? Number.parseInt(args.get("--rrf-k") ?? "", 10)
		: undefined;
	if (rrfK !== undefined) {
		// Integer-ness is a CLI format concern (parseInt already truncates/NaNs);
		// the [1,500] range itself is delegated to validateProfileOverrides so
		// the bound lives in exactly one place (shared with postgres.ts/sqlite.ts
		// and re-labeled here into this flag's own message).
		let inRange = Number.isInteger(rrfK);
		if (inRange) {
			try {
				validateProfileOverrides({ rrf_k: rrfK });
			} catch {
				inRange = false;
			}
		}
		if (!inRange) throw new Error("--rrf-k must be an integer between 1 and 500");
	}
	const laneWeights = parseLaneWeights(args.get("--lane-weights"));
	const profileOverrides = (rrfK !== undefined || laneWeights !== undefined)
		? {
			...(rrfK !== undefined ? { rrf_k: rrfK } : {}),
			...(laneWeights !== undefined ? { lane_weights: laneWeights } : {})
		}
		: undefined;

	return {
		dataset,
		input: requireValue("--input", args.get("--input")),
		output_dir: args.get("--output-dir") ?? "benchmarks/results/latest",
		backend,
		sqlite_path: args.get("--sqlite-path") ?? "benchmarks/results/benchmark.sqlite",
		database_url: databaseUrl,
		tenant: args.get("--tenant") ?? "companion",
		allowed_tenants: parseAllowedTenants(args.get("--allowed-tenants")) ?? parseAllowedTenants(env.ALLOWED_TENANTS),
		profiles: parseProfiles(args.get("--profiles")),
		top_k: parseTopK(args.get("--top-k")),
		result_limit: Number.parseInt(args.get("--result-limit") ?? "10", 10),
		min_similarity: Number.parseFloat(args.get("--min-similarity") ?? "0.01"),
		rerank_mode: rerankMode,
		rerank_top_n: rerankTopN,
		embed_mode: embedMode,
		embed_query_prefix: embedQueryPrefixMode === "off"
			? false
			: embedQueryPrefixMode === "on"
				? true
				: parseEmbedQueryPrefixEnv(env.EMBED_QUERY_PREFIX),
		lane_probe: laneProbeDepth !== undefined ? { enabled: true, depth: laneProbeDepth } : undefined,
		profile_overrides: profileOverrides
	};
}
