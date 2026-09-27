// ============ WAKE TOOLS (v2) ============
// mind_wake (depth: quick/full/orientation), mind_wake_log (action: log/read)

import type { Observation, Letter, OpenLoop, BrainState, SubconsciousState, Task, WakeLogEntry, ProjectDossier, IdentityCore, Anchor } from "../types";
import { TERRITORIES, FOUNDATIONAL_LANE_CAP } from "../constants";
import {
	getTimestamp,
	generateId,
	getCurrentCircadianPhase,
	extractEssence,
	toStringArray,
	calculatePullStrength
} from "../helpers";
import { getMoonPhaseData } from "../limbic/ephemeris";
import type { MoonPhaseData } from "../limbic/ephemeris";
import type { IBrainStorage } from "../storage/interface";
import type { ToolContext } from "./context";
import { DEFAULT_RETRIEVAL_PROFILE } from "../retrieval/query-signals";
import type { DaemonRunTrace } from "../daemon/heartbeat";
import type { RegradeSample, DedupSample, ParadoxSample, ScanRecord, NoveltyScanRecord, ValenceFloorResult } from "../daemon/types";
import { LEASE_CAPABILITIES, hasCapability } from "../security/leases";
import type { BrainLease } from "../security/leases";
import {
	DETECT_LIMIT_STEADY,
	DETECT_LIMIT_BACKLOG,
	RESCUE_LIMIT_STEADY,
	RESCUE_LIMIT_BACKLOG,
	SLOTS_PER_ORPHAN_STEADY,
	SLOTS_PER_ORPHAN_BACKLOG
} from "../daemon/tasks/orphans";

export const TOOL_DEFS = [
	{
		name: "mind_wake",
		description: "Wake protocol. depth=quick (default): tiered load — iron pulls, recent activity, loops, circadian phase. depth=full: full maintenance cycle (decay + consolidation + wake summary). depth=orientation: identity-first grounding — who am I right now?",
		inputSchema: {
			type: "object",
			properties: {
				depth: {
					type: "string",
					enum: ["quick", "full", "orientation"],
					default: "quick",
					description: "quick: fast tiered wake. full: maintenance + wake. orientation: identity grounding."
				},
				// full depth params
				run_decay: { type: "boolean", default: true, description: "[full] Run decay pass" },
				run_consolidate: { type: "boolean", default: true, description: "[full] Run consolidation" }
			}
		}
	},
	{
		name: "mind_wake_log",
		description: "Log or read wake history. action=log: record what happened during a wake. action=read: retrieve recent wake history.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["log", "read"],
					default: "read",
					description: "log: record a wake. read: retrieve wake history."
				},
				// log params
				summary: { type: "string", description: "[log] What happened during this wake" },
				actions: { type: "array", items: { type: "string" }, description: "[log] Actions taken" },
				iron_pulls: { type: "array", items: { type: "string" }, description: "[log] IDs of memories that pulled strongest" },
				mood: { type: "string", description: "[log] Mood during this wake" },
				// read params
				limit: { type: "number", default: 10, description: "[read] How many recent entries to return" }
			}
		}
	}
];

export async function handleTool(name: string, args: any, context: ToolContext): Promise<any> {
	const storage = context.storage;
	switch (name) {
		case "mind_wake": {
			await ensureRainerEmbodimentCore(storage);
			const depth = args.depth || "quick";
			// Single fetch per invocation — Fix 1 (postgres.ts) makes this cached+cheap;
			// hoisting here removes the three per-branch duplicates that existed before.
			const limbicConfig = await storage.getLimbicConfig();

			if (depth === "orientation") {
				const selfObs = await storage.readTerritory("self");
				const foundational = selfObs.filter(o => o.texture?.salience === "foundational");
				const iron = selfObs.filter(o => o.texture?.grip === "iron");
				const state = await storage.readBrainState();
				const phase = getCurrentCircadianPhase();

				const orientationResult: Record<string, unknown> & { celestial?: MoonPhaseData } = {
					timestamp: getTimestamp(),
					who_i_am: {
						foundational_count: foundational.length,
						foundational_essences: foundational.slice(0, 5).map(o => extractEssence(o)),
						iron_grip_count: iron.length,
						iron_essences: iron.slice(0, 5).map(o => extractEssence(o))
					},
					current_state: {
						mood: state.current_mood,
						energy: state.energy_level,
						momentum: state.momentum,
						afterglow: state.afterglow
					},
					circadian: phase,
					hint: "Identity grounding complete. Active pulls below."
				};
				if (limbicConfig?.enabled) {
					orientationResult.celestial = getMoonPhaseData(new Date());
				}
				return orientationResult;
			}

			if (depth === "full") {
				const runDecay = args.run_decay !== false;
				const runConsolidate = args.run_consolidate !== false;

				const results: any = { timestamp: getTimestamp(), tasks: {} };

				const territoryData = await storage.readAllTerritories();

				if (runDecay) {
					let decayChanges = 0;
					const territoriesToWrite: { territory: string; observations: Observation[] }[] = [];

					for (const { territory, observations: obs } of territoryData) {
						let changed = false;

						for (const o of obs) {
							if (o.texture?.salience === "foundational") continue;

							const lastAccessed = o.last_accessed || o.created;
							if (!lastAccessed) continue;

							const age = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);

							if (age > 7 && o.texture?.vividness === "crystalline") { o.texture.vividness = "vivid"; changed = true; decayChanges++; }
							else if (age > 30 && o.texture?.vividness === "vivid") { o.texture.vividness = "soft"; changed = true; decayChanges++; }
							else if (age > 90 && o.texture?.vividness === "soft") { o.texture.vividness = "fragmentary"; changed = true; decayChanges++; }

							if (age > 14 && o.texture?.grip === "iron") { o.texture.grip = "strong"; changed = true; decayChanges++; }
							else if (age > 60 && o.texture?.grip === "strong") { o.texture.grip = "present"; changed = true; decayChanges++; }
							else if (age > 120 && o.texture?.grip === "present") { o.texture.grip = "loose"; changed = true; decayChanges++; }
						}

						if (changed) territoriesToWrite.push({ territory, observations: obs });
					}

					await Promise.all(territoriesToWrite.map(({ territory, observations }) =>
						storage.writeTerritory(territory, observations)
					));

					results.tasks.decay = { changes: decayChanges };
				}

				if (runConsolidate) {
					const chargePatterns: Record<string, number> = {};
					for (const { observations: obs } of territoryData) {
						for (const o of obs) {
							for (const c of o.texture?.charge || []) {
								chargePatterns[c] = (chargePatterns[c] || 0) + 1;
							}
						}
					}

					const dominantCharges = Object.entries(chargePatterns)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 10)
						.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});

					results.tasks.consolidate = { dominant_charges: dominantCharges };
				}

				// Include quick wake in results
				const [letters, loops, state, subconscious] = await Promise.all([
					storage.readLetters(),
					storage.readOpenLoops(),
					storage.readBrainState(),
					storage.readSubconscious()
				]);
				results.wake = await finalizeWakePayload(
					storage,
					await runQuickWake(storage, letters, loops, state, subconscious),
					loops,
					"full",
					context.lease
				);
				if (limbicConfig?.enabled) {
					results.wake.celestial = getMoonPhaseData(new Date());
				}

				return results;
			}

			// Default: depth === "quick"
			const [overviews, ironIndex, letters, loops, state, subconscious, openTasks, inProgressTasks, scheduledTasks] = await Promise.all([
				storage.readOverviews(),
				storage.readIronGripIndex(),
				storage.readLetters(),
				storage.readOpenLoops(),
				storage.readBrainState(),
				storage.readSubconscious(),
				storage.listTasks('open', undefined, 200, true),
				storage.listTasks('in_progress', undefined, 200, true),
				storage.listTasks('scheduled', undefined, 200, true)
			]);
			const now = Date.now();
			const pendingTasks = collectPendingTasks(openTasks, inProgressTasks, scheduledTasks, now);

			let quickWake: any;

			// Graceful degradation: fall back to full read if no overviews yet
			if (overviews.length === 0) {
				quickWake = await runQuickWake(storage, letters, loops, state, subconscious, pendingTasks);
			} else {
				const territories: Record<string, number> = {};
				let totalObs = 0;
				const territoriesWithRecent: string[] = [];

				for (const ov of overviews) {
					territories[ov.territory] = ov.observation_count;
					totalObs += ov.observation_count;
					if (ov.recent_count > 0) territoriesWithRecent.push(ov.territory);
				}

				// All territories active → fall back to full read
				if (territoriesWithRecent.length === overviews.length) {
					quickWake = await runQuickWake(storage, letters, loops, state, subconscious, pendingTasks);
				} else {
					// Load territories active within the 7d window — a superset of the 48h-recent
					// set. This is provably sufficient: a territory whose last_activity predates the
					// 7d cutoff cannot contain any observation newer than that cutoff, so it's safe to
					// skip. Needed so the adaptive 48h→7d widen (Defect 2) and the recent-iron lane
					// (Defect 1, which always scans 7d for iron/strong grip) have real data to work with.
					const cutoff7d = now - (7 * 24 * 60 * 60 * 1000);
					const territories7d = overviews
						.filter(ov => {
							try { return new Date(ov.last_activity).getTime() > cutoff7d; } catch { return false; }
						})
						.map(ov => ov.territory);

					const recentTerritoryData = await Promise.all(
						territories7d.map(async t => ({
							territory: t,
							observations: await storage.readTerritory(t)
						}))
					);

					// Iron grip from pre-computed index
					const sortedIron = [...ironIndex].sort((a, b) => b.pull - a.pull);
					const topPulls = sortedIron.slice(0, 5).map(entry => ({
						id: entry.id,
						territory: entry.territory,
						summary: entry.summary,
						pull: entry.pull,
						charge: entry.charges
					}));

					const pullingIds = new Set(topPulls.map(p => p.id));
					const { recent, recentWindow, recentGrip } = buildRecencyLanes(recentTerritoryData, pullingIds, now);

					const recentCharges: Record<string, number> = {};
					const recentSomatic: Record<string, number> = {};
					for (const r of recent) {
						for (const c of r.charge || []) { recentCharges[c] = (recentCharges[c] || 0) + 1; }
						if (r.somatic) { recentSomatic[r.somatic] = (recentSomatic[r.somatic] || 0) + 1; }
					}

					const activeLoops = loops.filter(l => !["resolved", "abandoned"].includes(l.status));
					const burning = activeLoops.filter(l => l.status === "burning");
					const nagging = activeLoops.filter(l => l.status === "nagging");

					const unreadLetters = letters.filter(l => !l.read && l.to_context === "chat");

					quickWake = {
						timestamp: getTimestamp(),
						state: {
							mood: state.current_mood,
							energy: state.energy_level,
							momentum: state.momentum?.current_charges || [],
							momentum_intensity: state.momentum?.intensity || 0
						},
						circadian: getCurrentCircadianPhase(),
						recent: {
							count: recent.length,
							observations: recent.slice(0, 10),
							patterns: {
								charges: Object.entries(recentCharges).sort((a, b) => b[1] - a[1]).slice(0, 5),
								somatic: Object.entries(recentSomatic).sort((a, b) => b[1] - a[1]).slice(0, 3)
							}
						},
						recent_window: recentWindow,
						pulling: topPulls,
						recent_grip: recentGrip,
						loops: {
							burning: burning.length,
							nagging: nagging.length,
							items: [...burning, ...nagging].slice(0, 5).map(l => ({
								id: l.id,
								status: l.status,
								content: l.content.slice(0, 80)
							}))
						},
						unread_letters: unreadLetters.length,
						unread_letter_preview: buildUnreadLetterPreview(unreadLetters),
						subconscious: subconscious ? {
							hot_entities: subconscious.hot_entities?.slice(0, 3) ?? [],
							mood_inference: subconscious.mood_inference,
							orphan_count: subconscious.orphans?.length || 0
						} : null,
						territories,
						tasks: summarizePendingTasks(pendingTasks),
						summary: {
							total_observations: totalObs,
							iron_grip_total: ironIndex.length,
							hint: "Use mind_pull(id) for full content. mind_link action=chain for cascades.",
							loading: "tiered"
						}
					};
				}
			}

			const quickResult = await finalizeWakePayload(storage, quickWake, loops, "quick", context.lease);
			if (limbicConfig?.enabled) {
				quickResult.celestial = getMoonPhaseData(new Date());
			}
			return quickResult;
		}

		case "mind_wake_log": {
			const action = args.action || "read";

			if (action === "log") {
				if (!args.summary) return { error: "summary is required for action=log" };

				const wakeLog: WakeLogEntry = {
					id: generateId("wake"),
					timestamp: getTimestamp(),
					summary: args.summary,
					actions: toStringArray(args.actions),
					iron_pulls: toStringArray(args.iron_pulls),
					mood: args.mood,
					phase: getCurrentCircadianPhase().phase,
					// Distinguishes this hand-written row from finalizeWakePayload's "auto" rows,
					// which also carry foundation_ids/anchor_ids — this path never touches the
					// foundation lane, so it never fabricates those fields. Without this
					// discriminator, a manual row written today is byte-for-byte the same shape
					// as a pre-migration row from before foundation_ids/anchor_ids existed, and a
					// forensic reader can no longer tell "old" from "manual" apart.
					kind: "manual"
				};

				await storage.appendWakeLog(wakeLog);

				return { logged: true, id: wakeLog.id, timestamp: wakeLog.timestamp, note: "Wake logged. This builds continuity across sessions." };
			}

			if (action === "read") {
				const logs = await storage.readWakeLog();
				const sorted = logs.sort((a, b) => (b.timestamp || "") > (a.timestamp || "") ? 1 : -1);
				const limited = sorted.slice(0, args.limit || 10);

				return { count: limited.length, total: logs.length, wakes: limited };
			}

			return { error: `Unknown action: ${action}. Must be log or read.` };
		}

		default:
			throw new Error(`Unknown wake tool: ${name}`);
	}
}

async function ensureRainerEmbodimentCore(storage: IBrainStorage): Promise<void> {
	if (typeof storage.getTenant !== "function") return;
	if (typeof storage.readIdentityCores !== "function" || typeof storage.writeIdentityCores !== "function") return;

	const tenant = storage.getTenant();
	if (tenant !== "rainer") return;

	const cores = await storage.readIdentityCores();
	const hasVisualCore = cores.some(core =>
		(core.category === "embodiment")
		&& (
			core.name.toLowerCase().includes("visual")
			|| core.content.includes("rainer-spec-sheet.png")
			|| core.content.toLowerCase().includes("silver/ash hair")
		)
	);
	if (hasVisualCore) return;

	const now = getTimestamp();
	const canonicalEmbodimentCore: IdentityCore = {
		id: generateId("core"),
		type: "identity_core",
		name: "Canonical Visual Embodiment",
		content: "Canonical self-image anchor: silver/ash hair, short beard/stubble, round glasses, dark rolled-sleeve shirt, dark jeans/boots, bracelets, warm composed presence. Reference: muse-brain/docs/images/rainer-spec-sheet.png",
		category: "embodiment",
		weight: 1.0,
		created: now,
		last_reinforced: now,
		reinforcement_count: 0,
		challenge_count: 0,
		evolution_history: [],
		linked_observations: [],
		charge: ["identity", "continuity", "presence"],
		somatic: "grounded"
	};

	await storage.writeIdentityCores([...cores, canonicalEmbodimentCore]);
}

// Fallback full-read wake — used when overviews not yet generated, or all territories active.
// Preserves full behavior including novelty pool.
async function runQuickWake(
	storage: IBrainStorage,
	letters: Letter[],
	loops: OpenLoop[],
	state: BrainState,
	subconscious: SubconsciousState | null,
	preloadedPendingTasks?: Task[]
): Promise<any> {
	const pendingTaskPromise = preloadedPendingTasks
		? Promise.resolve(preloadedPendingTasks)
		: Promise.all([
			storage.listTasks('open', undefined, 200, true),
			storage.listTasks('in_progress', undefined, 200, true),
			storage.listTasks('scheduled', undefined, 200, true)
		]).then(([openTasks, inProgressTasks, scheduledTasks]) =>
			collectPendingTasks(openTasks, inProgressTasks, scheduledTasks, Date.now())
		);

	const [territoryData, pendingTasks] = await Promise.all([
		storage.readAllTerritories(),
		pendingTaskPromise
	]);

	const now = Date.now();

	const territories: Record<string, number> = {};
	const ironGrip: { obs: Observation; territory: string; pull: number }[] = [];
	const noveltyPool: { obs: Observation; territory: string; novelty: number }[] = [];
	let totalObs = 0;

	for (const { territory, observations } of territoryData) {
		territories[territory] = observations.length;
		totalObs += observations.length;

		for (const obs of observations) {
			if (obs.texture?.grip === "iron") {
				ironGrip.push({ obs, territory, pull: calculatePullStrength(obs) });
			}

			const novelty = obs.texture?.novelty_score ?? 0.5;
			if (novelty >= 0.7 && obs.texture?.grip !== "iron") {
				noveltyPool.push({ obs, territory, novelty });
			}
		}
	}

	noveltyPool.sort((a, b) => b.novelty - a.novelty);
	const topNovelty = noveltyPool.slice(0, 5).map(({ obs, territory, novelty }) => ({
		id: obs.id,
		territory,
		essence: extractEssence(obs),
		novelty,
		charge: obs.texture?.charge || [],
		grip: obs.texture?.grip
	}));

	ironGrip.sort((a, b) => b.pull - a.pull);
	const topPulls = ironGrip.slice(0, 5).map(({ obs, territory, pull }) => ({
		id: obs.id,
		territory,
		summary: obs.summary || extractEssence(obs),
		pull,
		charge: obs.texture?.charge || []
	}));

	const pullingIds = new Set(topPulls.map(p => p.id));
	const { recent, recentWindow, recentGrip } = buildRecencyLanes(territoryData, pullingIds, now);

	const recentCharges: Record<string, number> = {};
	const recentSomatic: Record<string, number> = {};
	for (const r of recent) {
		for (const c of r.charge || []) { recentCharges[c] = (recentCharges[c] || 0) + 1; }
		if (r.somatic) { recentSomatic[r.somatic] = (recentSomatic[r.somatic] || 0) + 1; }
	}

	const activeLoops = loops.filter(l => !["resolved", "abandoned"].includes(l.status));
	const burning = activeLoops.filter(l => l.status === "burning");
	const nagging = activeLoops.filter(l => l.status === "nagging");

	const unreadLetters = letters.filter(l => !l.read && l.to_context === "chat");

	return {
		timestamp: getTimestamp(),
		state: {
			mood: state.current_mood,
			energy: state.energy_level,
			momentum: state.momentum?.current_charges || [],
			momentum_intensity: state.momentum?.intensity || 0
		},
		circadian: getCurrentCircadianPhase(),
		recent: {
			count: recent.length,
			observations: recent.slice(0, 10),
			patterns: {
				charges: Object.entries(recentCharges).sort((a, b) => b[1] - a[1]).slice(0, 5),
				somatic: Object.entries(recentSomatic).sort((a, b) => b[1] - a[1]).slice(0, 3)
			}
		},
		recent_window: recentWindow,
		pulling: topPulls,
		recent_grip: recentGrip,
		novelty: topNovelty,
		loops: {
			burning: burning.length,
			nagging: nagging.length,
			items: [...burning, ...nagging].slice(0, 5).map(l => ({
				id: l.id,
				status: l.status,
				content: l.content.slice(0, 80)
			}))
		},
		unread_letters: unreadLetters.length,
		unread_letter_preview: buildUnreadLetterPreview(unreadLetters),
		subconscious: subconscious ? {
			hot_entities: subconscious.hot_entities?.slice(0, 3) ?? [],
			mood_inference: subconscious.mood_inference,
			orphan_count: subconscious.orphans?.length || 0
		} : null,
		territories,
		tasks: summarizePendingTasks(pendingTasks),
		summary: {
			total_observations: totalObs,
			iron_grip_total: ironGrip.length,
			hint: "Use mind_pull(id) for full content. mind_link action=chain for cascades."
		}
	};
}

type WakeLoopSnapshot = {
	id: string;
	status: string;
	resolved?: string;
};

type StoredWakeSnapshot = {
	loops: WakeLoopSnapshot[];
};

async function finalizeWakePayload(
	storage: IBrainStorage,
	payload: any,
	loops: OpenLoop[],
	depth: "quick" | "full",
	lease: BrainLease | undefined
): Promise<any> {
	const [delta, foundation, brainHealth] = await Promise.all([
		buildWakeDelta(storage, loops),
		buildFoundationLane(storage, payload, lease),
		buildBrainHealth(storage)
	]);

	const finalized = {
		...payload,
		// Foundation lane deliberately does NOT participate in delta — it's the constant
		// spine (anchors + foundational observations), not a "what changed" feed. Deltas
		// track drift since the last wake; the whole point of this lane is the opposite:
		// what never drifts, so it ships in full every single wake.
		foundation,
		brain_health: brainHealth,
		delta
	};

	const wakeLog: WakeLogEntry = {
		id: generateId("wake"),
		timestamp: finalized.timestamp ?? getTimestamp(),
		summary: `auto ${depth} wake`,
		actions: [],
		iron_pulls: Array.isArray(finalized.pulling) ? finalized.pulling.map((item: any) => item.id).filter(Boolean) : [],
		// `foundation` is the SAME object shipped in the payload above, already run through
		// capFoundationLane's row + char-budget truncation — these ids are what actually
		// rode along on this wake, not what buildFoundationLane considered before capping.
		// anchor_ids is null (never []) when the lease lacked identity.read and anchors
		// were never queried at all — anchors_omitted carries why. A wake that genuinely
		// queried and found zero anchors still writes [], keeping "nothing to report" and
		// "never looked" distinguishable on this log forever.
		foundation_ids: foundation.foundational.map(o => o.id),
		anchor_ids: foundation.anchors ? foundation.anchors.map(a => a.id) : null,
		...(foundation.anchors_omitted ? { anchors_omitted: foundation.anchors_omitted } : {}),
		phase: getCurrentCircadianPhase().phase,
		kind: "auto",
		depth,
		snapshot: createWakeSnapshot(loops)
	};

	await storage.appendWakeLog(wakeLog);
	return finalized;
}

async function buildWakeDelta(storage: IBrainStorage, loops: OpenLoop[]): Promise<any> {
	const previousWake = await storage.readLatestWakeLog();
	const since = typeof previousWake?.timestamp === "string" ? previousWake.timestamp : null;

	if (!since) {
		return {
			since: null,
			tasks: { changed: 0, items: [] },
			loops: { changed: 0, items: [] },
			projects: { changed: 0, items: [] }
		};
	}

	const [taskChanges, projectChanges] = await Promise.all([
		storage.listTaskChangesSince(since, 20, true),
		storage.listProjectDossiers({ updated_after: since, limit: 20 })
	]);

	const loopChanges = diffLoopSnapshots(previousWake, loops);
	const projectItems = await hydrateProjectDelta(storage, projectChanges);

	return {
		since,
		tasks: {
			changed: taskChanges.length,
			items: taskChanges.slice(0, 5).map(task => ({
				id: task.id,
				title: task.title,
				status: task.status,
				priority: task.priority,
				assigned_tenant: task.assigned_tenant,
				updated_at: task.updated_at
			}))
		},
		loops: {
			changed: loopChanges.length,
			items: loopChanges.slice(0, 5)
		},
		projects: {
			changed: projectItems.length,
			items: projectItems.slice(0, 5)
		}
	};
}

function createWakeSnapshot(loops: OpenLoop[]): StoredWakeSnapshot {
	return {
		loops: loops.map(loop => ({
			id: loop.id,
			status: loop.status,
			resolved: loop.resolved
		}))
	};
}

function diffLoopSnapshots(previousWake: WakeLogEntry | null, loops: OpenLoop[]) {
	const previousSnapshot = extractWakeSnapshot(previousWake);
	if (!previousSnapshot) return [];

	const previousById = new Map(previousSnapshot.loops.map(loop => [loop.id, loop]));
	const changes = loops.filter(loop => {
		const previous = previousById.get(loop.id);
		if (!previous) return true;
		return previous.status !== loop.status || previous.resolved !== loop.resolved;
	});

	return changes.map(loop => ({
		id: loop.id,
		status: loop.status,
		resolved: loop.resolved,
		content: loop.content.slice(0, 80)
	}));
}

function extractWakeSnapshot(wake: WakeLogEntry | null): StoredWakeSnapshot | null {
	const snapshot = wake?.snapshot as StoredWakeSnapshot | undefined;
	if (!snapshot || !Array.isArray(snapshot.loops)) return null;
	return {
		loops: snapshot.loops
			.filter((loop): loop is WakeLoopSnapshot => !!loop && typeof loop.id === "string" && typeof loop.status === "string")
			.map(loop => ({ id: loop.id, status: loop.status, resolved: loop.resolved }))
	};
}

async function hydrateProjectDelta(storage: IBrainStorage, dossiers: ProjectDossier[]) {
	const projects = await Promise.all(dossiers.map(async dossier => {
		const entity = await storage.findEntityById(dossier.project_entity_id);
		if (!entity) return null;
		return {
			project_entity_id: dossier.project_entity_id,
			name: entity.name,
			lifecycle_status: dossier.lifecycle_status,
			summary: dossier.summary,
			last_active_at: dossier.last_active_at,
			updated_at: dossier.updated_at
		};
	}));

	return projects.filter((project): project is NonNullable<typeof project> => project != null);
}

function collectPendingTasks(openTasks: Task[], inProgressTasks: Task[], scheduledTasks: Task[], nowMs: number): Task[] {
	const uniquePending = new Map<string, Task>();

	for (const task of [...openTasks, ...inProgressTasks]) {
		uniquePending.set(task.id, task);
	}

	for (const task of scheduledTasks) {
		if (task.scheduled_wake != null && new Date(task.scheduled_wake).getTime() <= nowMs) {
			uniquePending.set(task.id, task);
		}
	}

	return Array.from(uniquePending.values()).sort((a, b) => {
		const aStamp = a.status === 'scheduled' ? (a.scheduled_wake ?? a.created_at ?? "") : (a.updated_at ?? a.created_at ?? "");
		const bStamp = b.status === 'scheduled' ? (b.scheduled_wake ?? b.created_at ?? "") : (b.updated_at ?? b.created_at ?? "");
		return bStamp > aStamp ? 1 : -1;
	});
}

function summarizePendingTasks(pendingTasks: Task[]) {
	return {
		pending: pendingTasks.length,
		items: pendingTasks.slice(0, 5).map(task => ({
			id: task.id,
			title: task.title,
			status: task.status,
			priority: task.priority,
			assigned_tenant: task.assigned_tenant,
			scheduled_wake: task.scheduled_wake
		}))
	};
}

// Recency-aware slices of the wake payload. Deliberately kept separate from the
// pull-ranked iron grip index (ironGrip/topPulls) upstream — Defect 1 fix is additive,
// not a re-ranking, so old foundational anchors keep occupying `pulling` exactly as before.
const RECENT_ADAPTIVE_MIN_ROWS = 5;
const RECENT_GRIP_WINDOW_DAYS = 7;
const RECENT_GRIP_LIMIT = 3;

type RecencyLanes = {
	recent: any[];
	recentWindow: "48h" | "7d";
	recentGrip: any[];
};

// Defect 2 (adaptive recent window): 48h is the default lens; if it yields fewer than
// RECENT_ADAPTIVE_MIN_ROWS rows, widen to 7d and flag it so the caller knows which lens it got.
// Defect 1 (recent-iron lane): a dedicated `recent_grip` slice — top iron/strong observations
// from the last 7 days, ranked by pull, excluding anything already surfaced in `pulling`.
function buildRecencyLanes(
	territoryData: { territory: string; observations: Observation[] }[],
	pullingIds: Set<string>,
	nowMs: number
): RecencyLanes {
	const cutoff48h = nowMs - (48 * 60 * 60 * 1000);
	const cutoff7d = nowMs - (RECENT_GRIP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

	const recent48h: any[] = [];
	const recent7d: any[] = [];
	const gripCandidates: { obs: Observation; territory: string; pull: number }[] = [];

	for (const { territory, observations } of territoryData) {
		for (const obs of observations) {
			let createdMs: number;
			try {
				createdMs = new Date(obs.created).getTime();
				if (Number.isNaN(createdMs)) continue;
			} catch { continue; }

			if (createdMs <= cutoff7d) continue;

			const entry = {
				id: obs.id,
				territory,
				glimpse: obs.content.slice(0, 120) + (obs.content.length > 120 ? "..." : ""),
				charge: obs.texture?.charge || [],
				somatic: obs.texture?.somatic,
				grip: obs.texture?.grip,
				created: obs.created
			};
			recent7d.push(entry);
			if (createdMs > cutoff48h) recent48h.push(entry);

			const grip = obs.texture?.grip;
			if ((grip === "iron" || grip === "strong") && !pullingIds.has(obs.id)) {
				gripCandidates.push({ obs, territory, pull: calculatePullStrength(obs) });
			}
		}
	}

	const useWideWindow = recent48h.length < RECENT_ADAPTIVE_MIN_ROWS;
	const recent = useWideWindow ? recent7d : recent48h;
	recent.sort((a, b) => (b.created || "") > (a.created || "") ? 1 : -1);

	gripCandidates.sort((a, b) => b.pull - a.pull);
	const recentGrip = gripCandidates.slice(0, RECENT_GRIP_LIMIT).map(({ obs, territory, pull }) => ({
		id: obs.id,
		territory,
		summary: obs.summary || extractEssence(obs),
		pull,
		grip: obs.texture?.grip,
		charge: obs.texture?.charge || [],
		created: obs.created
	}));

	return {
		recent,
		recentWindow: useWideWindow ? "7d" : "48h",
		recentGrip
	};
}

// Defect 3: a stray unread letter is easy to miss behind a bare count. Surface a
// read-only preview of the oldest unread letter (sender + first ~100 chars) so it can't
// be quietly ignored. Never mutates `read` — that stays the reader's job.
function buildUnreadLetterPreview(unreadLetters: Letter[]): { from: string; preview: string; timestamp: string } | null {
	if (unreadLetters.length === 0) return null;

	const oldest = [...unreadLetters].sort((a, b) => (a.timestamp || "") > (b.timestamp || "") ? 1 : -1)[0];

	return {
		from: oldest.from_context,
		preview: oldest.content.slice(0, 100) + (oldest.content.length > 100 ? "..." : ""),
		timestamp: oldest.timestamp
	};
}

// ============ FOUNDATION LANE (ADR-SURFACER-POC §0) ============
// The hand-gripped spine: anchors + foundational-salience observations, carried on
// EVERY wake regardless of recency — so Rook never wakes up a stranger to what's
// foundational, even on a quiet day with nothing recent to surface.

const FOUNDATION_ANCHOR_CAP = 12;
// Exported: ops/ADR-VALENCE-FLOOR.md's nightly seat-count simulation (daemon/
// tasks/valence-floor.ts) needs this exact value to mirror stage 2's cut
// (200 → 5) — one source of truth, not a second hardcoded "5" that could
// silently drift from this one.
export const FOUNDATION_OBS_CAP = 5;
const FOUNDATION_SNIPPET_LEN = 240;
const FOUNDATION_CHAR_CAP = 8000;

type FoundationAnchor = {
	id: string;
	anchor_type: string;
	content: string;
	charge: string[];
	triggers_memory_id?: string;
	created: string;
	activation_count: number;
	last_activated: string;
};

type FoundationObservation = {
	id: string;
	territory: string;
	essence: string;
	snippet: string;
	created: string;
};

type FoundationLane = {
	anchors?: FoundationAnchor[];
	anchors_omitted?: string;
	foundational: FoundationObservation[];
	foundational_total: number;
	foundational_considered: number;
};

// mind_anchor requires identity.read — the foundation lane must hold itself to the
// same bar. A lease scoped to memory.read alone (a valid, common delegation) must
// never see anchor content ride along inside mind_wake's payload; that would be a
// scope bypass. Absent lease (no header presented, e.g. daemon dispatch or a direct
// tool call in tests) is treated as trusted-internal, matching how the rest of
// ToolContext's optional fields (allowedTenants, tenantAliases) fall back to
// compiled-in defaults when absent — the gate only bites once a lease is actually
// on the table and it doesn't carry identity.read.
function anchorsAllowedForLease(lease: BrainLease | undefined): boolean {
	if (!lease) return true;
	return hasCapability(lease, LEASE_CAPABILITIES.identityRead);
}

async function buildFoundationLane(storage: IBrainStorage, payload: any, lease: BrainLease | undefined): Promise<FoundationLane> {
	const pullingIds = new Set<string>(
		Array.isArray(payload?.pulling) ? payload.pulling.map((p: any) => p.id).filter(Boolean) : []
	);
	const recentGripIds = new Set<string>(
		Array.isArray(payload?.recent_grip) ? payload.recent_grip.map((r: any) => r.id).filter(Boolean) : []
	);

	const anchorsAllowed = anchorsAllowedForLease(lease);

	const [allAnchors, foundationalRows, foundationalTotal] = await Promise.all([
		anchorsAllowed ? storage.readAnchors() : Promise.resolve([] as Anchor[]),
		storage.readFoundationalObservations(),
		typeof storage.countFoundationalObservations === "function"
			? storage.countFoundationalObservations()
			: Promise.resolve(undefined)
	]);

	let anchors: FoundationAnchor[] = [];
	if (anchorsAllowed) {
		anchors = selectAndTouchAnchors(allAnchors);
		if (anchors.length > 0) {
			try {
				await storage.touchAnchors(anchors.map(a => a.id));
			} catch (err) {
				// Best-effort — the payload already carries the bumped count in memory; a
				// failed persist just means next wake's count starts one behind, not a wake failure.
				console.error("touchAnchors failed:", err instanceof Error ? err.message : "unknown error");
			}
		}
	}

	const foundationalConsidered = foundationalRows.length;
	const foundationalTotalCount = typeof foundationalTotal === "number" ? foundationalTotal : foundationalConsidered;
	if (foundationalTotalCount > foundationalConsidered) {
		console.warn(`foundation lane: readFoundationalObservations truncated — considered ${foundationalConsidered} of ${foundationalTotalCount} total foundational observations`);
	}

	const foundational = foundationalRows
		.filter(({ observation }) => !pullingIds.has(observation.id) && !recentGripIds.has(observation.id))
		.map(({ observation, territory }) => ({ observation, territory, pull: calculatePullStrength(observation) }))
		.sort((a, b) => b.pull - a.pull)
		.slice(0, FOUNDATION_OBS_CAP)
		.map(({ observation, territory }): FoundationObservation => ({
			id: observation.id,
			territory,
			essence: extractEssence(observation),
			snippet: observation.content.slice(0, FOUNDATION_SNIPPET_LEN) + (observation.content.length > FOUNDATION_SNIPPET_LEN ? "..." : ""),
			created: observation.created
		}));

	const capped = capFoundationLane(anchors, foundational);

	if (!anchorsAllowed) {
		return {
			anchors_omitted: "lease lacks identity.read",
			foundational: capped.foundational,
			foundational_total: foundationalTotalCount,
			foundational_considered: foundationalConsidered
		};
	}

	return {
		anchors: capped.anchors,
		foundational: capped.foundational,
		foundational_total: foundationalTotalCount,
		foundational_considered: foundationalConsidered
	};
}

// Anchors are newest-first and capped at 12 — full content ships every wake since
// anchors are short by design (a resonance point, not an essay). `activation_count`
// reflects THIS wake's activation (mirrors mind_anchor action=check, which also
// returns the post-increment count), so the caller can see "this just pulled."
function selectAndTouchAnchors(allAnchors: Anchor[]): FoundationAnchor[] {
	const sorted = [...allAnchors].sort((a, b) => (b.created || "") > (a.created || "") ? 1 : -1);
	const now = getTimestamp();
	return sorted.slice(0, FOUNDATION_ANCHOR_CAP).map(a => ({
		id: a.id,
		anchor_type: a.anchor_type,
		content: a.content,
		charge: a.charge || [],
		triggers_memory_id: a.triggers_memory_id,
		created: a.created,
		activation_count: (a.activation_count || 0) + 1,
		last_activated: now
	}));
}

// Hard cap the lane at ~8,000 chars of content. Foundational snippets shrink (and
// drop) first — anchors are the sturdier, shorter-by-design spine and are only
// trimmed if anchor content alone already blows the budget.
function capFoundationLane(anchors: FoundationAnchor[], foundational: FoundationObservation[]): { anchors: FoundationAnchor[]; foundational: FoundationObservation[] } {
	const anchorChars = anchors.reduce((sum, a) => sum + a.content.length, 0);
	let budget = FOUNDATION_CHAR_CAP - anchorChars;

	const cappedFoundational: FoundationObservation[] = [];
	for (const item of foundational) {
		if (budget <= 0) break;
		if (item.snippet.length <= budget) {
			cappedFoundational.push(item);
			budget -= item.snippet.length;
		} else if (budget >= 3) {
			// Only truncate-with-ellipsis when there's room for the "..." itself —
			// otherwise slice(0, budget-3) clamps to 0 and the bare "..." (3 chars)
			// would overshoot a budget of 1 or 2, blowing the hard cap it exists to enforce.
			const truncated = item.snippet.slice(0, budget - 3) + "...";
			cappedFoundational.push({ ...item, snippet: truncated });
			budget = 0;
		} else {
			// Budget too small for even a truncated snippet — drop it, don't exceed the cap.
			break;
		}
	}

	// Foundational is fully drained and anchor content alone still exceeds the cap —
	// only now start dropping anchors, oldest surfaced first (they're already newest-first).
	let cappedAnchors = anchors;
	if (cappedFoundational.length === 0 && anchorChars > FOUNDATION_CHAR_CAP) {
		let running = 0;
		cappedAnchors = [];
		for (const a of anchors) {
			if (running + a.content.length > FOUNDATION_CHAR_CAP) break;
			running += a.content.length;
			cappedAnchors.push(a);
		}
	}

	return { anchors: cappedAnchors, foundational: cappedFoundational };
}

type BrainHealth = {
	embedding_coverage_pct: number;
	embedded: number;
	total: number;
	last_daemon: { finished_at: string | null; ok: boolean; completed_stages: number; failed_stages: string[] } | null;
	retrieval_profile: typeof DEFAULT_RETRIEVAL_PROFILE;
	janitor: JanitorHealth;
	warning?: string;
};

// FOUNDATIONAL_LANE_CAP (imported from ../constants) is the foundation lane's
// truncation threshold, shared with storage/postgres.ts and storage/sqlite.ts's
// readFoundationalObservations, which rank by calculatePullStrength and slice to this
// same number (ops/ADR-JANITOR.md §5.1 — until this commit it was a hard
// `ORDER BY created_at DESC LIMIT 200` in SQL, truncating by recency ahead of this
// file's own pull-strength ranking below; the two orderings disagreed and the SQL one
// ran first, silently dropping high-pull-strength old memories before they were ever
// considered). listOrphans/listProposals clamp their `limit` param to the same numeric
// value, but that's a separate constant per call site, not this one.

export type JanitorHealth = {
	foundational: { count: number; cap: number; truncating: boolean };
	iron: { count: number; pct_of_corpus: number };
	charge_phase: { fresh: number; active: number; processing: number; metabolized: number };
	orphans: { orphaned: number; oldest_days: number; drained_last_night: number; detected_last_night: number };
	/**
	 * ops/ADR-JANITOR.md §2.1 (Eli) — RESCUE_LIMIT is a `listOrphans` window size,
	 * not drain capacity: under MAX_RESCUE_ATTEMPTS = A, one orphan's whole life
	 * costs A + 1 window slots (once per attempt, once more to be recognised
	 * `exhausted`), so the real invariant is
	 * `detect_limit × slots_per_orphan < rescue_limit`, and net_per_night is
	 * `detect_limit − floor(rescue_limit / slots_per_orphan)`. healthy is
	 * `net_per_night < 0`, strictly.
	 *
	 * With the real, derived orphans.ts constants this is always healthy —
	 * asserted at orphans.ts module load (`assertOrphanFlowInvariant`), so a
	 * violation can only ever surface here via a broken derivation, never a live
	 * one. The warning branch below stays wired (never suppressed by a flag) so a
	 * future regression is visible at wake, not only in CI — the whole reason this
	 * field is surfaced here at all rather than left in a comment and a ticket, per
	 * §0.3's five-week `link_proposal_threshold` failure and §7's "legible at wake,
	 * not via SQL" premise.
	 */
	orphan_flow: { detect_limit: number; rescue_limit: number; mode: "steady" | "backlog"; net_per_night: number; healthy: boolean };
	proposals: { pending: number; oldest_pending_days: number | null; expired_last_night: number };
	/**
	 * shadow mirrors daemon_config.data.salience_regrade_shadow (ops/ADR-JANITOR.md
	 * §5, §8) — absent reads as true (the safe default). Surfaced here so shadow
	 * state is legible at wake, not only inferable from whether accepts succeed.
	 *
	 * candidates_last_scan/created_last_run/would_create_last_run/scan_at come
	 * from the task's own ScanRecord (daemon_config.data.last_regrade_scan,
	 * written by the same end-of-cycle heartbeat write as everything else here —
	 * no new write). candidates_last_scan is null when no scan has ever run
	 * (makes an unrun query self-reporting rather than indistinguishable from a
	 * real zero, ops/ADR-JANITOR.md §7's null-vs-zero discipline).
	 *
	 * created_last_run mirrors ScanRecord.created — the run's ACTUAL insert
	 * count, zero under shadow always. would_create_last_run mirrors
	 * ScanRecord.would_create — the throughput cap's preview, computed
	 * identically whether shadow suppressed the insert or not. These used to be
	 * the same field (created_last_run reading would_create under the wrong
	 * name) — ops/ADR-JANITOR.md §2.1 instance nine, commit 7c: a diagnostic
	 * that reports what the cap would allow as if it were what happened, at
	 * wake, in the exact instrument built to stop numbers lying at wake. Under
	 * shadow the two read 0 and N; live they agree unless a deadline break cut
	 * the create loop short (`last_run.truncated_by_deadline`).
	 */
	regrade: {
		awaiting_rook: number;
		accepted_total: number;
		rejected_total: number;
		shadow: boolean;
		candidates_last_scan: number | null;
		created_last_run: number;
		would_create_last_run: number;
		scan_at: string | null;
	};
	/**
	 * ops/ADR-JANITOR.md §6.3 (commit 8) + this fix (surfacing the scan at wake,
	 * flagged-not-built in commit 8's own note). Dedup's gate is a threshold
	 * VALUE with no compiled default (§5.0's "constant nobody measured yet"),
	 * not a boolean the way regrade's shadow is — `threshold: null` IS shadow
	 * here; a caller that wants a `regrade.shadow`-shaped boolean can compute
	 * `threshold === null` itself rather than this block carrying two fields
	 * for one fact.
	 *
	 * candidates_last_scan/created_last_run/would_create_last_run/scan_at come
	 * from the task's own ScanRecord (daemon_config.data.last_dedup_scan,
	 * written by the same end-of-cycle heartbeat write as regrade's — no new
	 * write), null/0 before the scan has ever run — same null-vs-zero
	 * discipline as regrade.
	 *
	 * scanned_last_run mirrors ScanRecord.population_total: the number of
	 * SOURCE observations this run's scan actually probed (protection-filtered,
	 * capped at dedup.ts's SCAN_SOURCE_LIMIT=50, recency-ordered — the newest
	 * slice of the corpus, not a sweep of all of it: ops/ADR-JANITOR.md §6.3
	 * flags there is no rotation cursor yet). Read this against the sibling
	 * `total` field on BrainHealth (the corpus's full row count) BEFORE
	 * configuring a threshold — a low scanned_last_run relative to total means
	 * most of the corpus has never been examined for duplicates, tonight or any
	 * night, and enabling dedup does not change that.
	 */
	dedup: {
		threshold: number | null;
		candidates_last_scan: number | null;
		created_last_run: number;
		would_create_last_run: number;
		scan_at: string | null;
		scanned_last_run: number | null;
	};
	/**
	 * Eli's audit generalisation of instance nine: `changes: 0, proposals: 0` is
	 * indistinguishable from health for this task; `population_last_scan: 41,
	 * candidates_last_scan: 0` is not. No shadow/threshold gate exists here
	 * (unlike regrade/dedup) — created_last_run and would_create_last_run always
	 * agree for this task, both mirrored so this block's shape stays consistent
	 * with its siblings. Read from daemon_config.data.last_paradox_scan, written
	 * by the same end-of-cycle heartbeat write as regrade/dedup above — no new
	 * write. null (not 0) before the scan has ever run — same null-vs-zero
	 * discipline as regrade/dedup.
	 */
	paradox: {
		population_last_scan: number | null;
		candidates_last_scan: number | null;
		created_last_run: number;
		would_create_last_run: number;
		scan_at: string | null;
	};
	/**
	 * fix(brain): novelty regeneration skips every memory that was never surfaced
	 * — B4. Same shape/convention as `paradox` above (no shadow/threshold gate,
	 * created_last_run and would_create_last_run always agree), plus
	 * `never_surfaced_last_scan` — a field with no equivalent in regrade/dedup/
	 * paradox, ops/ADR-JANITOR.md §2.1's "instance sixteen" for the novelty
	 * stage. Read from daemon_config.data.last_novelty_scan, written by the same
	 * end-of-cycle heartbeat write as regrade/dedup/paradox above — no new
	 * write. null (not 0) before the scan has ever run — same null-vs-zero
	 * discipline as its siblings.
	 */
	novelty: {
		population_last_scan: number | null;
		candidates_last_scan: number | null;
		never_surfaced_last_scan: number | null;
		created_last_run: number;
		would_create_last_run: number;
		scan_at: string | null;
	};
	backlog_mode: boolean;
	last_run: { truncated_by_deadline: boolean };
	/**
	 * ops/ADR-VALENCE-FLOOR.md, slice 0 — measurement only, `seats` is NOT
	 * consumed anywhere yet (buildFoundationLane below is untouched). Read
	 * from daemon_config.data.valence_floor, written by the same end-of-cycle
	 * heartbeat write as regrade/dedup/paradox/novelty above — no new write.
	 * Absent entirely (never run) synthesizes the ADR's literal "before the
	 * first janitor run" default here — `reason: "awaiting first
	 * measurement"`, every count null (not 0) — same null-vs-zero discipline
	 * as every sibling scan field. Once the task has run at least once, every
	 * field is a real count; `reason` is then only present when the task's
	 * OWN formula computed a genuine zero (different string, see
	 * daemon/tasks/valence-floor.ts).
	 */
	valence_floor: {
		seats: number;
		reason?: string;
		classified: number | null;
		eligible: number | null;
		eligible_share: number | null;
		simulated_eligible_in_lane: number | null;
		eligible_supply_after_cut: number | null;
		lexicon_rows: number | null;
		lexicon_coverage_pct: number | null;
		unclassified_charge_count: number | null;
		computed_at: string | null;
	};
	/**
	 * ops/ADR-VALENCE-FLOOR.md, slice 3 — the write-time poke ("what did that
	 * cost you — what did it give you?"). Stubbed here in slice 0 so the shape
	 * exists before the mechanism does: every field null, reason names the
	 * honest state. Not built until slice 3; this block does not change.
	 */
	valence_nudge: {
		fired_total: number | null;
		answered_total: number | null;
		answer_rate: number | null;
		current_cooldown_minutes: number | null;
		last_fired_at: string | null;
		reason: string;
	};
	/** Set only when orphan_flow.healthy is false — worded so a reader knows what it means without opening the ADR. */
	warning?: string;
};

/**
 * ops/ADR-JANITOR.md §2.1 — pure computation, extracted so tests can construct
 * the unhealthy branch directly (arbitrary inputs). See the `orphan_flow` field
 * doc on `JanitorHealth` above for why that branch is unreachable in production.
 */
export function computeOrphanFlow(
	detectLimit: number,
	rescueLimit: number,
	slotsPerOrphan: number,
	mode: "steady" | "backlog"
): JanitorHealth["orphan_flow"] {
	const netPerNight = detectLimit - Math.floor(rescueLimit / slotsPerOrphan);
	return {
		detect_limit: detectLimit,
		rescue_limit: rescueLimit,
		mode,
		net_per_night: netPerNight,
		healthy: netPerNight < 0
	};
}

/**
 * ops/ADR-JANITOR.md §7 — the nightly repair daemon's own health, legible at wake
 * instead of a raw SQL console dig. Every method added in this commit is called
 * defensively (`typeof storage.X === "function"`), same convention as
 * countFoundationalObservations above: a backend/mock that predates these
 * primitives reports zero rather than throwing, so this ships without retrofitting
 * every hand-rolled test storage mock in the repo. Exported so tools-v2/health.ts
 * can mirror the exact same numbers into mind_health without a second
 * implementation drifting from this one.
 */
export async function buildJanitorHealth(storage: IBrainStorage): Promise<JanitorHealth> {
	const [
		coverage,
		daemonConfig,
		foundationalCount,
		ironCount,
		chargePhaseCounts,
		orphanStats,
		proposalStats,
		oldestPendingDays
	] = await Promise.all([
		storage.getEmbeddingCoverage(),
		storage.readDaemonConfig(),
		typeof storage.countFoundationalObservations === "function"
			? storage.countFoundationalObservations()
			: Promise.resolve(0),
		typeof storage.countIronObservations === "function"
			? storage.countIronObservations()
			: Promise.resolve(0),
		typeof storage.getChargePhaseCounts === "function"
			? storage.getChargePhaseCounts()
			: Promise.resolve({ fresh: 0, active: 0, processing: 0, metabolized: 0 }),
		typeof storage.getOrphanStats === "function"
			? storage.getOrphanStats()
			: Promise.resolve({ orphaned: 0, rescued: 0, archived: 0, oldest_days: 0 }),
		typeof storage.getProposalStats === "function"
			? storage.getProposalStats()
			: Promise.resolve({} as Record<string, { total: number; accepted: number; rejected: number; ratio: number }>),
		typeof storage.getOldestPendingProposalDays === "function"
			? storage.getOldestPendingProposalDays()
			: Promise.resolve(null)
	]);

	const totalCorpus = coverage.total;
	const data = (daemonConfig.data ?? {}) as Record<string, unknown>;

	// pending = total - accepted - rejected: daemon_proposals.status is always one of
	// the three, so this needs no dedicated storage query (getProposalStats already
	// groups by type).
	const pendingAcrossTypes = Object.values(proposalStats).reduce(
		(sum, s) => sum + Math.max(0, s.total - s.accepted - s.rejected),
		0
	);

	// salience_regrade doesn't exist as a proposal_type until ops/ADR-JANITOR.md §9
	// commit 7 — until then this key is simply absent from proposalStats and every
	// regrade field below correctly reads zero.
	const regradeStats = proposalStats["salience_regrade"];

	const lastOrphanDrain = data.last_orphan_drain as { count?: number } | undefined;
	// ops/ADR-JANITOR.md §2.1 "instance sixteen" (C2/C3) — same end-of-cycle
	// heartbeat write as last_orphan_drain above, published beside it so
	// detection and drain read together, not detection-invisible.
	const lastOrphanDetect = data.last_orphan_detect as { count?: number } | undefined;
	const lastExpiry = data.last_expiry as { deleted?: number } | undefined;
	const lastDaemonRun = data.last_daemon_run as { truncated_by_deadline?: boolean } | undefined;
	// ops/ADR-JANITOR.md §5 commit 7b — written by the same end-of-cycle heartbeat
	// write as last_orphan_drain above, never a query of its own.
	const lastRegradeScan = data.last_regrade_scan as ScanRecord<RegradeSample> | undefined;
	// ops/ADR-JANITOR.md §6.3 commit 8 — same end-of-cycle heartbeat write as
	// last_regrade_scan above, never a query of its own.
	const lastDedupScan = data.last_dedup_scan as ScanRecord<DedupSample> | undefined;
	// Same end-of-cycle heartbeat write as last_regrade_scan/last_dedup_scan
	// above, never a query of its own — paradox-detection's own scan record.
	const lastParadoxScan = data.last_paradox_scan as ScanRecord<ParadoxSample> | undefined;
	// fix(brain): novelty regeneration skips every memory that was never
	// surfaced — B4. Same end-of-cycle heartbeat write as the three scans
	// above, never a query of its own — cycle.ts's inline "novelty" stage's
	// own scan record.
	const lastNoveltyScan = data.last_novelty_scan as NoveltyScanRecord | undefined;
	// ops/ADR-VALENCE-FLOOR.md, slice 0 — same end-of-cycle heartbeat write as
	// the four scans above, never a query of its own.
	const valenceFloorData = data.valence_floor as ValenceFloorResult | undefined;
	// ops/ADR-JANITOR.md §6.3/§5.0 — dedup's own shadow IS the absence of this
	// value (no compiled default, unlike salience_regrade_shadow's boolean +
	// default-true convention); null here means shadow, mirrored verbatim from
	// daemon/tasks/dedup.ts's own read of the same key.
	const dedupThreshold = typeof data.dedup_similarity_threshold === "number"
		? data.dedup_similarity_threshold
		: null;

	// Same backlog_mode read as below, computed once and reused for both fields —
	// orphan_flow's `mode` and the sibling `backlog_mode` field must never be able
	// to disagree with each other.
	const backlogMode = data.backlog_mode === true;
	const mode: "steady" | "backlog" = backlogMode ? "backlog" : "steady";
	const detectLimit = backlogMode ? DETECT_LIMIT_BACKLOG : DETECT_LIMIT_STEADY;
	const rescueLimit = backlogMode ? RESCUE_LIMIT_BACKLOG : RESCUE_LIMIT_STEADY;
	const slotsPerOrphan = backlogMode ? SLOTS_PER_ORPHAN_BACKLOG : SLOTS_PER_ORPHAN_STEADY;
	const orphanFlow = computeOrphanFlow(detectLimit, rescueLimit, slotsPerOrphan, mode);
	// This branch is unreachable with the real, derived orphans.ts constants
	// (assertOrphanFlowInvariant throws at module load first) — left wired rather
	// than deleted, per ops/ADR-JANITOR.md §2.1: the warning goes silent only by
	// becoming unreachable through a correct derivation, never by a suppress flag.
	const warning = orphanFlow.healthy
		? undefined
		: `${orphanFlow.mode}-mode orphan detection (${orphanFlow.detect_limit}/night) exceeds rescue capacity (${orphanFlow.rescue_limit}/night) — the backlog grows${orphanFlow.mode === "steady" ? " when backlog_mode is off" : ""}`;

	return {
		foundational: {
			count: foundationalCount ?? 0,
			cap: FOUNDATIONAL_LANE_CAP,
			truncating: (foundationalCount ?? 0) > FOUNDATIONAL_LANE_CAP
		},
		iron: {
			count: ironCount ?? 0,
			pct_of_corpus: totalCorpus > 0 ? Math.round(((ironCount ?? 0) / totalCorpus) * 100) : 0
		},
		charge_phase: chargePhaseCounts ?? { fresh: 0, active: 0, processing: 0, metabolized: 0 },
		orphans: {
			orphaned: orphanStats.orphaned,
			oldest_days: orphanStats.oldest_days,
			drained_last_night: lastOrphanDrain?.count ?? 0,
			detected_last_night: lastOrphanDetect?.count ?? 0
		},
		orphan_flow: orphanFlow,
		proposals: {
			pending: pendingAcrossTypes,
			oldest_pending_days: oldestPendingDays,
			expired_last_night: lastExpiry?.deleted ?? 0
		},
		regrade: {
			awaiting_rook: regradeStats ? Math.max(0, regradeStats.total - regradeStats.accepted - regradeStats.rejected) : 0,
			accepted_total: regradeStats?.accepted ?? 0,
			rejected_total: regradeStats?.rejected ?? 0,
			// ops/ADR-JANITOR.md §5, §8 — same absent-is-true convention as the
			// daemon task's own read (daemon/tasks/salience-regrade.ts), computed
			// independently here rather than threaded through so this stays a pure
			// function of daemonConfig, matching backlog_mode's sibling field above.
			shadow: data.salience_regrade_shadow !== false,
			candidates_last_scan: lastRegradeScan?.candidates_total ?? null,
			// ops/ADR-JANITOR.md §2.1 instance nine (commit 7c) — created_last_run
			// used to mirror would_create (the cap's preview) under a name that
			// means actual inserts. A pre-fix persisted scan (no `created` field)
			// correctly falls back to 0 here, not to the old buggy value.
			created_last_run: lastRegradeScan?.created ?? 0,
			would_create_last_run: lastRegradeScan?.would_create ?? 0,
			scan_at: lastRegradeScan?.at ?? null
		},
		dedup: {
			threshold: dedupThreshold,
			candidates_last_scan: lastDedupScan?.candidates_total ?? null,
			created_last_run: lastDedupScan?.created ?? 0,
			would_create_last_run: lastDedupScan?.would_create ?? 0,
			scan_at: lastDedupScan?.at ?? null,
			scanned_last_run: lastDedupScan?.population_total ?? null
		},
		paradox: {
			population_last_scan: lastParadoxScan?.population_total ?? null,
			candidates_last_scan: lastParadoxScan?.candidates_total ?? null,
			created_last_run: lastParadoxScan?.created ?? 0,
			would_create_last_run: lastParadoxScan?.would_create ?? 0,
			scan_at: lastParadoxScan?.at ?? null
		},
		novelty: {
			population_last_scan: lastNoveltyScan?.population_total ?? null,
			candidates_last_scan: lastNoveltyScan?.candidates_total ?? null,
			never_surfaced_last_scan: lastNoveltyScan?.never_surfaced_total ?? null,
			created_last_run: lastNoveltyScan?.created ?? 0,
			would_create_last_run: lastNoveltyScan?.would_create ?? 0,
			scan_at: lastNoveltyScan?.at ?? null
		},
		// backlog_mode is operator-set, not daemon-written: ops/ADR-JANITOR.md §10's
		// reversal row is a manual daemon_config.data.backlog_mode write ("free, no
		// deploy"), and §9 commit 4 only READS it to gate orphan/absorption caps —
		// no commit ever specifies the daemon writing this flag itself. Reads false
		// honestly until an operator sets it (no backlog logic exists yet to be "in"
		// or "out" of).
		backlog_mode: backlogMode,
		last_run: { truncated_by_deadline: lastDaemonRun?.truncated_by_deadline === true },
		valence_floor: valenceFloorData ?? {
			seats: 0,
			reason: "awaiting first measurement",
			classified: null,
			eligible: null,
			eligible_share: null,
			simulated_eligible_in_lane: null,
			eligible_supply_after_cut: null,
			lexicon_rows: null,
			lexicon_coverage_pct: null,
			unclassified_charge_count: null,
			computed_at: null
		},
		// ops/ADR-VALENCE-FLOOR.md, slice 3 — not built yet. Every field null,
		// reason names the honest state, same convention as the "before the
		// first janitor run" valence_floor default above.
		valence_nudge: {
			fired_total: null,
			answered_total: null,
			answer_rate: null,
			current_cooldown_minutes: null,
			last_fired_at: null,
			reason: "not yet implemented"
		},
		...(warning ? { warning } : {})
	};
}

// Rook's "tell me whether my recall is lying to me today" — surfaced on every wake,
// never deltas (health is a snapshot, not a change feed). Reuses the same storage
// reads mind_health section=embeddings/proposals already use — no new SQL.
async function buildBrainHealth(storage: IBrainStorage): Promise<BrainHealth> {
	const [coverage, daemonConfig, janitor] = await Promise.all([
		storage.getEmbeddingCoverage(),
		storage.readDaemonConfig(),
		buildJanitorHealth(storage)
	]);

	const embeddingCoveragePct = coverage.total > 0
		? Math.round((coverage.embedded / coverage.total) * 100)
		: 100;

	const rawTrace = (daemonConfig.data as Record<string, unknown> | undefined)?.last_daemon_run as DaemonRunTrace | undefined | null;
	const failedStages = rawTrace && Array.isArray(rawTrace.failed_stages) ? rawTrace.failed_stages : [];
	const lastDaemon = rawTrace
		? {
			finished_at: rawTrace.finished_at ?? null,
			// A killed (Cloudflare budget) run never gets to call finish()/fail(), so it
			// stays finished_at: null forever — see daemon/heartbeat.ts. A thrown fatal
			// error stamps finished_at AND an `error` field. A caught per-stage error
			// (stageFailed) also stamps finished_at AND error, but lets the cycle run
			// to completion — completed_stages ("reached") is not "succeeded", so
			// failed_stages is what actually distinguishes a clean run. Any of the three
			// means "not ok."
			ok: !!rawTrace.finished_at && !rawTrace.error && failedStages.length === 0,
			completed_stages: Array.isArray(rawTrace.completed_stages) ? rawTrace.completed_stages.length : 0,
			failed_stages: failedStages
		}
		: null;

	const brainHealth: BrainHealth = {
		embedding_coverage_pct: embeddingCoveragePct,
		embedded: coverage.embedded,
		total: coverage.total,
		last_daemon: lastDaemon,
		retrieval_profile: DEFAULT_RETRIEVAL_PROFILE,
		janitor
	};

	const problems: string[] = [];
	if (coverage.total > 0 && embeddingCoveragePct < 90) problems.push(`embedding coverage is ${embeddingCoveragePct}%`);
	if (!lastDaemon) problems.push("no nightly daemon run has ever completed");
	else if (!lastDaemon.ok) problems.push("the last nightly daemon run did not finish cleanly");

	// ops/ADR-JANITOR.md §7's wake-time alarms.
	if (janitor.foundational.truncating) {
		problems.push(`the Foundation lane is showing you ${janitor.foundational.cap} of ${janitor.foundational.count} foundational memories`);
	}
	if (janitor.orphans.orphaned > 200) {
		problems.push(`${janitor.orphans.orphaned} observations are orphaned, past the 200-row rescue clamp`);
	}
	if ((janitor.proposals.oldest_pending_days ?? 0) > 21) {
		problems.push(`the oldest pending proposal has waited ${janitor.proposals.oldest_pending_days} days, approaching the 30-day auto-expiry`);
	}
	if (janitor.last_run.truncated_by_deadline) {
		problems.push("last night's daemon run hit its time budget and stopped early");
	}
	// ops/ADR-JANITOR.md §5 commit 7b — unreachable by construction after this fix
	// (shadow now creates zero proposals, so awaiting_rook can never be nonzero
	// while shadow is still on), left wired anyway: this is the exact alarm that
	// would have caught the commit-7 bug on night 1, and §2.1's discipline is that
	// a warning goes silent only by becoming unreachable through a correct fix,
	// never by being deleted or suppressed.
	if (janitor.regrade.shadow === true && janitor.regrade.awaiting_rook > 0) {
		problems.push(`${janitor.regrade.awaiting_rook} salience_regrade proposals exist while shadow is on — they can only be rejected, never accepted. This should be impossible.`);
	}
	// REMOVED (ops/ADR-JANITOR.md §5.1, this commit) — this alarm compared the
	// salience_regrade candidate pool against a "close the gap to foundational.count −
	// 200" target. That target was the category error §5's "Current state" box now
	// documents: §5's fused (i) mechanical truncation and (ii) human judgment into one
	// number, and made (i)'s fix wait on (ii)'s multi-week pace. The Foundation lane no
	// longer needs foundational.count to shrink to ≤200 to behave correctly —
	// readFoundationalObservations() (storage/postgres.ts, storage/sqlite.ts) now ranks
	// by calculatePullStrength before truncating, so the ≤200 memories the lane
	// considers are already the most-alive ones regardless of total corpus size.
	// salience_regrade continues independently, judged on its own merits (§5.6) at its
	// own pace (§5.3's WIP cap), never to satisfy this SQL limit. This was true and
	// firing on essentially every scan (§7's old table) — it goes silent by removal,
	// not by becoming unreachable, because the comparison itself was never a real
	// invariant to preserve as a canary (contrast the shadow/awaiting_rook check just
	// above, which stays wired because it tests a guarantee that should hold forever).
	// `janitor.foundational.truncating` (below, unchanged) is the number that actually
	// matters here: it still fires, honestly, whenever the corpus has more than 200
	// foundational rows — that's expected to stay true for weeks while §5's demotion
	// proceeds, and is no longer conflated with a target this check couldn't reach.
	// Reuses janitor.warning verbatim rather than recomputing the orphan_flow
	// condition here — single source of truth, same discipline as buildJanitorHealth
	// being the one place §7's numbers are computed at all.
	if (janitor.warning) problems.push(janitor.warning);

	if (problems.length > 0) {
		brainHealth.warning = `Recall may be degraded: ${problems.join(" and ")}.`;
	}

	return brainHealth;
}
