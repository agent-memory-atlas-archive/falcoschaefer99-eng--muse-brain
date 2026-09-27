import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
	createStorage: vi.fn(),
	runTenantCycle: vi.fn(),
	createWorkersAIRestAdapter: vi.fn(() => ({ run: vi.fn() })),
	storages: [] as Array<{ tenant: string; close: ReturnType<typeof vi.fn> }>
}));

vi.mock('../src/storage/index.js', () => ({
	createStorage: hoisted.createStorage
}));

vi.mock('../src/daemon/cycle.js', () => ({
	runTenantCycle: hoisted.runTenantCycle
}));

vi.mock('../src/ai/rest.js', () => ({
	createWorkersAIRestAdapter: hoisted.createWorkersAIRestAdapter
}));

import { closeStorage, main } from '../daemon-runner/main';

const ACCOUNT_ID = 'd69366bbcb9e63662c708a264c672bf8';

describe('daemon runner cleanup', () => {
	beforeEach(() => {
		hoisted.createStorage.mockReset();
		hoisted.runTenantCycle.mockReset();
		hoisted.createWorkersAIRestAdapter.mockClear();
		hoisted.storages = [];
		process.exitCode = undefined;
		process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/neondb';
		process.env.CF_ACCOUNT_ID = ACCOUNT_ID;
		process.env.CF_AI_TOKEN = 'test-token';
		process.env.ALLOWED_TENANTS = 'rook,rainer';
	});

	it('closes each tenant storage even when a tenant cycle throws', async () => {
		hoisted.createStorage.mockImplementation((_config: unknown, tenant: string) => {
			const storage = { tenant, close: vi.fn(async () => undefined) };
			hoisted.storages.push(storage);
			return storage;
		});
		hoisted.runTenantCycle.mockImplementation(async (_storage: unknown, tenant: string) => {
			if (tenant === 'rook') throw new Error('cycle failed');
			return { fatal: false };
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await main();

		expect(hoisted.storages.map(storage => storage.tenant)).toEqual(['rook', 'rainer']);
		expect(hoisted.storages[0].close).toHaveBeenCalledOnce();
		expect(hoisted.storages[1].close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		errorSpy.mockRestore();
	});

	it('accepts an optional end method without requiring the storage interface to grow', async () => {
		const end = vi.fn(async () => undefined);

		await closeStorage({ end });
		await closeStorage({});

		expect(end).toHaveBeenCalledOnce();
	});
});
