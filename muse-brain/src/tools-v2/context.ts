// ============ TOOL CONTEXT ============
// Passed to every tool handler. Carries storage + optional Workers AI binding
// + waitUntil for fire-and-forget background work (embedding generation).

import type { IBrainStorage } from "../storage/interface";
import type { WorkersAIClient } from "../ai";
import type { BrainLease, LeaseAuthorization, LeaseEnforcementMode, LeaseResolution } from "../security/leases";

export interface ToolContext {
	// — Core execution plumbing —
	storage: IBrainStorage;
	ai?: WorkersAIClient;                  // Workers AI client — optional
	waitUntil?: (promise: Promise<unknown>) => void;  // ctx.waitUntil from ExecutionContext

	// — Tenant vocabulary — env-resolved, threaded from the worker boundary (tools never
	// see env). Absent (e.g. daemon dispatch, direct test calls) → compiled-in defaults.
	crossTenantGrants?: ReadonlySet<string>;
	allowedTenants?: readonly string[];
	tenantAliases?: Readonly<Record<string, string>>;

	// — Embedding config — env-resolved (EMBED_QUERY_PREFIX), threaded from the worker
	// boundary same as the tenant vocabulary above. Absent (e.g. direct/test handleTool
	// calls) → true (prefix on), matching createEmbeddingProvider's compiled-in default —
	// A/B 2026-09-05 kept it on (SWEEP-2026-09-05.md §prefix). See src/embedding/index.ts.
	embedQueryPrefix?: boolean;

	// — Lease / trust layer — populated together by authorizeAndExecuteTool.
	// Invariant: lease === leaseResolution?.lease and leaseMode === leaseResolution?.mode
	// (the flat fields are convenience aliases; never set one without the other).
	lease?: BrainLease;
	leaseMode?: LeaseEnforcementMode;
	leaseResolution?: LeaseResolution;
	leaseAuthorization?: LeaseAuthorization;
}
