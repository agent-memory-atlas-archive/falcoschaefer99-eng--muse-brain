// ============ WORKERS AI REST ADAPTER ============
// Box-side implementation of the same small client seam used by the Worker
// binding. Cloudflare REST output is { result, success, errors }; unwrap the
// envelope before returning it to shared code.

import type { WorkersAIClient } from "./interface";

const API_ROOT = "https://api.cloudflare.com/client/v4/accounts";
const MAX_REQUEST_BODY_CHARS = 1_000_000;
const MAX_RESPONSE_BODY_CHARS = 1_000_000;
const MAX_ERROR_DETAIL_CHARS = 300;

export type WorkersAIFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WorkersAIRestAdapterOptions {
	accountId: string;
	token: string;
	fetch?: WorkersAIFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message.replace(/\s+/g, " ").slice(0, MAX_ERROR_DETAIL_CHARS);
	}
	return "unknown error";
}

function errorDetail(payload: unknown): string {
	if (isRecord(payload)) {
		const errors = payload.errors;
		if (Array.isArray(errors)) {
			const details = errors
				.map(error => {
					if (!isRecord(error)) return undefined;
					const code = typeof error.code === "string" || typeof error.code === "number"
						? String(error.code)
						: "";
					const message = typeof error.message === "string" ? error.message : "";
					return [code, message].filter(Boolean).join(": ");
				})
				.filter((detail): detail is string => Boolean(detail))
				.join("; ");
			if (details) return details.slice(0, MAX_ERROR_DETAIL_CHARS);
		}
		if (typeof payload.error === "string" && payload.error.trim()) {
			return payload.error.replace(/\s+/g, " ").slice(0, MAX_ERROR_DETAIL_CHARS);
		}
	}
	if (typeof payload === "string" && payload.trim()) {
		return payload.replace(/\s+/g, " ").slice(0, MAX_ERROR_DETAIL_CHARS);
	}
	return "no error details";
}

function validateAccountId(accountId: string): string {
	const value = accountId.trim();
	if (!/^[a-f0-9]{32}$/.test(value)) {
		throw new Error("Workers AI REST adapter requires a valid CF_ACCOUNT_ID");
	}
	return value;
}

function validateModel(model: string): string {
	const value = model.trim();
	if (!/^@cf\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) || value.length > 256 || /[\\\x00?#]/.test(value)) {
		throw new Error("Workers AI model must be a valid non-empty path");
	}
	return value;
}

async function readPayload(response: Response): Promise<unknown> {
	let raw: string;
	try {
		raw = await response.text();
	} catch {
		throw new Error("Workers AI REST response body could not be read");
	}
	if (raw.length > MAX_RESPONSE_BODY_CHARS) {
		throw new Error("Workers AI REST response exceeded the safe size limit");
	}
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

export class WorkersAIRestAdapter implements WorkersAIClient {
	private readonly accountId: string;
	private readonly token: string;
	private readonly fetchImpl: WorkersAIFetch;

	constructor(options: WorkersAIRestAdapterOptions) {
		this.accountId = validateAccountId(options.accountId);
		if (!options.token || !options.token.trim()) {
			throw new Error("Workers AI REST adapter requires a CF_AI_TOKEN");
		}
		this.token = options.token.trim();
		this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	async run(model: string, input: unknown): Promise<unknown> {
		const modelPath = validateModel(model);
		let body: string;
		try {
			body = JSON.stringify(input);
		} catch {
			throw new Error("Workers AI REST request input could not be serialized");
		}
		if (body.length > MAX_REQUEST_BODY_CHARS) {
			throw new Error("Workers AI REST request exceeded the safe size limit");
		}

		const url = `${API_ROOT}/${encodeURIComponent(this.accountId)}/ai/run/${modelPath}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${this.token}`,
					"Content-Type": "application/json"
				},
				body
			});
		} catch (error) {
			throw new Error(`Workers AI REST request failed: ${safeErrorMessage(error)}`);
		}

		const payload = await readPayload(response);
		if (!response.ok) {
			throw new Error(`Workers AI REST request failed with status ${response.status}: ${errorDetail(payload)}`);
		}
		if (!isRecord(payload)) {
			throw new Error("Workers AI REST returned an invalid JSON response");
		}
		if (payload.success === false) {
			throw new Error(`Workers AI REST request was unsuccessful: ${errorDetail(payload)}`);
		}
		if (Object.prototype.hasOwnProperty.call(payload, "result")) {
			return payload.result;
		}
		if (payload.success === true) {
			throw new Error("Workers AI REST response did not include a result");
		}

		// Defensive compatibility path for a direct model-shaped response.
		return payload;
	}
}

export function createWorkersAIRestAdapter(options: WorkersAIRestAdapterOptions): WorkersAIClient {
	return new WorkersAIRestAdapter(options);
}
