import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import {
	createTaggedLogger,
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
		toolUseId: metadata.toolUseId ?? null,
		hookEventName: metadata.hookEventName ?? null,
		toolName: metadata.toolName ?? null,
		notificationType: metadata.notificationType ?? null,
	};
}

export function createPersistedHookTransition(
	request: RuntimeHookIngestRequest,
	now: number = Date.now(),
): PersistedHookTransition | null {
	// Replay only when the runtime can prove both process and turn ownership.
	// Other hook sources retain bounded direct retry without unsafe replay.
	if (
		request.event === "activity" ||
		request.metadata?.source?.trim().toLowerCase() !== "codex" ||
		!request.delivery ||
		!request.metadata.sessionInstanceId ||
		!request.metadata.turnId
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
}

export function createHookTransitionOutboxReplayer(deps: {
	ingest: (request: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	intervalMs?: number;
}): HookTransitionOutboxReplayer {
	let timer: NodeJS.Timeout | null = null;
	let activeReplay: Promise<void> | null = null;

	const replayOnce = async (): Promise<void> => {
		if (activeReplay) {
			return await activeReplay;
		}
		activeReplay = (async () => {
			const records = await loadPendingHookTransitions();
			for (const record of records) {
				try {
					const response = await deps.ingest(record.request);
					if (response.ok) {
						await acknowledgeHookTransition(record.request.delivery.id);
					}
				} catch (error) {
					outboxLog.debug("hook transition replay deferred", {
						deliveryId: record.request.delivery.id,
						projectId: record.request.projectId,
						taskId: record.request.taskId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
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
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (activeReplay) {
				await activeReplay;
			}
		},
	};
}
