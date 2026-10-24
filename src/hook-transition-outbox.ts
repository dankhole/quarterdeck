import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import type { DiagnosticCaptureScope } from "./core/api/diagnostics.js";
import type { RuntimeHookIngestRequest, RuntimeHookIngestResponse } from "./core/api/task-session.js";
import { runtimeHookIngestRequestSchema } from "./core/api/task-session.js";
import { diagnosticErrorClassOf } from "./core/diagnostic-error-class.js";
import { createTaggedLogger } from "./core/runtime-logger.js";
import { isNodeError } from "./fs/node-error.js";
import {
	abandonHookTransition,
	acknowledgeHookTransition,
	createPersistedHookTransition,
	enqueueHookTransition,
	getOutboxDirectoryPath,
	HOOK_TRANSITION_OUTBOX_TTL_MS,
	normalizeHookTransitionReplayMetadata,
	OUTBOX_RECORD_VERSION,
	type PersistedHookTransition,
} from "./hook-transition-outbox-core.js";

// This module owns the replay scan (schema validation, diagnostics, logging) on top of
// the zod-free primitives in `./hook-transition-outbox-core.js`. The lightweight hook
// entry (`dist/hooks.js`) imports only that narrow core module and never this one, so
// the zod/diagnostics cost below is paid only by the long-lived server process.
const outboxLog = createTaggedLogger("hook-outbox");

export {
	abandonHookTransition,
	acknowledgeHookTransition,
	createPersistedHookTransition,
	enqueueHookTransition,
	HOOK_TRANSITION_OUTBOX_TTL_MS,
	type PersistedHookTransition,
};

export const HOOK_TRANSITION_REPLAY_INTERVAL_MS = 2_000;
/**
 * Periodic replay adopts a record as soon as its `hooks ingest` writer marks it
 * abandoned. An unmarked record may still be in delivery, so replay waits this
 * long after enqueue: more than the writer's total delivery budget
 * (`HOOK_INGEST_TOTAL_TIMEOUT_MS`, 3.25s, in hooks-runtime-client.ts) plus slack
 * for a CPU-starved writer under load, which also bounds the delay when the
 * writer died without marking it (for example, killed by a provider hook
 * timeout). Replaying sooner would race the live delivery. Replay preserves the
 * bounded supported foreground reply, but intentionally omits other live content.
 */
export const HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS = 6_000;

// Not .strict(): an older reader parsing a record written by a newer CLI build
// simply drops any field it doesn't declare here (plain z.object() behavior),
// and a newer reader parsing an older record derives the missing enqueuedAt.
const persistedHookTransitionSchema = z.object({
	version: z.literal(OUTBOX_RECORD_VERSION),
	expiresAt: z.number().int().nonnegative(),
	enqueuedAt: z.number().int().nonnegative().optional(),
	abandonedAt: z.number().int().nonnegative().optional(),
	request: runtimeHookIngestRequestSchema,
});

function isLiveReplayCandidate(record: PersistedHookTransition, now: number, minRecordAgeMs: number): boolean {
	if (minRecordAgeMs <= 0 || record.abandonedAt !== undefined) {
		return true;
	}
	// A future enqueue time (clock moved backwards) cannot prove a live writer.
	const ageMs = now - record.enqueuedAt;
	return ageMs < 0 || ageMs >= minRecordAgeMs;
}

async function removeInvalidRecord(path: string, reason: string): Promise<void> {
	outboxLog.warn("discarding invalid hook transition outbox record", { path, reason });
	await rm(path, { force: true });
}

export async function loadPendingHookTransitions(now: number = Date.now()): Promise<PersistedHookTransition[]> {
	let entries: string[];
	try {
		entries = await readdir(getOutboxDirectoryPath());
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return [];
		}
		throw error;
	}

	const records: PersistedHookTransition[] = [];
	for (const entry of entries) {
		const path = join(getOutboxDirectoryPath(), entry);
		if (entry.includes(".tmp.")) {
			try {
				const info = await stat(path);
				if (now - info.mtimeMs > HOOK_TRANSITION_OUTBOX_TTL_MS) {
					await rm(path, { force: true });
				}
			} catch (error) {
				if (!isNodeError(error, "ENOENT")) {
					throw error;
				}
			}
			continue;
		}
		if (!entry.endsWith(".json")) {
			continue;
		}
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) {
				continue;
			}
			throw error;
		}
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw);
		} catch {
			await removeInvalidRecord(path, "invalid JSON");
			continue;
		}
		const parsed = persistedHookTransitionSchema.safeParse(parsedJson);
		if (!parsed.success || !parsed.data.request.delivery) {
			await removeInvalidRecord(path, "schema validation failed");
			continue;
		}
		if (parsed.data.expiresAt <= now) {
			await rm(path, { force: true });
			continue;
		}
		records.push({
			version: parsed.data.version,
			expiresAt: parsed.data.expiresAt,
			enqueuedAt: parsed.data.enqueuedAt ?? parsed.data.expiresAt - HOOK_TRANSITION_OUTBOX_TTL_MS,
			...(parsed.data.abandonedAt !== undefined ? { abandonedAt: parsed.data.abandonedAt } : {}),
			request: {
				...parsed.data.request,
				metadata: normalizeHookTransitionReplayMetadata(parsed.data.request.event, parsed.data.request.metadata),
				delivery: parsed.data.request.delivery,
			},
		});
	}

	return records.sort((left, right) => {
		const occurredAtDifference = left.request.delivery.occurredAt - right.request.delivery.occurredAt;
		return occurredAtDifference !== 0
			? occurredAtDifference
			: left.request.delivery.id.localeCompare(right.request.delivery.id);
	});
}

export interface HookTransitionOutboxReplayer {
	start: () => void;
	/** A complete pass over every pending record, regardless of age (startup replay). */
	replayOnce: () => Promise<void>;
	close: () => Promise<void>;
	getDiagnosticSnapshot: (scope?: Readonly<DiagnosticCaptureScope>) => HookTransitionOutboxDiagnosticSnapshot;
}

export interface HookTransitionReplayPassResult {
	pendingTasks: ReadonlyArray<{ projectId: string; taskId: string }>;
}

export interface HookTransitionOutboxDiagnosticSnapshot {
	running: boolean;
	replayInFlight: boolean;
	lastScanStartedAt: number | null;
	lastScanCompletedAt: number | null;
	lastScanErrorClass: string | null;
	pendingRecords: number | null;
	oldestPendingAgeMs: number | null;
	lastAttempted: number;
	lastAcknowledged: number;
	lastDeferred: number;
}

interface HookTransitionDiagnosticIdentity {
	deliveryId: string;
	projectId: string;
	taskId: string;
	sessionInstanceId: string | null;
	occurredAt: number;
}

interface HookTransitionDiagnosticAttempt extends HookTransitionDiagnosticIdentity {
	outcome: "attempting" | "acknowledged" | "deferred";
}

function diagnosticIdentity(record: PersistedHookTransition): HookTransitionDiagnosticIdentity {
	return {
		deliveryId: record.request.delivery.id,
		projectId: record.request.projectId,
		taskId: record.request.taskId,
		sessionInstanceId: record.request.metadata?.sessionInstanceId ?? null,
		occurredAt: record.request.delivery.occurredAt,
	};
}

function matchesDiagnosticScope(
	identity: HookTransitionDiagnosticIdentity,
	scope: Readonly<DiagnosticCaptureScope>,
): boolean {
	if (scope.projectId && identity.projectId !== scope.projectId) return false;
	if (scope.taskId && identity.taskId !== scope.taskId) return false;
	if (scope.sessionInstanceId && identity.sessionInstanceId !== scope.sessionInstanceId) return false;
	// Outbox deliveries do not have a diagnostic operation id. Do not attribute
	// unrelated aggregate state to an operation-scoped capture.
	if (scope.operationId) return false;
	return true;
}

export function createHookTransitionOutboxReplayer(deps: {
	ingest: (request: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	intervalMs?: number;
	/** Minimum age since enqueue of an unabandoned record for periodic passes started by `start()`. */
	liveReplayMinAgeMs?: number;
	/** Called after every successful scan, including an empty one. */
	onReplayPassCompleted?: (result: HookTransitionReplayPassResult) => void;
}): HookTransitionOutboxReplayer {
	let timer: NodeJS.Timeout | null = null;
	let activeReplay: Promise<void> | null = null;
	let running = false;
	let lastScanStartedAt: number | null = null;
	let lastScanCompletedAt: number | null = null;
	let lastScanErrorClass: string | null = null;
	let lastPendingRecords: HookTransitionDiagnosticIdentity[] | null = null;
	let lastAttempts: HookTransitionDiagnosticAttempt[] = [];

	/**
	 * A periodic pass may join any active pass. A complete pass (`replayOnce`)
	 * must cover every record, so it waits for an active pass and runs its own.
	 */
	const replay = async (minRecordAgeMs: number, options: { joinActive: boolean }): Promise<void> => {
		if (activeReplay && options.joinActive) {
			return await activeReplay;
		}
		while (activeReplay) {
			await activeReplay.catch(() => undefined);
		}
		activeReplay = (async () => {
			const scanStartedAt = Date.now();
			lastScanStartedAt = scanStartedAt;
			lastScanErrorClass = null;
			lastAttempts = [];
			try {
				const records = await loadPendingHookTransitions();
				lastPendingRecords = records.map(diagnosticIdentity);
				for (const record of records) {
					// Records a live writer may still be delivering stay pending for a later pass.
					if (!isLiveReplayCandidate(record, scanStartedAt, minRecordAgeMs)) {
						continue;
					}
					const identity = diagnosticIdentity(record);
					const attempt: HookTransitionDiagnosticAttempt = { ...identity, outcome: "attempting" };
					lastAttempts.push(attempt);
					try {
						const response = await deps.ingest(record.request);
						if (response.ok) {
							await acknowledgeHookTransition(record.request.delivery.id);
							attempt.outcome = "acknowledged";
							lastPendingRecords = lastPendingRecords.filter(
								(candidate) => candidate.deliveryId !== identity.deliveryId,
							);
							outboxLog.info("hook transition replay delivered", {
								deliveryId: record.request.delivery.id,
								projectId: record.request.projectId,
								taskId: record.request.taskId,
							});
						} else {
							attempt.outcome = "deferred";
						}
					} catch (error) {
						attempt.outcome = "deferred";
						outboxLog.debug("hook transition replay deferred", {
							deliveryId: record.request.delivery.id,
							projectId: record.request.projectId,
							taskId: record.request.taskId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				const pendingTasks = Array.from(
					new Map(
						(lastPendingRecords ?? []).map((record) => [
							JSON.stringify([record.projectId, record.taskId]),
							{ projectId: record.projectId, taskId: record.taskId },
						]),
					).values(),
				);
				deps.onReplayPassCompleted?.({ pendingTasks });
			} catch (error) {
				lastScanErrorClass = diagnosticErrorClassOf(error);
				throw error;
			} finally {
				lastScanCompletedAt = Date.now();
			}
		})().finally(() => {
			activeReplay = null;
		});
		await activeReplay;
	};

	return {
		start: () => {
			if (timer) {
				return;
			}
			running = true;
			const liveReplayMinAgeMs = deps.liveReplayMinAgeMs ?? HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS;
			void replay(liveReplayMinAgeMs, { joinActive: true }).catch((error) => {
				outboxLog.warn("initial hook transition replay failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			timer = setInterval(() => {
				void replay(liveReplayMinAgeMs, { joinActive: true }).catch((error) => {
					outboxLog.warn("hook transition replay scan failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}, deps.intervalMs ?? HOOK_TRANSITION_REPLAY_INTERVAL_MS);
			timer.unref();
		},
		replayOnce: async () => await replay(0, { joinActive: false }),
		close: async () => {
			running = false;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			// Drain a complete pass that was waiting behind the active one.
			while (activeReplay) {
				await activeReplay;
			}
		},
		getDiagnosticSnapshot: (scope = {}) => {
			const pending = lastPendingRecords?.filter((record) => matchesDiagnosticScope(record, scope)) ?? null;
			const attempts = lastAttempts.filter((attempt) => matchesDiagnosticScope(attempt, scope));
			return {
				running,
				replayInFlight: activeReplay !== null,
				lastScanStartedAt,
				lastScanCompletedAt,
				lastScanErrorClass,
				pendingRecords: pending?.length ?? null,
				oldestPendingAgeMs:
					pending && pending.length > 0
						? Math.max(0, Date.now() - Math.min(...pending.map((record) => record.occurredAt)))
						: null,
				lastAttempted: attempts.length,
				lastAcknowledged: attempts.filter((attempt) => attempt.outcome === "acknowledged").length,
				lastDeferred: attempts.filter((attempt) => attempt.outcome === "deferred").length,
			};
		},
	};
}
