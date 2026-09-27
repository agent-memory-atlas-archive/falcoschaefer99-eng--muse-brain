import type { IBrainStorage } from "../storage/interface";
import type { ArrivalBoundary, DaemonRunContext } from "./types";

/** Return a canonical ISO timestamp only when the value is a real ISO instant. */
export function validIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
	return !Number.isNaN(new Date(value).getTime());
}

/**
 * Extract the previous run boundary only from a successful heartbeat.
 * Interrupted and explicitly failed runs must not advance the window, or
 * their missed work would disappear from the next metabolism pass.
 */
export function extractPreviousSuccessfulRunStartedAt(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const trace = (data as Record<string, unknown>).last_daemon_run;
	if (!trace || typeof trace !== "object") return undefined;
	const run = trace as Record<string, unknown>;
	// A thrown/failed run may still have a finished_at from heartbeat.fail().
	// Its boundary is not successful and must be replayed next time.
	if (Object.prototype.hasOwnProperty.call(run, "error")) return undefined;
	if (!validIsoTimestamp(run.started_at) || !validIsoTimestamp(run.finished_at)) return undefined;
	return new Date(run.started_at).toISOString();
}

/** Read the boundary before this run; heartbeat/config failures remain best-effort. */
export async function readDaemonRunContext(storage: IBrainStorage): Promise<DaemonRunContext> {
	try {
		const config = await storage.readDaemonConfig();
		const data = (config.data ?? {}) as Record<string, unknown>;
		const previousRunStartedAt = extractPreviousSuccessfulRunStartedAt(config.data);
		return {
			// The one authoritative construction site for ArrivalBoundary — every
			// other reader receives it already branded via DaemonRunContext, never
			// casts a plain string to it themselves.
			arrivalBoundary: previousRunStartedAt as ArrivalBoundary | undefined,
			// Operator-set only (ops/ADR-JANITOR.md §9 commit 4) — undefined (not
			// `false`) when unset, matching arrivalBoundary's own convention so callers
			// that toEqual() an empty/partial context don't see a spurious extra key.
			backlogMode: data.backlog_mode === true ? true : undefined
		};
	} catch (err) {
		console.error("Daemon run context read failed:", err instanceof Error ? err.message : "unknown error");
		return {};
	}
}

/**
 * The only sanctioned read of ANOTHER tenant's daemon config surface (Michael
 * audit of 80673e5/369c128, MEDIUM 85). `readDaemonConfig()` returns the FULL,
 * unrestricted `data` blob — which now carries `last_regrade_scan.sample`, up
 * to 25 memory summaries — to any caller holding a storage handle, including a
 * `forTenant()` cross-tenant clone. `readDaemonRunContext()` above is narrow
 * today only because its own return type happens to name two fields; that is
 * one caller's discipline, not a property of the interface, and the next
 * cross-tenant task (ops/ADR-JANITOR.md §6.1's dedup scan) is exactly the kind
 * of caller that could reach past it. This wrapper's return type IS the
 * boundary: it cannot carry a key it doesn't declare, regardless of what
 * `daemon_config.data` grows to hold next. Route every cross-tenant read
 * through this — never through `readDaemonConfig()` or `readDaemonRunContext()`
 * directly.
 */
export async function readCrossTenantBoundary(
	storage: IBrainStorage
): Promise<Pick<DaemonRunContext, "arrivalBoundary" | "backlogMode">> {
	const { arrivalBoundary, backlogMode } = await readDaemonRunContext(storage);
	return { arrivalBoundary, backlogMode };
}
