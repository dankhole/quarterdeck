import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import {
	createTaggedLogger,
	type DiagnosticCaptureScope,
	normalizeDiagnosticErrorClass,
	type RuntimeHookDelivery,
	type RuntimeHookIngestRequest,
	type RuntimeHookIngestResponse,
	type RuntimeHookMetadata,
	runtimeHookIngestRequestSchema,
} from "./core";
import { isNodeError, lockedFileSystem } from "./fs";
import { getRuntimeHomePath } from "./state/project-state-utils";

const outboxLog = createTaggedLogger("hook-outbox");
const OUTBOX_DIRECTORY_NAME = "hook-transition-outbox";
const OUTBOX_RECORD_VERSION = 1;

export const HOOK_TRANSITION_OUTBOX_TTL_MS = 10 * 60 * 1000;
export const HOOK_TRANSITION_REPLAY_INTERVAL_MS = 2_000;

export interface PersistedHookTransition {
	version: typeof OUTBOX_RECORD_VERSION;
	expiresAt: number;
	request: RuntimeHookIngestRequest & { delivery: RuntimeHookDelivery };
}

const persistedHookTransitionSchema = z.object({
	version: z.literal(OUTBOX_RECORD_VERSION),
	expiresAt: z.number().int().nonnegative(),
	request: runtimeHookIngestRequestSchema,
});

function getOutboxDirectoryPath(): string {
	return join(getRuntimeHomePath(), OUTBOX_DIRECTORY_NAME);
}

function parseDeliveryId(deliveryId: string): string {
	return z.string().uuid().parse(deliveryId);
}

function getOutboxRecordPath(deliveryId: string): string {
	return join(getOutboxDirectoryPath(), `${parseDeliveryId(deliveryId)}.json`);
}

function minimalReplayMetadata(metadata: RuntimeHookMetadata | undefined): RuntimeHookMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	return {
		source: metadata.source ?? null,
		sessionId: metadata.sessionId ?? null,
		sessionInstanceId: metadata.sessionInstanceId ?? null,
		turnId: metadata.turnId ?? null,
		promptId: metadata.promptId ?? null,
		toolUseId: metadata.toolUseId ?? null,
		elicitationId: metadata.elicitationId ?? null,
		providerAgentId: metadata.providerAgentId ?? null,
		hookEventName: metadata.hookEventName ?? null,
		toolName: metadata.toolName ?? null,
		notificationType: metadata.notificationType ?? null,
	};
}

export function createPersistedHookTransition(
	request: RuntimeHookIngestRequest,
	now: number = Date.now(),
): PersistedHookTransition | null {
	// Reliable hook commands call this before delivery. Codex requires both
	// process and turn identity; Claude and Pi use prompt/tool/run identities
	// instead of requiring a Codex-style turn id on every event, so launch
	// identity is the mandatory replay fence and the provider-specific order
	// tracker handles the remaining correlation.
	const source = request.metadata?.source?.trim().toLowerCase();
	const hookEventName = request.metadata?.hookEventName?.trim().toLowerCase();
	const isCodexSessionStart = source === "codex" && request.event === "activity" && hookEventName === "sessionstart";
	const hasCodexReplayIdentity =
		source === "codex" &&
		((request.event !== "activity" && Boolean(request.metadata?.turnId)) || isCodexSessionStart);
	const hasClaudeReplayIdentity = source === "claude";
	const hasPiReplayIdentity = source === "pi";
	if (
		!request.delivery ||
		!request.metadata?.sessionInstanceId ||
		(!hasCodexReplayIdentity && !hasClaudeReplayIdentity && !hasPiReplayIdentity)
	) {
		return null;
	}
	return {
		version: OUTBOX_RECORD_VERSION,
		expiresAt: now + HOOK_TRANSITION_OUTBOX_TTL_MS,
		request: {
			...request,
			metadata: minimalReplayMetadata(request.metadata),
			delivery: request.delivery,
		},
	};
}

export async function enqueueHookTransition(request: RuntimeHookIngestRequest): Promise<boolean> {
	const record = createPersistedHookTransition(request);
	if (!record) {
		return false;
	}
	await lockedFileSystem.writeJsonFileAtomic(getOutboxRecordPath(record.request.delivery.id), record, {
		mode: 0o600,
		lock: null,
	});
	return true;
}

export async function acknowledgeHookTransition(deliveryId: string): Promise<void> {
	await rm(getOutboxRecordPath(deliveryId), { force: true });
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
			request: {
				...parsed.data.request,
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

	const replayOnce = async (): Promise<void> => {
		if (activeReplay) {
			return await activeReplay;
		}
		activeReplay = (async () => {
			lastScanStartedAt = Date.now();
			lastScanErrorClass = null;
			lastAttempts = [];
			try {
				const records = await loadPendingHookTransitions();
				lastPendingRecords = records.map(diagnosticIdentity);
				for (const record of records) {
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
				lastScanErrorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
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
			void replayOnce().catch((error) => {
				outboxLog.warn("initial hook transition replay failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			timer = setInterval(() => {
				void replayOnce().catch((error) => {
					outboxLog.warn("hook transition replay scan failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}, deps.intervalMs ?? HOOK_TRANSITION_REPLAY_INTERVAL_MS);
			timer.unref();
		},
		replayOnce,
		close: async () => {
			running = false;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (activeReplay) {
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
