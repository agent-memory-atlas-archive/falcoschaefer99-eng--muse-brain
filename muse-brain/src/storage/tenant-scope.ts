import { ALLOWED_TENANTS } from "../constants";

const TENANT_ID = /^[a-z][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalize the operator-supplied tenant boundary once at storage construction.
 * Storage clones must never widen this boundary back to the compiled defaults.
 */
export function normalizeAllowedTenants(allowedTenants?: readonly string[]): readonly string[] {
	const source = allowedTenants ?? ALLOWED_TENANTS;
	const normalized = [...new Set(source.map(tenant => tenant.trim()))];
	if (normalized.length === 0 || normalized.some(tenant => !TENANT_ID.test(tenant))) {
		throw new Error("Invalid tenant allowlist");
	}
	return normalized;
}

export function isAllowedTenant(tenant: string, allowedTenants: readonly string[]): boolean {
	return allowedTenants.includes(tenant);
}
