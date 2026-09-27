import { describe, expect, it, vi } from 'vitest';
import {
	MAX_LEGACY_DAEMON_CONFIG_STRING_CHARS,
	createPostgresStorage,
	daemonConfigDataJson,
	normalizeDaemonConfigData
} from '../src/storage/postgres';

function makeSql(rows: Array<Record<string, unknown>> = []) {
	const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
	const json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	const end = vi.fn(async (_options?: unknown) => undefined);
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ strings, values });
		return Promise.resolve(rows);
	}) as any;
	sql.json = json;
	sql.end = end;
	return { sql, calls, json, end };
}

describe('Postgres daemon_config JSONB handling', () => {
	describe('normalizeDaemonConfigData', () => {
		it('preserves existing JSON object data', () => {
			const data = { last_daemon_run: { finished_at: '2026-08-02T03:10:00.000Z' }, nested: { ok: true } };
			expect(normalizeDaemonConfigData(data)).toEqual(data);
		});

		it('parses legacy JSONB scalar strings that contain object JSON', () => {
			expect(normalizeDaemonConfigData('{"hello":"world","n":2}')).toEqual({ hello: 'world', n: 2 });
		});

		it('parses one extra layer of stringification from legacy prepared writes', () => {
			const doubleEncoded = JSON.stringify(JSON.stringify({ hello: 'world' }));
			expect(normalizeDaemonConfigData(doubleEncoded)).toEqual({ hello: 'world' });
		});

		it('falls back to an empty object for malformed or non-object legacy values', () => {
			expect(normalizeDaemonConfigData('{nope')).toEqual({});
			expect(normalizeDaemonConfigData('["not","config"]')).toEqual({});
			expect(normalizeDaemonConfigData('"plain scalar"')).toEqual({});
			expect(normalizeDaemonConfigData(null)).toEqual({});
		});

		it('refuses oversized legacy strings before parsing them', () => {
			const oversized = '{"hello":"' + 'x'.repeat(MAX_LEGACY_DAEMON_CONFIG_STRING_CHARS) + '"}';
			expect(normalizeDaemonConfigData(oversized)).toEqual({});
		});
	});

	it('daemonConfigDataJson delegates to postgres.js sql.json instead of stringifying', () => {
		const data = { hello: 'world' };
		const { sql, json } = makeSql();
		const payload = daemonConfigDataJson(sql, data);

		expect(json).toHaveBeenCalledWith(data);
		expect(payload).toEqual({ __postgresJson: data });
	});

	it('updateDaemonConfigData writes the sql.json payload without string-cast JSONB', async () => {
		const data = { hello: 'world' };
		const { sql, calls, json } = makeSql();
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await storage.updateDaemonConfigData(data);

		expect(json).toHaveBeenCalledWith(data);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.strings.join('?')).toContain('INSERT INTO daemon_config');
		expect(call.strings.join('?')).not.toContain('::jsonb');
		expect(call.values[0]).toBe('rainer');
		expect(call.values[1]).toEqual({ __postgresJson: data });
		expect(call.values[2]).toEqual({ __postgresJson: data });
	});

	it('close ends the postgres.js pool with a bounded timeout', async () => {
		const { sql, end } = makeSql();
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await storage.close();

		expect(end).toHaveBeenCalledWith({ timeout: 5 });
	});

	it('readDaemonConfig normalizes legacy scalar-string data while keeping tenant/default fields', async () => {
		const { sql } = makeSql([{
			tenant_id: 'rainer',
			link_proposal_threshold: null,
			last_threshold_update: new Date('2026-08-02T03:00:00.000Z'),
			data: '{"last_daemon_run":{"finished_at":"2026-08-02T03:05:00.000Z"}}'
		}]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await expect(storage.readDaemonConfig()).resolves.toEqual({
			tenant_id: 'rainer',
			link_proposal_threshold: 0.75,
			last_threshold_update: '2026-08-02T03:00:00.000Z',
			data: { last_daemon_run: { finished_at: '2026-08-02T03:05:00.000Z' } }
		});
	});

	it('readDaemonConfig drops oversized corrupted scalar-string data instead of exposing a spreadable string', async () => {
		const { sql } = makeSql([{
			tenant_id: 'rainer',
			link_proposal_threshold: 0.8,
			data: '{"0":"{","1":"\\\"","payload":"' + 'x'.repeat(MAX_LEGACY_DAEMON_CONFIG_STRING_CHARS) + '"}'
		}]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await expect(storage.readDaemonConfig()).resolves.toMatchObject({
			tenant_id: 'rainer',
			link_proposal_threshold: 0.8,
			data: {}
		});
	});
});
