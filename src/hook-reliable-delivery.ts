import type {
	RuntimeHookDelivery,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeHookMetadata,
} from "./core/api/task-session.js";
import { buildQuarterdeckRuntimeUrl } from "./core/runtime-endpoint.js";
import {
	abandonHookTransition,
	acknowledgeHookTransition,
	enqueueHookTransition,
} from "./hook-transition-outbox-core.js";
import { postHookRuntimeJson } from "./hooks-runtime-http.js";

// One deadline covers both attempts; the runtime can still be applying an
// aborted attempt when its same-ID retry arrives.
export const HOOK_INGEST_TOTAL_TIMEOUT_MS = 3_250;
export const HOOK_INGEST_ATTEMPT_TIMEOUT_MS = 2_250;
export const HOOK_INGEST_RETRY_DELAY_MS = 250;
export const HOOK_NOTIFY_TIMEOUT_MS = 250;
// Native Codex Interrupt allows only 3s including process startup/publication.
export const CODEX_INTERRUPT_TOTAL_TIMEOUT_MS = 2_400;
export const CODEX_INTERRUPT_ATTEMPT_TIMEOUT_MS = 1_500;

export type HookIngestPolicy =
	| { timeoutMs: number; retry: false }
	| { timeoutMs: number; retry: true; retryDelayMs: number; totalTimeoutMs: number };

export const BEST_EFFORT_HOOK_NOTIFY_POLICY: HookIngestPolicy = {
	timeoutMs: HOOK_NOTIFY_TIMEOUT_MS,
	retry: false,
};

function reliablePolicy(request: RuntimeHookIngestRequest): HookIngestPolicy {
	const isCodexInterrupt =
		request.metadata?.source?.trim().toLowerCase() === "codex" &&
		request.metadata.hookEventName?.trim().toLowerCase() === "interrupt";
	return {
		timeoutMs: isCodexInterrupt ? CODEX_INTERRUPT_ATTEMPT_TIMEOUT_MS : HOOK_INGEST_ATTEMPT_TIMEOUT_MS,
		retry: true,
		retryDelayMs: HOOK_INGEST_RETRY_DELAY_MS,
		totalTimeoutMs: isCodexInterrupt ? CODEX_INTERRUPT_TOTAL_TIMEOUT_MS : HOOK_INGEST_TOTAL_TIMEOUT_MS,
	};
}

export interface HookDeliveryOptions {
	signal?: AbortSignal;
	/** Opt-in, content-free progress only; detailed failures are returned, never logged. */
	onDiagnostic?: (message: string, fields: Record<string, string>) => void;
}

export async function withAbortableTimeout<T>(
	taskFactory: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const controller = new AbortController();
	let timeoutHandle: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const cancellation = new Promise<never>((_, reject) => {
		const fail = (error: unknown) => {
			controller.abort(error);
			reject(error);
		};
		onAbort = () => fail(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(() => fail(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	const task = Promise.resolve().then(() => {
		controller.signal.throwIfAborted();
		return taskFactory(controller.signal);
	});
	try {
		return await Promise.race([task, cancellation]);
	} finally {
		clearTimeout(timeoutHandle);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		void task.catch(() => {});
	}
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHookIngestResponse(value: unknown): value is RuntimeHookIngestResponse {
	return (
		isRecord(value) && typeof value.ok === "boolean" && (value.error === undefined || typeof value.error === "string")
	);
}

async function postHookIngest(
	request: RuntimeHookIngestRequest,
	signal: AbortSignal,
): Promise<RuntimeHookIngestResponse> {
	const response = await postHookRuntimeJson(
		buildQuarterdeckRuntimeUrl("/api/trpc/hooks.ingest"),
		JSON.stringify({
			taskId: request.taskId,
			projectId: request.projectId,
			event: request.event,
			metadata: request.metadata,
			delivery: request.delivery,
		}),
		signal,
	);
	let payload: unknown;
	try {
		payload = JSON.parse(response.body);
	} catch {
		throw new Error(`Hook ingest returned a non-JSON response (status ${response.status}).`);
	}
	if (isRecord(payload) && isRecord(payload.error)) {
		throw new Error(typeof payload.error.message === "string" ? payload.error.message : "Hook ingest failed");
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Hook ingest returned an unsuccessful response (status ${response.status}).`);
	}
	if (!isRecord(payload) || !isRecord(payload.result) || !isHookIngestResponse(payload.result.data)) {
		throw new Error(`Unexpected hook ingest response shape (status ${response.status}).`);
	}
	return payload.result.data;
}

/** Network mechanism only: callers explicitly own publication and queue policy. */
export async function ingestHookRequest(
	request: RuntimeHookIngestRequest,
	options: HookDeliveryOptions & { policy?: HookIngestPolicy } = {},
): Promise<void> {
	const { signal, onDiagnostic } = options;
	const policy = options.policy ?? reliablePolicy(request);
	const attempt = async (timeoutMs: number): Promise<void> => {
		const result = await withAbortableTimeout(
			(attemptSignal) => postHookIngest(request, attemptSignal),
			timeoutMs,
			"quarterdeck hooks ingest",
			signal,
		);
		if (!result.ok) throw new Error(result.error ?? "Hook ingest failed");
	};
	const startedAt = Date.now();
	try {
		await attempt(policy.timeoutMs);
	} catch (firstError) {
		if (!policy.retry || signal?.aborted) throw firstError;
		onDiagnostic?.("ingest attempt failed; retrying", { error: "delivery_attempt_failed" });
		try {
			await waitForRetry(policy.retryDelayMs, signal);
			const remainingMs = policy.totalTimeoutMs - (Date.now() - startedAt);
			if (remainingMs <= 0) {
				throw new Error(`quarterdeck hooks ingest exhausted its ${policy.totalTimeoutMs}ms budget`);
			}
			await attempt(remainingMs);
		} catch {
			onDiagnostic?.("ingest retry failed", { error: "delivery_retry_failed" });
			throw firstError;
		}
	}
}

export class HookPublicationUnavailableError extends Error {}

const publishedHook = Symbol("publishedHook");
export interface PublishedHook {
	readonly [publishedHook]: true;
	readonly request: Readonly<RuntimeHookIngestRequest> & {
		readonly metadata?: Readonly<RuntimeHookMetadata>;
		readonly delivery: Readonly<RuntimeHookDelivery>;
	};
}

/**
 * Resolves only after atomic local publication (restart recovery, not fsync).
 * UUID/time belong to event capture, never queue execution or retry. Snapshot
 * before the first await so caller mutation cannot change this event's identity.
 */
export async function publishReliableHook(request: RuntimeHookIngestRequest): Promise<PublishedHook> {
	if (!request.delivery) {
		throw new HookPublicationUnavailableError("Reliable hook publication requires captured delivery identity.");
	}
	if (!Number.isSafeInteger(request.delivery.occurredAt) || request.delivery.occurredAt < 0) {
		throw new Error("Reliable hook publication requires a valid captured occurrence time.");
	}
	const snapshot = Object.freeze({
		taskId: request.taskId,
		projectId: request.projectId,
		event: request.event,
		metadata: request.metadata ? Object.freeze({ ...request.metadata }) : undefined,
		delivery: Object.freeze({ ...request.delivery }),
	});
	if (!(await enqueueHookTransition(snapshot))) {
		throw new HookPublicationUnavailableError(
			"Reliable hook publication requires replayable provider and launch identity.",
		);
	}
	return Object.freeze({ [publishedHook]: true as const, request: snapshot });
}

/** Retain unstarted queue entries for replay; never send or delete them. */
export async function abandonPublishedHook(publication: PublishedHook): Promise<void> {
	await abandonHookTransition(publication.request.delivery.id);
}

export type PublishedHookDeliveryResult =
	| { status: "acknowledged" }
	| { status: "deferred"; error: unknown; abandonError?: unknown };

/** Abort stops network work, not the already-published recovery copy. */
export async function deliverPublishedHook(
	publication: PublishedHook,
	options: HookDeliveryOptions = {},
): Promise<PublishedHookDeliveryResult> {
	try {
		await ingestHookRequest(publication.request, options);
		await acknowledgeHookTransition(publication.request.delivery.id);
		return { status: "acknowledged" };
	} catch (error) {
		try {
			await abandonPublishedHook(publication);
			return { status: "deferred", error };
		} catch (abandonError) {
			return { status: "deferred", error, abandonError };
		}
	}
}
