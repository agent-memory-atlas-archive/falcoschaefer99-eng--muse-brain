import { describe, expect, it, vi } from 'vitest';
import { createPostgresStorage } from '../src/storage/postgres';

// parseJsonValue's catch branch used to `break` out of its retry loop, leaving `raw` set
// to the pre-parse (corrupt) string, then fall through to `return (raw ?? fallback)` —
// since a non-empty string is truthy, that returned the corrupt string itself, not the
// caller's declared fallback. parseJsonRecord/parseJsonArray re-validate shape and mask
// this for ~20 of ~22 call sites, but readConversationContext and readBackfillFlag call
// parseJsonValue directly and are both typed Promise<unknown> with a `null` fallback —
// these tests drive corruption through those two direct callers.

function makeSql(rows: Array<Record<string, unknown>>) {
	return ((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(rows)) as any;
}

describe('postgres.ts direct parseJsonValue callers return the declared fallback on corruption', () => {
	it('readConversationContext returns null, not the corrupt string, when the stored blob fails to parse', async () => {
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = makeSql([{ data: '{not valid json' }]);

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const result = await storage.readConversationContext();
			expect(result).toBeNull();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('readBackfillFlag returns null, not the corrupt string, when the stored blob fails to parse', async () => {
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = makeSql([{ data: '{not valid json' }]);

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const result = await storage.readBackfillFlag('v1');
			expect(result).toBeNull();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
