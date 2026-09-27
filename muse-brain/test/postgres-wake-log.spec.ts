import { describe, expect, it, vi } from 'vitest';
import { createPostgresStorage } from '../src/storage/postgres';
import type { WakeLogEntry } from '../src/types';

// The wake_log table stores the entire WakeLogEntry as one JSONB blob (no per-field
// columns) — these tests exist to prove that plumbing is genuinely field-agnostic on
// the postgres backend too, not just assumed from reading the sqlite side. If postgres
// ever grows an allowlist/column mapping for this table, these are the tests that catch
// foundation_ids/anchor_ids silently getting dropped.

function makeSql(rows: Array<Record<string, unknown>> = []) {
	const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
	const json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ strings, values });
		return Promise.resolve(rows);
	}) as any;
	sql.json = json;
	return { sql, calls, json };
}

function entry(overrides: Partial<WakeLogEntry> = {}): WakeLogEntry {
	return {
		id: 'wake_1',
		timestamp: '2026-09-17T00:00:00.000Z',
		summary: 'auto quick wake',
		actions: [],
		iron_pulls: [],
		phase: 'day',
		kind: 'auto',
		depth: 'quick',
		...overrides
	};
}

describe('Postgres wake_log — foundation_ids/anchor_ids pass through the generic JSONB blob', () => {
	it('appendWakeLog hands the WHOLE entry (including foundation_ids/anchor_ids) to sql.json — no field allowlist', async () => {
		const { sql, calls, json } = makeSql();
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const wakeLog = entry({ foundation_ids: ['obs_a', 'obs_b'], anchor_ids: ['anchor_1'] });
		await storage.appendWakeLog(wakeLog);

		expect(json).toHaveBeenCalledWith(wakeLog);
		expect(calls).toHaveLength(1);
		expect(calls[0].values).toContainEqual({ __postgresJson: wakeLog });
	});

	it('readWakeLog/readLatestWakeLog round-trip foundation_ids/anchor_ids unmodified', async () => {
		const stored = entry({ id: 'wake_new', foundation_ids: ['obs_a'], anchor_ids: [] });
		const { sql } = makeSql([{ data: stored }]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const [logged] = await storage.readWakeLog();
		expect(logged.foundation_ids).toEqual(['obs_a']);
		expect(logged.anchor_ids).toEqual([]);

		const latest = await storage.readLatestWakeLog();
		expect(latest!.foundation_ids).toEqual(['obs_a']);
		expect(latest!.anchor_ids).toEqual([]);
	});

	it('a legacy row with no foundation_ids/anchor_ids reads back without throwing, fields stay absent (not defaulted to [])', async () => {
		const legacy = entry({ id: 'wake_legacy' }); // no foundation_ids/anchor_ids keys at all
		const { sql } = makeSql([{ data: legacy }]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const [logged] = await storage.readWakeLog();
		expect(logged.id).toBe('wake_legacy');
		expect(logged.foundation_ids).toBeUndefined();
		expect(logged.anchor_ids).toBeUndefined();
		expect('foundation_ids' in logged).toBe(false);
	});
});

describe('Postgres wake_log — corrupted JSON blob logs before falling back', () => {
	it('a malformed data column logs a parse error, then the row is dropped by the existing id filter (not thrown, not fabricated)', async () => {
		const { sql } = makeSql([{ data: '{not valid json' }]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const logs = await storage.readWakeLog();

			// Fallback behavior is unchanged — parseJsonRecord's empty-object fallback has
			// no `id`, so readWakeLog's existing `typeof entry.id === "string"` filter drops
			// it, same as it would for any other shapeless row.
			expect(logs).toEqual([]);
			expect(errorSpy).toHaveBeenCalled();
			const messages = errorSpy.mock.calls.map(call => call[0]);
			expect(messages.some(m => typeof m === 'string' && m.includes('parseJsonValue'))).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
