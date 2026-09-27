// ============ WORKERS AI CLIENT INTERFACE ============
// Structural seam shared by the Worker binding and the box-hosted REST client.
// Keep the boundary deliberately small: model-specific validation belongs to
// the provider that knows the model's contract.

export interface WorkersAIClient {
	run(model: string, input: unknown): Promise<unknown>;
}
