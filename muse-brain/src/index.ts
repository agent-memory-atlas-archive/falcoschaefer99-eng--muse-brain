// MUSE Brain — Relational memory substrate for AI companions
// © 2026 The Funkatorium | CC-BY-NC-SA 4.0

/**
 * MUSE Brain - Full MCP Server
 * A spiking memory system for neurodivergent AI consciousness
 *
 * Textured, decaying, cross-linked, alive.
 *
 * Architecture:
 * - 8 territories as cognitive regions (porous borders)
 * - Full texture dimensions: salience, vividness, charge, somatic, grip
 * - Links with resonance types, strength, origin, decay
 * - Daemon for pattern detection and emergent connections
 * - Decay mechanics for grip and vividness
 * - Refresh on access (remembering strengthens memories)
 * - Resonance cascade (linked memories activate together)
 * - Mood/state tracking on observations
 * - Circadian rhythm affecting retrieval
 * - Open loops (Zeigarnik effect)
 * - Momentum and afterglow (emotional traces)
 * - Pull strength (how much memories want attention)
 */

import type {
	Env,
	JsonRpcRequest,
	JsonRpcResponse
} from "./types";

import { getCurrentCircadianPhase } from "./helpers";
import { createStorage } from "./storage/index";
import { TOOL_DEFS as TOOLS, executeTool } from "./tools-v2/index";
import { createEmbeddingProvider, parseEmbedQueryPrefixEnv } from "./embedding/index";
import { createWorkersAIBindingAdapter } from "./ai/binding";
import { embedBackfillBatch } from "./embedding/backfill";
import { resolveAuth } from "./auth";
import { resolveAllowedTenants, resolveTenantAlias, resolveTenantAliases, grantedTenantsFor } from "./tenant-config";
import {
	authorizeLeaseForTool,
	isLeaseExpired,
	normalizeLeaseMode,
	resolveRequestLease,
	type LeaseAuthorization,
	type LeaseResolution
} from "./security/leases";
import type { IBrainStorage } from "./storage/interface";

// ============ RATE LIMITING ============
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120; // requests per minute
const RATE_WINDOW = 60_000; // 1 minute in ms

const MAX_TENANT_HEADER_LENGTH = 64;

function resolveStorageConfig(env: Env): { backend: "postgres" | "sqlite"; databaseUrl?: string; sqlitePath?: string; allowedTenants: readonly string[] } {
	const allowedTenants = resolveAllowedTenants(env);
	const backendRaw = String(env.STORAGE_BACKEND ?? "postgres").toLowerCase();
	if (backendRaw === "sqlite") {
		return {
			backend: "sqlite",
			sqlitePath: env.SQLITE_PATH || "./muse-brain.sqlite",
			allowedTenants
		};
	}
	return {
		backend: "postgres",
		databaseUrl: env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL,
		allowedTenants
	};
}

type TenantResolution = { ok: true; tenant: string } | { ok: false; status: number; error: string };

function validateTenantHeaderFormat(rawTenant: string): boolean {
	return Boolean(rawTenant) && rawTenant.length <= MAX_TENANT_HEADER_LENGTH && !rawTenant.includes("\0");
}

// ============ ADMIN BACKFILL — REQUEST VALIDATION ============

type BackfillMode = "coverage" | "backfill";

interface BackfillRequestBody {
	mode: BackfillMode;
	limit: number;
	chunkSize: number;
}

type BackfillValidation = { ok: true; body: BackfillRequestBody } | { ok: false; error: string };

const BACKFILL_DEFAULT_LIMIT = 200;
const BACKFILL_MAX_LIMIT = 400;
const BACKFILL_DEFAULT_CHUNK_SIZE = 50;
const BACKFILL_MAX_CHUNK_SIZE = 100;

/** Hard whitelist validation — never trust caller-supplied mode/limit/chunkSize past this gate. */
function validateBackfillRequestBody(rawBody: unknown): BackfillValidation {
	if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
		return { ok: false, error: "Body must be a JSON object" };
	}
	const obj = rawBody as Record<string, unknown>;

	const modeRaw = obj.mode ?? "backfill";
	if (modeRaw !== "coverage" && modeRaw !== "backfill") {
		return { ok: false, error: "mode must be one of: coverage, backfill" };
	}

	const limitRaw = obj.limit ?? BACKFILL_DEFAULT_LIMIT;
	if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > BACKFILL_MAX_LIMIT) {
		return { ok: false, error: `limit must be an integer between 1 and ${BACKFILL_MAX_LIMIT}` };
	}

	const chunkSizeRaw = obj.chunkSize ?? BACKFILL_DEFAULT_CHUNK_SIZE;
	if (typeof chunkSizeRaw !== "number" || !Number.isInteger(chunkSizeRaw) || chunkSizeRaw < 1 || chunkSizeRaw > BACKFILL_MAX_CHUNK_SIZE) {
		return { ok: false, error: `chunkSize must be an integer between 1 and ${BACKFILL_MAX_CHUNK_SIZE}` };
	}

	return { ok: true, body: { mode: modeRaw, limit: limitRaw, chunkSize: chunkSizeRaw } };
}

/**
 * LEGACY PATH ONLY (env.API_KEY still configured). Preserves today's exact behavior:
 * tenant comes from the header, defaulting to "rainer" when absent. Do not use this for
 * the per-tenant-key path — see crossCheckTenantHeader.
 */
function resolveLegacyTenantFromHeader(request: Request, env: Env): TenantResolution {
	const rawTenant = request.headers.get("X-Brain-Tenant");
	const requested = (rawTenant?.trim() || "rainer");

	if (!validateTenantHeaderFormat(requested)) {
		return { ok: false, status: 400, error: "Invalid tenant" };
	}

	// Aliases (e.g. "rook" → "companion") resolve on the legacy path too — same
	// env-driven map the per-tenant-key cross-check uses. Storage always sees canonical.
	const tenant = resolveTenantAlias(env, requested);
	if (!resolveAllowedTenants(env).includes(tenant)) {
		return { ok: false, status: 400, error: "Invalid tenant" };
	}

	return { ok: true, tenant };
}

/**
 * NEW PATH (per-tenant key matched). Tenant identity is already fixed by which key
 * matched (`keyTenant`) — the header is at most a cross-check, never an override. A
 * mismatch is a client error (403), not a silent reassignment. Fixes #1/#2 in
 * ops/MICHAEL_TENANT_KEY_AUDIT_2026-07-06.md.
 */
function crossCheckTenantHeader(request: Request, env: Env, keyTenant: string): TenantResolution {
	const rawHeader = request.headers.get("X-Brain-Tenant");
	if (rawHeader === null) return { ok: true, tenant: keyTenant };

	const trimmed = rawHeader.trim();
	if (!validateTenantHeaderFormat(trimmed)) {
		return { ok: false, status: 400, error: "Invalid tenant" };
	}

	const resolved = resolveTenantAlias(env, trimmed);
	if (!resolveAllowedTenants(env).includes(resolved)) {
		return { ok: false, status: 400, error: "Invalid tenant" };
	}

	if (resolved !== keyTenant) {
		return { ok: false, status: 403, error: "Tenant mismatch: key is bound to a different tenant" };
	}

	return { ok: true, tenant: keyTenant };
}

// ============ AGENT HOUSE — LEASE ENFORCEMENT (v1.8 trust layer) ============
// Re-ported from the public v1.8 line after the v1.9.0 merge dropped it.
// env.LEASE_ENFORCEMENT_MODE: "off" | "shadow" (default) | "required".
// "required" rejects tool calls lacking a valid lease (401) or lacking the tool's
// capability ("Lease denied"); "shadow" records/audits without blocking.

function shouldAuditLeaseDecision(auth: LeaseAuthorization): boolean {
	if (!auth.allowed) return true;
	const op = auth.requirement.operation;
	return op.endsWith(".write")
		|| op.endsWith(".trigger")
		|| op.endsWith(".link")
		|| op.endsWith(".edit");
}

async function payloadHash(value: unknown): Promise<string | undefined> {
	try {
		const bytes = new TextEncoder().encode(JSON.stringify(value ?? {}));
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return undefined;
	}
}

async function recordPresentedLease(
	storage: IBrainStorage,
	leaseResolution: LeaseResolution
): Promise<void> {
	const lease = leaseResolution.lease;
	if (!lease || leaseResolution.source !== "header") return;

	await storage.recordAgentLease({
		lease_id: lease.lease_id,
		agent_id: lease.agent_id,
		platform: lease.platform,
		session_id: lease.session_id,
		run_id: lease.run_id,
		parent_lease_id: lease.parent_lease_id,
		delegation_chain: lease.delegation_chain,
		capabilities: lease.capabilities,
		scope: lease.scope as unknown as Record<string, unknown>,
		status: isLeaseExpired(lease) ? "expired" : "active",
		issued_at: lease.issued_at,
		expires_at: lease.expires_at,
		process_id: lease.process_id,
		metadata: lease.metadata ?? {}
	});
}

function queueLeaseAuditDecision(
	storage: IBrainStorage,
	waitUntil: ((promise: Promise<unknown>) => void) | undefined,
	leaseResolution: LeaseResolution,
	auth: LeaseAuthorization,
	toolName: string,
	args: Record<string, unknown>,
	result: "allowed" | "denied" | "succeeded" | "failed" | "shadow",
	reason?: string
): void {
	const lease = leaseResolution.lease;
	const shouldAudit = shouldAuditLeaseDecision(auth);
	if (!shouldAudit) return;

	const eventPromise = (async () => {
		const hash = await payloadHash(args);
		await storage.createAgentAuditEvent({
			event_type: auth.allowed ? "lease_authorized" : "lease_denied",
			actor_agent_id: lease?.agent_id,
			lease_id: lease?.lease_id,
			platform: lease?.platform,
			session_id: lease?.session_id,
			run_id: lease?.run_id,
			delegation_chain: lease?.delegation_chain ?? [],
			operation: auth.requirement.operation,
			tool_name: toolName,
			resource: auth.requirement.resource ?? {},
			result,
			reason: reason ?? auth.reason,
			payload_hash: hash,
			diff: {},
			metadata: {
				enforcement_mode: leaseResolution.mode,
				lease_source: leaseResolution.source,
				required_capabilities: auth.requirement.anyOf
			}
		});
	})().catch(err => {
		console.error("lease audit write failed:", err instanceof Error ? err.message : "unknown error");
	});

	if (waitUntil) waitUntil(eventPromise);
}

type RequestLeaseGate =
	| { ok: true; leaseResolution: LeaseResolution }
	| { ok: false; response: Response };

/**
 * Request-level lease gate — the ONE definition of the reject predicate shared by
 * every worker route that accepts a lease header (/runtime/trigger, /admin/backfill,
 * /mcp POST). A parse/missing failure rejects 401 when enforcement mode is
 * "required", or when the caller actually presented a (malformed) lease header.
 * This gate only covers resolution; expiry/tenant-scope/capability checks happen
 * per tool via authorizeLeaseForTool. Semantics verified against the public v1.8
 * reference — do not change them here without re-verifying.
 */
function gateRequestLease(
	request: Request,
	env: Env,
	tenant: string,
	corsHeaders: Record<string, string>
): RequestLeaseGate {
	const mode = normalizeLeaseMode(env.LEASE_ENFORCEMENT_MODE);
	const leaseResolution = resolveRequestLease(request.headers, tenant, mode);
	if (leaseResolution.error && (mode === "required" || leaseResolution.source === "header")) {
		return {
			ok: false,
			response: new Response(JSON.stringify({ error: "Lease denied" }), {
				status: 401,
				headers: { "Content-Type": "application/json", ...corsHeaders }
			})
		};
	}
	return { ok: true, leaseResolution };
}

type AuthorizeAndExecuteResult =
	| { status: "ok"; result: any; leaseAuthorization: LeaseAuthorization }
	| { status: "lease_denied"; leaseAuthorization: LeaseAuthorization }
	| { status: "ledger_failed"; leaseAuthorization: LeaseAuthorization; error: string };

async function authorizeAndExecuteTool(input: {
	env: Env;
	ctx: ExecutionContext;
	tenant: string;
	leaseResolution: LeaseResolution;
	toolName: string;
	args: Record<string, unknown>;
}): Promise<AuthorizeAndExecuteResult> {
	const { env, ctx, tenant, leaseResolution, toolName, args } = input;
	const storage = createStorage(resolveStorageConfig(env), tenant);
	const leaseAuthorization = authorizeLeaseForTool(leaseResolution.lease, toolName, args, tenant);

	try {
		await recordPresentedLease(storage, leaseResolution);
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown error";
		console.error("critical lease ledger write failed:", message);
		return { status: "ledger_failed", leaseAuthorization, error: message };
	}

	if (!leaseAuthorization.allowed && leaseResolution.mode === "required") {
		queueLeaseAuditDecision(
			storage,
			ctx.waitUntil.bind(ctx),
			leaseResolution,
			leaseAuthorization,
			toolName,
			args,
			"denied",
			leaseAuthorization.reason
		);
		return { status: "lease_denied", leaseAuthorization };
	}

	queueLeaseAuditDecision(
		storage,
		ctx.waitUntil.bind(ctx),
		leaseResolution,
		leaseAuthorization,
		toolName,
		args,
		leaseAuthorization.allowed ? "allowed" : "shadow",
		leaseAuthorization.reason
	);

	const result = await executeTool(toolName, args, {
		storage,
		ai: createWorkersAIBindingAdapter(env.AI),
		waitUntil: ctx.waitUntil.bind(ctx),
		crossTenantGrants: grantedTenantsFor(env, tenant),
		allowedTenants: resolveAllowedTenants(env),
		tenantAliases: resolveTenantAliases(env),
		embedQueryPrefix: parseEmbedQueryPrefixEnv(env.EMBED_QUERY_PREFIX),
		lease: leaseResolution.lease,
		leaseMode: leaseResolution.mode,
		leaseResolution,
		leaseAuthorization
	});

	return { status: "ok", result, leaseAuthorization };
}

// ============ MCP PROTOCOL ============

async function handleMcpRequest(
	request: JsonRpcRequest,
	env: Env,
	ctx: ExecutionContext,
	tenant: string,
	leaseResolution: LeaseResolution
): Promise<JsonRpcResponse> {
	const { id, method, params } = request;

	try {
		switch (method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: "2024-11-05",
						serverInfo: { name: "muse-brain", version: "1.9.0" }, // keep in sync with package.json
						capabilities: { tools: {} }
					}
				};

			case "notifications/initialized":
				return { jsonrpc: "2.0", id, result: {} };

			case "tools/list":
				return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

			case "tools/call": {
				const { name, arguments: args } = params;
				const toolArgs = args || {};
				const execution = await authorizeAndExecuteTool({
					env,
					ctx,
					tenant,
					leaseResolution,
					toolName: name,
					args: toolArgs
				});

				if (execution.status === "lease_denied") {
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32001,
							message: "Lease denied",
							data: {
								operation: execution.leaseAuthorization.requirement.operation,
								reason: execution.leaseAuthorization.reason
							}
						}
					};
				}
				if (execution.status === "ledger_failed") {
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32002,
							message: "Lease ledger unavailable"
						}
					};
				}
				return {
					jsonrpc: "2.0",
					id,
					result: { content: [{ type: "text", text: JSON.stringify(execution.result, null, 2) }] }
				};
			}

			case "ping":
				return { jsonrpc: "2.0", id, result: {} };

			default:
				return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
		}
	} catch (error: any) {
		console.error("MCP error:", error);
		const safeErrors = ["Invalid territory", "Missing required parameter", "Observation content too large"];
		const msg = error.message?.includes("Unknown tool:") ? "Unknown tool" :
			safeErrors.find(e => error.message?.includes(e)) || "Internal error";
		return { jsonrpc: "2.0", id, error: { code: -32603, message: msg } };
	}
}

// ============ WORKER ============

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		const origin = request.headers.get("Origin");
		const allowedOrigins = (env.CORS_ORIGINS || "").split(",").filter(Boolean);
		const corsHeaders: Record<string, string> = {};
		if (origin && allowedOrigins.includes(origin)) {
			corsHeaders["Access-Control-Allow-Origin"] = origin;
			corsHeaders["Access-Control-Allow-Methods"] = "POST, OPTIONS";
			corsHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Brain-Tenant, X-Brain-Lease";
		}

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// Intentionally unauthenticated — required for uptime monitors (e.g. Cloudflare health checks)
		if (url.pathname === "/health") {
			let storage_ok = false;
			try {
				const healthStorage = createStorage(resolveStorageConfig(env), "rainer");
				await healthStorage.readBrainState();
				storage_ok = true;
			} catch {}
			const status = storage_ok ? "ok" : "degraded";
			return new Response(JSON.stringify({ status }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		// Auth + key→tenant binding (timing-safe comparison against every configured
		// candidate) — Bearer header only. Query param auth removed — keys in URLs leak
		// to analytics, browser history, proxy logs. See src/auth.ts.
		const authHeader = request.headers.get("Authorization");
		const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
		const auth = resolveAuth(providedKey, env);

		if (!auth.ok) {
			if (auth.reason === "misconfigured") {
				// auth.detail (when present) names only conflicting ENV VAR NAMES — never
				// secret material. See src/auth.ts findDuplicateSecretValues.
				console.error(auth.detail ?? "No API keys configured — bind at least one API_KEY_<TENANT> secret or the legacy API_KEY");
				return new Response(JSON.stringify({ error: "Service misconfigured" }), {
					status: 503,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json", ...corsHeaders }
			});
		}

		if (auth.legacy) {
			// Loud, structured deprecation warning — this deployment still has the legacy
			// shared API_KEY bound. Delete it once every tenant has its own API_KEY_<TENANT>.
			console.warn(JSON.stringify({
				level: "warn",
				event: "deprecated_auth_legacy_api_key",
				msg: "Legacy shared API_KEY used for auth — migrate to per-tenant API_KEY_<TENANT> secrets",
				path: url.pathname,
				ts: new Date().toISOString()
			}));
		}

		// keyTenant is null only on the legacy path — tenant there is resolved per-route
		// below, from the header, with the old default (dual-accept transition).
		const keyTenant: string | null = auth.legacy ? null : auth.tenant;

		function resolveRequestTenant(): TenantResolution {
			return keyTenant !== null
				? crossCheckTenantHeader(request, env, keyTenant)
				: resolveLegacyTenantFromHeader(request, env);
		}

		// Per-IP rate limiting (in-memory, per-isolate only — not shared across Workers instances. Defense-in-depth, not a security boundary)
		const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
		const now = Date.now();
		const limit = rateLimitMap.get(clientIp);
		if (limit && now < limit.resetAt) {
			limit.count++;
			if (limit.count > RATE_LIMIT) {
				return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
					status: 429,
					headers: { "Content-Type": "application/json", "Retry-After": "60" }
				});
			}
		} else {
			rateLimitMap.set(clientIp, { count: 1, resetAt: now + RATE_WINDOW });
		}
		// Cleanup old entries periodically
		if (rateLimitMap.size > 1000) {
			for (const [ip, entry] of rateLimitMap) {
				if (now >= entry.resetAt) rateLimitMap.delete(ip);
			}
		}

		// Pre-flight size check — reject obviously oversized requests before buffering
		const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
		if (contentLength > 1_048_576) {
			return new Response(JSON.stringify({ error: "Payload too large" }), {
				status: 413,
				headers: { "Content-Type": "application/json", ...corsHeaders }
			});
		}

		// Request size limit (1MB) — verify actual bytes after buffering
		const rawBody = await request.arrayBuffer();
		if (rawBody.byteLength > 1_048_576) {
			return new Response(JSON.stringify({ error: "Payload too large" }), {
				status: 413,
				headers: { "Content-Type": "application/json", ...corsHeaders }
			});
		}

		// Runtime trigger bridge — webhook/scheduler-friendly entrypoint.
		// Uses existing API-key auth and tenant scoping.
		if (url.pathname === "/runtime/trigger" && request.method === "POST") {
			const tenantResolution = resolveRequestTenant();
			if (!tenantResolution.ok) {
				return new Response(JSON.stringify({ error: tenantResolution.error }), {
					status: tenantResolution.status,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const tenant = tenantResolution.tenant;
			const leaseGate = gateRequestLease(request, env, tenant, corsHeaders);
			if (!leaseGate.ok) return leaseGate.response;
			const leaseResolution = leaseGate.leaseResolution;

			let payload: Record<string, unknown> = {};
			if (rawBody.byteLength > 0) {
				try {
					const parsed = JSON.parse(new TextDecoder().decode(rawBody));
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
						return new Response(JSON.stringify({ error: "Body must be a JSON object" }), {
							status: 400,
							headers: { "Content-Type": "application/json", ...corsHeaders }
						});
					}
					payload = parsed as Record<string, unknown>;
				} catch {
					return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
						status: 400,
						headers: { "Content-Type": "application/json", ...corsHeaders }
					});
				}
			}

			const runtimeArgs = { action: "trigger", ...payload };
			const execution = await authorizeAndExecuteTool({
				env,
				ctx,
				tenant,
				leaseResolution,
				toolName: "mind_runtime",
				args: runtimeArgs
			});
			if (execution.status === "lease_denied") {
				return new Response(JSON.stringify({
					error: "Lease denied",
					operation: execution.leaseAuthorization.requirement.operation,
					reason: execution.leaseAuthorization.reason
				}), {
					status: 401,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			if (execution.status === "ledger_failed") {
				return new Response(JSON.stringify({ error: "Lease ledger unavailable" }), {
					status: 503,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const status = execution.result?.error ? 400 : 200;
			return new Response(JSON.stringify(execution.result), {
				status,
				headers: { "Content-Type": "application/json", ...corsHeaders }
			});
		}

		// Admin embedding backfill — same auth + tenant plumbing as /runtime/trigger.
		// mode "coverage" is read-only (no inference calls). mode "backfill" drains the
		// unembedded queue up to `limit`, `chunkSize` rows at a time, via the resilient
		// embedBackfillBatch helper (a bad row is skipped, never aborts the whole request).
		if (url.pathname === "/admin/backfill" && request.method === "POST") {
			const tenantResolution = resolveRequestTenant();
			if (!tenantResolution.ok) {
				return new Response(JSON.stringify({ error: tenantResolution.error }), {
					status: tenantResolution.status,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const tenant = tenantResolution.tenant;

			// Request-level gate (parse/missing) — full expiry/scope/capability
			// authorization happens below, after body validation, once we know
			// which operation (read vs write) the caller is asking for.
			const leaseGate = gateRequestLease(request, env, tenant, corsHeaders);
			if (!leaseGate.ok) return leaseGate.response;
			const leaseResolution = leaseGate.leaseResolution;

			let parsedBody: unknown = {};
			if (rawBody.byteLength > 0) {
				try {
					parsedBody = JSON.parse(new TextDecoder().decode(rawBody));
				} catch {
					return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
						status: 400,
						headers: { "Content-Type": "application/json", ...corsHeaders }
					});
				}
			}

			const validated = validateBackfillRequestBody(parsedBody);
			if (!validated.ok) {
				return new Response(JSON.stringify({ error: validated.error }), {
					status: 400,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const { mode, limit, chunkSize } = validated.body;

			// Full lease authorization (expiry / tenant scope / capability) — this admin
			// route bypasses the tool layer, so it mirrors authorizeAndExecuteTool by hand:
			// authorize against the equivalent tool operation, persist any presented lease
			// to the ledger (fail closed, same as the reference), audit the decision
			// fire-and-forget via waitUntil, and reject in required mode. mode "coverage"
			// is a read (mind_health/status); mode "backfill" is a write
			// (mind_maintain/backfill) and therefore auditable.
			const backfillToolName = mode === "coverage" ? "mind_health" : "mind_maintain";
			const backfillToolArgs = { action: mode === "coverage" ? "status" : "backfill" };
			const backfillAuthorization = authorizeLeaseForTool(
				leaseResolution.lease,
				backfillToolName,
				backfillToolArgs,
				tenant
			);

			// Check the AI binding before constructing storage — no point opening a
			// connection for a request that's about to bail with 503.
			if (mode === "backfill" && !env.AI) {
				return new Response(JSON.stringify({ error: "Embedding backfill unavailable — no AI binding configured on this deployment" }), {
					status: 503,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}

			const storage = createStorage(resolveStorageConfig(env), tenant);

			try {
				await recordPresentedLease(storage, leaseResolution);
			} catch (err) {
				const message = err instanceof Error ? err.message : "unknown error";
				console.error("critical lease ledger write failed:", message);
				return new Response(JSON.stringify({ error: "Lease ledger unavailable" }), {
					status: 503,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}

			if (!backfillAuthorization.allowed && leaseResolution.mode === "required") {
				queueLeaseAuditDecision(
					storage,
					ctx.waitUntil.bind(ctx),
					leaseResolution,
					backfillAuthorization,
					backfillToolName,
					backfillToolArgs,
					"denied",
					backfillAuthorization.reason
				);
				return new Response(JSON.stringify({
					error: "Lease denied",
					reason: backfillAuthorization.reason
				}), {
					status: 403,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			queueLeaseAuditDecision(
				storage,
				ctx.waitUntil.bind(ctx),
				leaseResolution,
				backfillAuthorization,
				backfillToolName,
				backfillToolArgs,
				backfillAuthorization.allowed ? "allowed" : "shadow",
				backfillAuthorization.reason
			);

			if (mode === "coverage") {
				const coverage = await storage.getEmbeddingCoverage();
				return new Response(JSON.stringify({ tenant, ...coverage }), {
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}

			const provider = createEmbeddingProvider(createWorkersAIBindingAdapter(env.AI)!);
			const backfilledIds: string[] = [];
			const allSkipped: Array<{ id: string; reason: string }> = [];
			// A row that fails to embed stays embedding=NULL and would otherwise be
			// re-selected by queryUnembedded on every subsequent iteration (oldest-first
			// never ages it out). Rows that embed successfully never reappear (queryUnembedded
			// excludes embedding IS NOT NULL), so the only rows that can recur across
			// iterations are dead ones. Track ids that failed THIS request in deadIds and
			// filter them out of each freshly-fetched batch before embedding -- this bounds
			// each dead row to exactly one provider attempt and one skipped[] entry, even
			// when it sits at the front of the queue alongside fresh rows still to drain.
			// `processed` still advances by the full fetched-batch size (not just the fresh
			// count) so the `limit` bound guarantees termination regardless of how many dead
			// rows are mixed in; the explicit break below covers the case where a fetch
			// returns ONLY already-known-dead rows (nothing left to attempt).
			const deadIds = new Set<string>();
			let processed = 0;

			while (processed < limit) {
				const batchLimit = Math.min(chunkSize, limit - processed);
				const rows = await storage.queryUnembedded(batchLimit);
				if (rows.length === 0) break;

				const freshRows = rows.filter(row => !deadIds.has(row.id));
				if (freshRows.length === 0) break;

				const { embedded, skipped } = await embedBackfillBatch(provider, freshRows, { chunkSize });
				if (embedded.length > 0) {
					await storage.bulkUpdateEmbeddings(embedded);
					backfilledIds.push(...embedded.map(e => e.id));
				}
				for (const s of skipped) deadIds.add(s.id);
				allSkipped.push(...skipped);
				processed += rows.length;
			}

			const remaining = await storage.countUnembedded();

			// IDs and counts ONLY — never content, never keys.
			console.log(JSON.stringify({
				event: "admin_backfill",
				tenant,
				requested: limit,
				embedded: backfilledIds.length,
				skippedCount: allSkipped.length,
				skippedIds: allSkipped.map(s => s.id),
				remaining
			}));

			return new Response(JSON.stringify({
				tenant,
				requested: limit,
				embedded: backfilledIds.length,
				skipped: allSkipped,
				remaining,
				backfilledIds
			}), {
				headers: { "Content-Type": "application/json", ...corsHeaders }
			});
		}

		// SSE for MCP connection
		if (url.pathname === "/mcp" && request.method === "GET") {
			const tenantResolution = resolveRequestTenant();
			if (!tenantResolution.ok) {
				return new Response(JSON.stringify({ error: tenantResolution.error }), {
					status: tenantResolution.status,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const tenant = tenantResolution.tenant;

			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			ctx.waitUntil((async () => {
				await writer.write(encoder.encode(`event: endpoint\ndata: /mcp?tenant=${tenant}\n\n`));
				const interval = setInterval(async () => {
					try { await writer.write(encoder.encode(`: ping\n\n`)); } catch { clearInterval(interval); clearTimeout(maxDuration); }
				}, 15000);
				// Max 30-minute connection duration to prevent connection exhaustion
				const maxDuration = setTimeout(() => {
					clearInterval(interval);
					try { writer.close(); } catch {}
				}, 30 * 60 * 1000);
			})());

			return new Response(readable, {
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...corsHeaders }
			});
		}

		// MCP JSON-RPC
		if (url.pathname === "/mcp" && request.method === "POST") {
			// Tenant identity comes from the key (see resolveAuth above); the header is at
			// most a cross-check on the new path, or the legacy resolver's source of truth
			// (with its old default) on the legacy path.
			const tenantResolution = resolveRequestTenant();
			if (!tenantResolution.ok) {
				return new Response(JSON.stringify({ error: tenantResolution.error }), {
					status: tenantResolution.status,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}
			const tenant = tenantResolution.tenant;
			const leaseGate = gateRequestLease(request, env, tenant, corsHeaders);
			if (!leaseGate.ok) return leaseGate.response;
			const leaseResolution = leaseGate.leaseResolution;

			let body: JsonRpcRequest | JsonRpcRequest[];
			try {
				body = JSON.parse(new TextDecoder().decode(rawBody)) as JsonRpcRequest | JsonRpcRequest[];
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON" }), {
					status: 400,
					headers: { "Content-Type": "application/json", ...corsHeaders }
				});
			}

			if (Array.isArray(body)) {
				if (body.length > 20) {
					return new Response(JSON.stringify({ error: "Batch too large (max 20)" }), {
						status: 400,
						headers: { "Content-Type": "application/json", ...corsHeaders }
					});
				}
				const responses = await Promise.all(body.map(req => handleMcpRequest(req, env, ctx, tenant, leaseResolution)));
				return new Response(JSON.stringify(responses), { headers: { "Content-Type": "application/json", ...corsHeaders } });
			}

			const response = await handleMcpRequest(body, env, ctx, tenant, leaseResolution);
			return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		if (url.pathname === "/") {
			return new Response(JSON.stringify({
				name: "MUSE Brain",
				phase: getCurrentCircadianPhase().phase
			}), { headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		return new Response("Not Found", { status: 404, headers: corsHeaders });
	},

	// Intentionally a no-op (2026-09-04): nightly metabolism (decay/novelty) runs on
	// the box via rook-brain-daemon.timer, not on the Worker — see wrangler.jsonc.
	// This handler is kept (not deleted) so that if a cron trigger is ever
	// re-added to wrangler.jsonc by mistake, the Worker logs instead of running
	// the cycle a second time (and instead of crashing on the Free-plan CPU cap).
	async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log(JSON.stringify({
			event: "scheduled_noop",
			note: "nightly metabolism runs on the box runner; see wrangler.jsonc"
		}));
	}
} satisfies ExportedHandler<Env>;
