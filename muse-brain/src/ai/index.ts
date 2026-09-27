// ============ WORKERS AI ADAPTERS ============

import type { WorkersAIClient } from "./interface";
import { WorkersAIBindingAdapter } from "./binding";
import { WorkersAIRestAdapter, type WorkersAIRestAdapterOptions } from "./rest";

export type { WorkersAIClient } from "./interface";
export { WorkersAIBindingAdapter } from "./binding";
export { WorkersAIRestAdapter } from "./rest";
export type { WorkersAIFetch, WorkersAIRestAdapterOptions } from "./rest";

export type WorkersAIClientFactoryInput =
	| Ai
	| { binding: Ai }
	| WorkersAIRestAdapterOptions;

/**
 * Select the binding adapter at the Worker boundary or the REST adapter for a
 * box-hosted caller. Undefined is intentional: the Worker supports degraded
 * keyword-only behavior when no AI binding is configured.
 */
export function createWorkersAIClient(input: WorkersAIClientFactoryInput | undefined): WorkersAIClient | undefined {
	if (!input) return undefined;
	if (typeof input === "object" && "run" in input && typeof input.run === "function") {
		return new WorkersAIBindingAdapter(input as Ai);
	}
	if (typeof input === "object" && "binding" in input) {
		return new WorkersAIBindingAdapter(input.binding);
	}
	return new WorkersAIRestAdapter(input as WorkersAIRestAdapterOptions);
}
