// ============ STORAGE KEY BUILDERS ============
// Shared key formats that BOTH sides of an API must agree on. Anything that a
// storage backend emits and a caller looks up belongs here — never hand-written
// at either end.
//
// Why this file exists: batchProposalExists returns a Set of composite keys.
// The sqlite backend built them with `::` while every caller looked them up with
// `:`, so the sqlite dedupe check matched nothing and re-proposed the same rows
// every night. It survived review because each consumer test mocked
// batchProposalExists and hand-wrote the expected Set with the correct
// separator — the producer's real output was never observed. One exported
// builder makes that class of drift unrepresentable.

/**
 * Composite key identifying a daemon proposal by its dedupe triple.
 * Produced by IBrainStorage.batchProposalExists, consumed by every daemon task.
 */
export function proposalKey(type: string, sourceId: string, targetId: string): string {
	return `${type}:${sourceId}:${targetId}`;
}
