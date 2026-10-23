import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeHookDelivery, RuntimeHookIngestRequest, RuntimeHookMetadata } from "./core/api/task-session.js";
import { getRuntimeHomePath } from "./core/runtime-state-home.js";
import { isNodeError } from "./fs/node-error.js";

/**
 * Durable, zod-free outbox primitives shared by the hook CLI client
 * (`hooks-runtime-client.ts`, behind both `dist/cli.js` and `dist/hooks.js`) and
 * the server-side replayer (`hook-transition-outbox.ts`).
 * Every type here is used only at the type level (erased at build), so this
 * module pulls in only fs/path/crypto primitives and leaf helpers — no locks,
 * zod, diagnostics, or `./core`/`./fs`/`./state` barrels. The replay
 * scan (schema validation, logging, diagnostics) lives in the sibling
 * `hook-transition-outbox.ts`, which the lightweight hook entry never imports.
 */

const OUTBOX_DIRECTORY_NAME = "hook-transition-outbox";
export const OUTBOX_RECORD_VERSION = 1 as const;
export const HOOK_TRANSITION_OUTBOX_TTL_MS = 10 * 60 * 1000;

export interface PersistedHookTransition {
	version: typeof OUTBOX_RECORD_VERSION;
	expiresAt: number;
	/**
	 * Writer clock at enqueue. Records an older CLI build wrote before this field
	 * existed omit it on disk; the replay loader derives it from
	 * `expiresAt - HOOK_TRANSITION_OUTBOX_TTL_MS` for those.
	 */
	enqueuedAt: number;
	/** Set once the writer stops delivering without an acknowledgement. */
	abandonedAt?: number;
	request: RuntimeHookIngestRequest & { delivery: RuntimeHookDelivery };
}

// Equivalent to zod's `.uuid()` shape check without importing zod into this leaf module.
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function parseDeliveryId(deliveryId: string): string {
	if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
		throw new Error(`Invalid hook transition delivery id: ${deliveryId}`);
	}
	return deliveryId;
}

export function getOutboxDirectoryPath(): string {
	return join(getRuntimeHomePath(), OUTBOX_DIRECTORY_NAME);
}

export function getOutboxRecordPath(deliveryId: string): string {
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
		...(metadata.unboundedBackgroundWorkPending ? { unboundedBackgroundWorkPending: true } : undefined),
		...(metadata.source?.trim().toLowerCase() === "codex" &&
		metadata.hookEventName?.trim().toLowerCase() === "sessionstart"
			? {
					sessionStartSource: metadata.sessionStartSource,
					sessionStartHasTranscript: Boolean(
						metadata.transcriptPath?.trim() || metadata.sessionStartHasTranscript,
					),
				}
			: undefined),
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
		enqueuedAt: now,
		request: {
			...request,
			metadata: minimalReplayMetadata(request.metadata),
			delivery: request.delivery,
		},
	};
}

/** Atomic publication for process-restart recovery, not fsync-backed power-loss durability. */
async function writeRecordAtomic(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
	// Acquire ownership before writing so failures never remove someone else's temp.
	const file = await open(tempPath, "wx", process.platform === "win32" ? undefined : 0o600);
	try {
		try {
			// Creation mode is filtered by umask; normalize before publishing.
			if (process.platform !== "win32") await file.chmod(0o600);
			await file.writeFile(JSON.stringify(record, null, 2), "utf8");
		} catch (error) {
			await file.close().catch(() => undefined);
			throw error;
		}
		// Close before rename, including on Windows.
		await file.close();
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function enqueueHookTransition(request: RuntimeHookIngestRequest): Promise<boolean> {
	const record = createPersistedHookTransition(request);
	if (!record) {
		return false;
	}
	await writeRecordAtomic(getOutboxRecordPath(record.request.delivery.id), record);
	return true;
}

export async function acknowledgeHookTransition(deliveryId: string): Promise<void> {
	await rm(getOutboxRecordPath(deliveryId), { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural check for the record a writer is about to mark abandoned. The
 * replay scan still applies the full schema; this only keeps a writer from
 * rewriting a file that is not its own outbox record.
 */
function isOwnOutboxRecord(value: unknown, deliveryId: string): value is Record<string, unknown> {
	if (!isRecord(value) || value.version !== OUTBOX_RECORD_VERSION || typeof value.expiresAt !== "number") {
		return false;
	}
	const request = value.request;
	return isRecord(request) && isRecord(request.delivery) && request.delivery.id === deliveryId;
}

/**
 * Called by a writer that stops delivering without an acknowledgement, so live
 * replay may adopt the record immediately. A record already removed by replay
 * stays removed. If replay removes it between this read and the atomic rewrite,
 * the restored copy is replayed once more as a duplicate delivery, which the
 * runtime acknowledges without applying it again.
 */
export async function abandonHookTransition(deliveryId: string, now: number = Date.now()): Promise<void> {
	const path = getOutboxRecordPath(deliveryId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	let record: unknown;
	try {
		record = JSON.parse(raw);
	} catch {
		return;
	}
	if (!isOwnOutboxRecord(record, deliveryId)) {
		return;
	}
	await writeRecordAtomic(path, { ...record, abandonedAt: now });
}
