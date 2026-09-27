// ============ EMBEDDING FACTORY ============
// createEmbeddingProvider returns the appropriate provider for the given AI binding.

import type { IEmbeddingProvider } from "./interface";
import { WorkersAIEmbeddingProvider } from "./workers-ai";
import type { WorkersAIClient } from "../ai";

export interface EmbeddingProviderOptions {
	/** ADR-RETRIEVAL-FUSION-RETUNE §5 item 1 — see EMBED_QUERY_PREFIX in each
	 * caller's own env plumbing (Worker env, CliEnv). Default ON — A/B
	 * 2026-09-05 kept it (SWEEP-2026-09-05.md §prefix); set EMBED_QUERY_PREFIX=0
	 * to disable. */
	embedQueryPrefix?: boolean;
}

export function createEmbeddingProvider(ai: WorkersAIClient, options: EmbeddingProviderOptions = {}): IEmbeddingProvider {
	return new WorkersAIEmbeddingProvider(ai, options.embedQueryPrefix ?? true);
}

/**
 * Parses the EMBED_QUERY_PREFIX env var. Default ON when unset (A/B
 * 2026-09-05 kept it — SWEEP-2026-09-05.md §prefix): "0"/"false"
 * (case-insensitive, trimmed) explicitly disables it; "1"/"true" explicitly
 * confirms it; any other value (including empty string) falls back to the
 * default. Pure — takes the already-read string value so every caller
 * (Worker env, daemon env, benchmark CliEnv) can share this one parse
 * without touching process.env from inside src/.
 */
export function parseEmbedQueryPrefixEnv(value: string | undefined): boolean {
	if (!value) return true;
	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "false") return false;
	return true;
}

export type { IEmbeddingProvider };
