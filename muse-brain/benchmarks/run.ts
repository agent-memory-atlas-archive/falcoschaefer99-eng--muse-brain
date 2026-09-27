import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { parseBenchmarkCliArgs, type CliOptions } from "../src/benchmarks/cli";
import { adaptBenchmarkDataset } from "../src/benchmarks/adapters/index";
import { renderBenchmarkSummaryMarkdown, runBenchmarkHarness } from "../src/benchmarks/harness";
import { createStorage } from "../src/storage/factory";
import { createEmbeddingProvider } from "../src/embedding/index";
import { createWorkersAIRestAdapter } from "../src/ai/rest";
import { required } from "../daemon-runner/env";

/** Reads CF_ACCOUNT_ID / CF_AI_TOKEN from env if both are present — mirrors the
 * validation daemon-runner/env.ts's readDaemonEnv() applies to the same two
 * vars (reuses its `required()` trim/length/control-char check; the account-id
 * hex-format check is mirrored inline since readDaemonEnv doesn't expose it as
 * a standalone function). Returns undefined when neither var is set — that's
 * the normal "no vector lane configured" case, not an error. One var set and
 * the other missing IS an error (half-configured credentials). */
function readCfCredentials(): { accountId: string; token: string } | undefined {
	const hasAccountId = Boolean(process.env.CF_ACCOUNT_ID?.trim());
	const hasToken = Boolean(process.env.CF_AI_TOKEN?.trim());
	if (!hasAccountId && !hasToken) return undefined;
	if (!hasAccountId || !hasToken) {
		throw new Error("CF_ACCOUNT_ID and CF_AI_TOKEN must both be set (or both unset) to enable the benchmark vector lane");
	}
	const accountId = required("CF_ACCOUNT_ID", 32);
	if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("CF_ACCOUNT_ID must be a valid 32-character hexadecimal account ID");
	const token = required("CF_AI_TOKEN", 4096);
	return { accountId, token };
}

/** Never accepts the token via argv — env only — and never logs it. Builds
 * BOTH the document-side (embedText, always unprefixed) and query-side
 * (embedQuery, prefixed when embedQueryPrefix is set) closures off one shared
 * provider instance, per ADR-RETRIEVAL-FUSION-RETUNE §5 item 1. */
function resolveEmbedFunctions(
	embedMode: CliOptions["embed_mode"],
	embedQueryPrefix: boolean
): { embed_text?: (text: string) => Promise<number[]>; embed_query?: (text: string) => Promise<number[]> } {
	if (embedMode === "off") {
		console.log("[bench] vector lane: disabled (--no-embed)");
		return {};
	}

	const credentials = readCfCredentials();
	if (!credentials) {
		if (embedMode === "required") {
			throw new Error("--embed=required but CF_ACCOUNT_ID/CF_AI_TOKEN are not set in env");
		}
		console.log("[bench] vector lane: disabled (no CF_ACCOUNT_ID/CF_AI_TOKEN)");
		return {};
	}

	const provider = createEmbeddingProvider(createWorkersAIRestAdapter(credentials), { embedQueryPrefix });
	console.log(`[bench] vector lane: enabled (workers-ai rest, embed_query_prefix=${embedQueryPrefix})`);
	return {
		embed_text: (text: string) => provider.embedText(text),
		embed_query: (text: string) => provider.embedQuery(text)
	};
}

async function main(): Promise<void> {
	const options = parseBenchmarkCliArgs(process.argv.slice(2), {
		ALLOWED_TENANTS: process.env.ALLOWED_TENANTS,
		DATABASE_URL: process.env.DATABASE_URL,
		EMBED_QUERY_PREFIX: process.env.EMBED_QUERY_PREFIX
	});
	const { embed_text: embedText, embed_query: embedQuery } = resolveEmbedFunctions(options.embed_mode, options.embed_query_prefix);
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(options.input, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read or parse benchmark input at ${options.input}: ${message}`);
	}
	const cases = adaptBenchmarkDataset(options.dataset, raw);
	const storage = createStorage(
		options.backend === "sqlite"
			? { backend: "sqlite", sqlitePath: options.sqlite_path, allowedTenants: options.allowed_tenants }
			: { backend: "postgres", databaseUrl: options.database_url, allowedTenants: options.allowed_tenants },
		options.tenant
	);

	const artifact = await runBenchmarkHarness({
		storage,
		backend: options.backend,
		run_config: {
			dataset: options.dataset,
			profiles: options.profiles,
			top_k: options.top_k,
			result_limit: options.result_limit,
			min_similarity: options.min_similarity,
			rerank_mode: options.rerank_mode,
			rerank_top_n: options.rerank_top_n,
			lane_probe: options.lane_probe,
			profile_overrides: options.profile_overrides
		},
		cases,
		embed_text: embedText,
		embed_query: embedQuery,
		embed_query_prefix: Boolean(embedText) && options.embed_query_prefix
	});

	const outputDir = path.resolve(options.output_dir);
	const missAnalysis = artifact.case_results.filter(result => Boolean(result.miss_category));
	await mkdir(outputDir, { recursive: true });
	await writeFile(path.join(outputDir, "artifact.json"), JSON.stringify(artifact, null, 2));
	await writeFile(path.join(outputDir, "summary.md"), renderBenchmarkSummaryMarkdown(artifact));
	await writeFile(path.join(outputDir, "miss-analysis.json"), JSON.stringify(missAnalysis, null, 2));
	await writeFile(path.join(outputDir, "run-issues.json"), JSON.stringify(artifact.run_issues, null, 2));
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
