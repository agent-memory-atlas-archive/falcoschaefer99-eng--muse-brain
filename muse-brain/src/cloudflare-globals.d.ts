/** Minimal fallback declarations for the checked-in Wrangler types. */
interface Ai { run(model: string, input: unknown): Promise<unknown>; }
interface Hyperdrive { connectionString: string; }
interface R2Bucket { }
