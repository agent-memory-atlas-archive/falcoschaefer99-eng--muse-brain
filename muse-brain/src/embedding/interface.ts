// ============ EMBEDDING PROVIDER INTERFACE ============
// Pure interface — no imports, no side effects.
// Implementations plug in at the factory layer.

export interface IEmbeddingProvider {
	readonly name: string;
	readonly dimensions: number;
	readonly modality: 'text' | 'text+image';
	embedText(text: string): Promise<number[]>;
	/**
	 * Query-side embedding — ADR-RETRIEVAL-FUSION-RETUNE §5 item 1. bge-*-en-v1.5
	 * is trained for asymmetric retrieval: short QUERIES take an instruction
	 * prefix, DOCUMENTS take none. embedText stays the document-side call
	 * (unprefixed, always). embedQuery is the only call site that may prefix,
	 * gated behind the provider's own construction-time flag — implementations
	 * that don't support the asymmetry may alias this to embedText.
	 */
	embedQuery(text: string): Promise<number[]>;
	embedImage?(imageUrl: string): Promise<number[]>;
	embedBatch(texts: string[]): Promise<number[][]>;
}
