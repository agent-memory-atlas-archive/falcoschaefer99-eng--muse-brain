import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TENANT_ALIASES,
	grantedTenantsFor,
	isKnownTenant,
	resolveAllowedTenants,
	resolveCrossTenantReadGrants,
	resolveTenantAlias,
	resolveTenantAliases
} from '../src/tenant-config';
import { ALLOWED_TENANTS } from '../src/constants';
import type { Env } from '../src/types';

describe('tenant-config: env-driven tenant vocabulary', () => {
	describe('resolveAllowedTenants', () => {
		it('defaults to the compiled-in ALLOWED_TENANTS constant with zero configuration', () => {
			expect(resolveAllowedTenants({} as Env)).toEqual(ALLOWED_TENANTS);
		});

		it('overrides via a comma-separated ALLOWED_TENANTS env var', () => {
			const env = { ALLOWED_TENANTS: 'companion,rainer,newco' } as unknown as Env;
			expect(resolveAllowedTenants(env)).toEqual(['companion', 'rainer', 'newco']);
		});

		it('trims whitespace and dedupes', () => {
			const env = { ALLOWED_TENANTS: ' companion , rainer , companion ' } as unknown as Env;
			expect(resolveAllowedTenants(env)).toEqual(['companion', 'rainer']);
		});

		it('falls back to the default when the override is empty/whitespace-only', () => {
			expect(resolveAllowedTenants({ ALLOWED_TENANTS: '   ' } as unknown as Env)).toEqual(ALLOWED_TENANTS);
			expect(resolveAllowedTenants({ ALLOWED_TENANTS: ',,,' } as unknown as Env)).toEqual(ALLOWED_TENANTS);
		});
	});

	describe('resolveTenantAliases / resolveTenantAlias', () => {
		it('defaults to the compiled-in alias map (rook → companion preserved for live clients)', () => {
			expect(resolveTenantAliases({} as Env)).toEqual(DEFAULT_TENANT_ALIASES);
			expect(resolveTenantAlias({} as Env, 'rook')).toBe('companion');
		});

		it('an explicit TENANT_ALIASES env replaces the compiled-in default entirely', () => {
			const env = { TENANT_ALIASES: 'muse:rainer' } as unknown as Env;
			expect(resolveTenantAliases(env)).toEqual({ muse: 'rainer' });
			// The built-in rook alias is retired when the operator supplies their own map.
			expect(resolveTenantAlias(env, 'rook')).toBe('rook');
		});

		it('falls back to the compiled-in default when the override is unparsable', () => {
			expect(resolveTenantAliases({ TENANT_ALIASES: ' , : ,' } as unknown as Env)).toEqual(DEFAULT_TENANT_ALIASES);
		});

		it('parses ALIAS:CANONICAL pairs and resolves through them', () => {
			const env = { TENANT_ALIASES: 'rook:companion' } as unknown as Env;
			expect(resolveTenantAliases(env)).toEqual({ rook: 'companion' });
			expect(resolveTenantAlias(env, 'rook')).toBe('companion');
		});

		it('passes unknown values through (lowercased)', () => {
			const env = { TENANT_ALIASES: 'rook:companion' } as unknown as Env;
			expect(resolveTenantAlias(env, 'rainer')).toBe('rainer');
			expect(resolveTenantAlias(env, 'stranger')).toBe('stranger');
		});

		it('never alias-redirects a name that is itself an allowed tenant (production: ALLOWED_TENANTS="rook,rainer")', () => {
			// The rook-brain production worker: DB stores tenant_id='rook', allowlist is
			// overridden, TENANT_ALIASES is unset. The default rook → companion alias must
			// NOT shadow the real configured tenant — that would 400 every 'rook' request.
			const env = { ALLOWED_TENANTS: 'rook,rainer' } as unknown as Env;
			expect(resolveTenantAlias(env, 'rook')).toBe('rook');
			expect(resolveTenantAlias(env, 'Rook')).toBe('rook');
		});

		it('keeps the rook → companion convenience on the default allowlist (fresh self-hoster)', () => {
			// Default allowlist is ["companion","rainer"] — 'rook' is not in it, so the
			// compiled-in alias still applies.
			expect(resolveTenantAlias({} as Env, 'rook')).toBe('companion');
		});

		it('allowlist beats even an explicit TENANT_ALIASES entry', () => {
			const env = { ALLOWED_TENANTS: 'rook,rainer', TENANT_ALIASES: 'rook:companion' } as unknown as Env;
			expect(resolveTenantAlias(env, 'rook')).toBe('rook');
		});

		it('normalizes case and whitespace before alias lookup — "Rook" ≡ "rook"', () => {
			// Reeve #3 / Michael cosmetic: the letter path lowercased, the HTTP path did
			// not, so header "Rook" 400ed while letter "Rook" worked. One semantic now.
			expect(resolveTenantAlias({} as Env, 'Rook')).toBe('companion');
			expect(resolveTenantAlias({} as Env, ' ROOK ')).toBe('companion');
			expect(resolveTenantAlias({} as Env, 'Rainer')).toBe('rainer');
		});

		it('parses multiple pairs', () => {
			const env = { TENANT_ALIASES: 'rook:companion,muse:rainer' } as unknown as Env;
			expect(resolveTenantAliases(env)).toEqual({ rook: 'companion', muse: 'rainer' });
		});
	});

	describe('isKnownTenant', () => {
		it('checks membership against the resolved allowlist', () => {
			expect(isKnownTenant({} as Env, 'rainer')).toBe(true);
			expect(isKnownTenant({} as Env, 'hacker')).toBe(false);
		});
	});

	describe('resolveCrossTenantReadGrants / grantedTenantsFor', () => {
		it('defaults to empty — no tenant may cross-read another without an explicit grant', () => {
			expect(resolveCrossTenantReadGrants({} as Env).size).toBe(0);
			expect(grantedTenantsFor({} as Env, 'rainer').size).toBe(0);
		});

		it('parses GRANTER:GRANTED pairs', () => {
			const env = { CROSS_TENANT_READ_GRANTS: 'rainer:companion' } as unknown as Env;
			expect(grantedTenantsFor(env, 'rainer').has('companion')).toBe(true);
			expect(grantedTenantsFor(env, 'companion').has('rainer')).toBe(false);
		});

		it('supports multiple pairs, including bidirectional grants', () => {
			const env = { CROSS_TENANT_READ_GRANTS: 'rainer:companion,companion:rainer' } as unknown as Env;
			expect(grantedTenantsFor(env, 'rainer')).toEqual(new Set(['companion']));
			expect(grantedTenantsFor(env, 'companion')).toEqual(new Set(['rainer']));
		});

		it('supports one granter having multiple grantees', () => {
			const env = { CROSS_TENANT_READ_GRANTS: 'rainer:companion,rainer:newco' } as unknown as Env;
			expect(grantedTenantsFor(env, 'rainer')).toEqual(new Set(['companion', 'newco']));
		});
	});
});
