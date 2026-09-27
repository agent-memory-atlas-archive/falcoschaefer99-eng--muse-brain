// ============ WORKERS AI EMBEDDING PROVIDER ============
// Implements IEmbeddingProvider using Cloudflare Workers AI.
// Model: @cf/baai/bge-base-en-v1.5 — 768-dimension text embeddings.
// Batch up to 100 texts in a single inference call.

import type { IEmbeddingProvider } from "./interface";
import type { WorkersAIClient } from "../ai";

const MODEL = "@cf/baai/bge-base-en-v1.5";

// bge-*-en-v1.5 is trained for asymmetric retrieval: short QUERIES take this
// instruction prefix at embed time, DOCUMENTS take none. ADR-RETRIEVAL-FUSION-
// RETUNE §5 item 1. Documents are already embedded correctly (unprefixed), so
// enabling this requires no re-embed and the existing backfill stays valid.
const QUERY_INSTRUCTION_PREFIX = "Represent this sentence for searching relevant passages: ";

export class WorkersAIEmbeddingProvider implements IEmbeddingProvider {
	readonly name = MODEL;
	readonly dimensions = 768;
	readonly modality = 'text' as const;

	/** embedQueryPrefix defaults ON — A/B 2026-09-05 kept it (SWEEP-2026-09-05.md §prefix); set EMBED_QUERY_PREFIX=0 to disable. */
	constructor(private readonly ai: WorkersAIClient, private readonly embedQueryPrefix: boolean = true) {}

	async embedText(text: string): Promise<number[]> {
		if (!text || text.trim().length === 0) {
			throw new Error('Cannot embed empty text');
		}
		let result: { data: number[][] };
		try {
			result = await this.ai.run(MODEL, { text: [text] }) as { data: number[][] };
		} catch (err) {
			throw new Error(`Workers AI embedText failed: ${err instanceof Error ? err.message : 'unknown error'}`);
		}
		if (!result?.data?.[0] || !Array.isArray(result.data[0])) {
			throw new Error('Workers AI returned invalid embedding result');
		}
		return result.data[0];
	}

	/**
	 * Query-side embedding. When embedQueryPrefix is enabled, prepends the BGE
	 * asymmetric-retrieval instruction prefix to `text` before delegating to
	 * embedText — a fresh string built from the original argument on every call,
	 * so repeated calls never accumulate the prefix. When disabled, behaves
	 * exactly like embedText.
	 */
	async embedQuery(text: string): Promise<number[]> {
		if (!this.embedQueryPrefix) return this.embedText(text);
		return this.embedText(`${QUERY_INSTRUCTION_PREFIX}${text}`);
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		if (!texts.length) return [];
		let result: { data: number[][] };
		try {
			result = await this.ai.run(MODEL, { text: texts }) as { data: number[][] };
		} catch (err) {
			throw new Error(`Workers AI embedBatch failed: ${err instanceof Error ? err.message : 'unknown error'}`);
		}
		if (!result?.data || !Array.isArray(result.data)) {
			throw new Error('Workers AI returned invalid batch embedding result');
		}
		return texts.map((_, i) => {
			if (!result.data[i] || !Array.isArray(result.data[i])) {
				throw new Error(`Workers AI returned invalid embedding for index ${i}`);
			}
			return result.data[i];
		});
	}

	// embedImage not implemented — text-only model
}
