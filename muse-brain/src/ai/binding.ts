// ============ WORKERS AI BINDING ADAPTER ============
// Keeps the generated Cloudflare Ai type at the Worker boundary. Everything
// below that boundary talks to the structural WorkersAIClient interface.

import type { WorkersAIClient } from "./interface";

export class WorkersAIBindingAdapter implements WorkersAIClient {
	constructor(private readonly binding: Pick<Ai, "run">) {
		if (!binding || typeof binding.run !== "function") {
			throw new TypeError("Workers AI binding must provide a run method");
		}
	}

	run(model: string, input: unknown): Promise<unknown> {
		// Generated Ai.run overloads are model-list-specific. Narrow the call once
		// at this seam so inward code does not depend on Cloudflare's global type.
		return (this.binding.run as unknown as (model: string, input: unknown) => Promise<unknown>)(model, input);
	}
}

export function createWorkersAIBindingAdapter(ai: Ai | undefined): WorkersAIClient | undefined {
	return ai ? new WorkersAIBindingAdapter(ai) : undefined;
}
