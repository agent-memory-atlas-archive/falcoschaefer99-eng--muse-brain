// ============ TENANT CONFIG ============
// Env-driven tenant vocabulary: which tenants exist, their aliases, and cross-tenant
// read grants. Every function here defaults to the status quo (the compiled-in
// ALLOWED_TENANTS constant, no aliases, no grants) so a single-tenant self-host
// deployment needs zero extra configuration to be safe by default.
//
// See ops/MICHAEL_TENANT_KEY_AUDIT_2026-07-06.md fixes #3 and #4.

import type { Env } from "./types";
import { ALLOWED_TENANTS } from "./constants";

/**
 * The set of tenants this deployment recognizes. Defaults to the compiled-in
 * ALLOWED_TENANTS constant. Override with a comma-separated ALLOWED_TENANTS env var
 * to add/rename tenants without a code change (e.g. when onboarding a new companion).
 */
export function resolveAllowedTenants(env: Env): readonly string[] {
	const raw = env.ALLOWED_TENANTS?.trim();
	if (!raw) return ALLOWED_TENANTS;
	const list = Array.from(new Set(raw.split(",").map(s => s.trim()).filter(Boolean)));
	return list.length > 0 ? list : ALLOWED_TENANTS;
}

/**
 * Compiled-in default aliases — the single source of truth for tenant vocabulary drift
 * (the historical hardcoded map from constants.ts lives here now). Preserves the
 * rook → companion mapping so deployments WITHOUT a TENANT_ALIASES env var keep
 * accepting live clients that still say "rook" instead of 400ing them.
 */
export const DEFAULT_TENANT_ALIASES: Readonly<Record<string, string>> = {
	"rook": "companion"
};

/**
 * Alias map for reconciling tenant vocabulary drift across deployments (e.g. a client
 * that still speaks "rook" while the server speaks "companion"). Format:
 * "alias1:canonical1,alias2:canonical2". Default: DEFAULT_TENANT_ALIASES. Setting
 * TENANT_ALIASES REPLACES the default map entirely (so an operator can also retire
 * the built-in rook alias); an unset or unparsable value falls back to the default.
 */
export function resolveTenantAliases(env: Env): Readonly<Record<string, string>> {
	const raw = env.TENANT_ALIASES?.trim();
	if (!raw) return DEFAULT_TENANT_ALIASES;
	const out: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const [aliasRaw, canonicalRaw] = pair.split(":");
		const alias = aliasRaw?.trim();
		const canonical = canonicalRaw?.trim();
		if (alias && canonical) out[alias] = canonical;
	}
	return Object.keys(out).length > 0 ? out : DEFAULT_TENANT_ALIASES;
}

/**
 * Resolves an alias (e.g. "rook") to its canonical tenant name (e.g. "companion").
 * Input is trimmed + lowercased first — aliases and tenant ids are lowercase by
 * convention, so this only widens accepted input case ("Rook" ≡ "rook"); it never
 * changes the canonical result or the caller's allowlist check. This is the one
 * place both entry paths (HTTP tenant header and mind_letter recipients) share
 * their case semantics. Unknown values pass through lowercased.
 *
 * ALLOWLIST BEATS ALIAS — always. A name explicitly present in the resolved
 * allowed-tenants list is a real configured tenant and is NEVER alias-redirected,
 * neither by the compiled-in default map nor by an explicit TENANT_ALIASES entry.
 * This is what keeps a deployment with ALLOWED_TENANTS="rook,rainer" (tenant_id
 * 'rook' in the database) working: "rook" resolves to itself instead of being
 * shadowed by the default rook → companion alias. Fresh self-hosters on the
 * default allowlist (["companion","rainer"]) still get the rook → companion
 * convenience, because 'rook' is not in their allowlist.
 */
export function resolveTenantAlias(env: Env, raw: string): string {
	const normalized = raw.trim().toLowerCase();
	if (resolveAllowedTenants(env).includes(normalized)) return normalized;
	const aliases = resolveTenantAliases(env);
	return aliases[normalized] ?? normalized;
}

export function isKnownTenant(env: Env, tenant: string): boolean {
	return resolveAllowedTenants(env).includes(tenant);
}

/**
 * Cross-tenant READ grants: which OTHER tenants a given key-bound tenant may reach via
 * scope:"all" project-registry lookups or a non-default mind_runtime agent_tenant.
 * Format: "granter:granted[,granter:granted...]" e.g. "rainer:companion,companion:rainer".
 * Default: empty — no tenant may cross-read another's data without an explicit grant.
 * This is separate from (and in addition to) the per-project visibility="shared" opt-in
 * already enforced in mind_memory's project registry.
 */
export function resolveCrossTenantReadGrants(env: Env): ReadonlyMap<string, ReadonlySet<string>> {
	const raw = env.CROSS_TENANT_READ_GRANTS?.trim();
	const map = new Map<string, Set<string>>();
	if (!raw) return map;
	for (const pair of raw.split(",")) {
		const [fromRaw, toRaw] = pair.split(":");
		const from = fromRaw?.trim();
		const to = toRaw?.trim();
		if (!from || !to) continue;
		if (!map.has(from)) map.set(from, new Set());
		map.get(from)!.add(to);
	}
	return map;
}

/** The set of tenants `tenant` is explicitly granted cross-tenant read access to. Empty by default. */
export function grantedTenantsFor(env: Env, tenant: string): ReadonlySet<string> {
	return resolveCrossTenantReadGrants(env).get(tenant) ?? new Set();
}
