import {
	buildHookIngestRequest,
	type HookCommandMetadataOptionValues,
	parseJsonObject,
	parseMetadataFromBase64,
	parseMetadataFromOptions,
} from "./commands/hook-metadata.js";
import type {
	RuntimeHookDelivery,
	RuntimeHookEvent,
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
import { parseHookRuntimeContextFromEnv } from "./terminal/hook-runtime-context.js";

/**
 * Shared hook-ingest implementation for both `quarterdeck hooks ingest|notify`
 * (bundled into `dist/cli.js` via `commands/hooks.ts`) and the standalone
 * lightweight entry (`dist/hooks.js`, built from `hook-entry.ts`). Deliberately
 * narrow: no commander, no `@trpc/client`, no `./core`/`./terminal` barrel
 * imports. Talks to the runtime with a bounded `node:http` POST that matches the
 * exact non-batched tRPC HTTP RPC wire format `createHTTPHandler` accepts for
 * `POST /api/trpc/hooks.ingest` (see `src/trpc/app-router.ts` and
 * `src/server/runtime-client-access.ts`, which exempts exactly that path):
 * the request body is the raw procedure input (no batch envelope, no
 * transformer wrapping, since `app-router-init.ts` installs no transformer),
 * and the response is `{ result: { data } }` or `{ error: { message, ... } }`.
 */

const VALID_EVENTS = new Set<RuntimeHookEvent>(["to_review", "to_in_progress", "activity"]);

export function parseHookEvent(value: string): RuntimeHookEvent {
	if (!VALID_EVENTS.has(value as RuntimeHookEvent)) {
		throw new Error(`Invalid event "${value}". Must be one of: ${[...VALID_EVENTS].join(", ")}`);
	}
	return value as RuntimeHookEvent;
}

export interface HooksIngestArgs {
	event: RuntimeHookEvent;
	taskId: string;
	projectId: string;
	metadata?: RuntimeHookMetadata;
	delivery?: RuntimeHookDelivery;
	payload?: Record<string, unknown> | null;
}

function formatDiagnosticValue(value: string | null | undefined, maxLength = 80): string {
	if (!value) {
		return "-";
	}
	const compact = value.replace(/\s+/g, " ").trim();
	const truncated = compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
	return JSON.stringify(truncated);
}

function formatHookDiagnosticFields(
	args: HooksIngestArgs,
	extra: Record<string, string | null | undefined> = {},
): string {
	const metadata = args.metadata;
	const fields: Record<string, string | null | undefined> = {
		event: args.event,
		project: args.projectId,
		task: args.taskId,
		source: metadata?.source ?? null,
		session: metadata?.sessionId ?? null,
		instance: metadata?.sessionInstanceId ?? null,
		turn: metadata?.turnId ?? null,
		prompt: metadata?.promptId ?? null,
		delivery: args.delivery?.id ?? null,
		hookEvent: metadata?.hookEventName ?? null,
		tool: metadata?.toolName ?? null,
		notifType: metadata?.notificationType ?? null,
		activity: metadata?.activityText ?? null,
		...extra,
	};
	return Object.entries(fields)
		.map(([key, value]) => `${key}=${formatDiagnosticValue(value)}`)
		.join(" ");
}

function writeHookCliDiagnostic(
	args: HooksIngestArgs,
	message: string,
	extra: Record<string, string | null | undefined> = {},
): void {
	process.stderr.write(`[hooks:cli] ${message} ${formatHookDiagnosticFields(args, extra)}\n`);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function withAbortableTimeout<T>(
	taskFactory: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	// A hook timeout must cancel the underlying HTTP request, not just race it.
	// Otherwise the hook subprocess can stay alive and block Codex cancellation.
	const abortController = new AbortController();
	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
	const taskPromise = Promise.resolve().then(() => taskFactory(abortController.signal));
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			abortController.abort(timeoutError);
			reject(timeoutError);
		}, timeoutMs);
	});
	try {
		return await Promise.race([taskPromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
		void taskPromise.catch(() => {});
	}
}

function parseHooksIngestArgs(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
	stdinPayload: string,
): HooksIngestArgs {
	const context = parseHookRuntimeContextFromEnv();
	const flagMetadata = parseMetadataFromOptions(options);
	const payloadFromBase64 = parseMetadataFromBase64(options.metadataBase64);
	const payloadFromStdin = parseJsonObject(stdinPayload.trim());
	const payloadFromArg = payloadArg ? parseJsonObject(payloadArg) : null;
	const payload = payloadFromBase64 ?? payloadFromStdin ?? payloadFromArg;
	return {
		...buildHookIngestRequest({ event, identity: context, flagMetadata, payload }),
		payload,
	};
}

// Both reliable attempts share one deadline. The runtime keeps applying an
// attempt the client aborted, and a retry of the same delivery only waits for
// that state to become durable, so the first attempt gets most of the budget
// rather than being cut short and raced by its own retry.
export const HOOK_INGEST_TOTAL_TIMEOUT_MS = 3_250;
export const HOOK_INGEST_ATTEMPT_TIMEOUT_MS = 2_250;
export const HOOK_INGEST_RETRY_DELAY_MS = 250;
export const HOOK_NOTIFY_TIMEOUT_MS = 250;

type HookIngestPolicy =
	| { timeoutMs: number; retry: false }
	| { timeoutMs: number; retry: true; retryDelayMs: number; totalTimeoutMs: number };

const RELIABLE_HOOK_INGEST_POLICY: HookIngestPolicy = {
	timeoutMs: HOOK_INGEST_ATTEMPT_TIMEOUT_MS,
	retry: true,
	retryDelayMs: HOOK_INGEST_RETRY_DELAY_MS,
	totalTimeoutMs: HOOK_INGEST_TOTAL_TIMEOUT_MS,
};

const BEST_EFFORT_HOOK_NOTIFY_POLICY: HookIngestPolicy = {
	timeoutMs: HOOK_NOTIFY_TIMEOUT_MS,
	retry: false,
};

interface TrpcErrorEnvelope {
	error: { message?: string };
}

interface TrpcResultEnvelope {
	result: { data: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTrpcErrorEnvelope(value: unknown): value is TrpcErrorEnvelope {
	return isRecord(value) && isRecord(value.error);
}

function isTrpcResultEnvelope(value: unknown): value is TrpcResultEnvelope {
	return isRecord(value) && isRecord(value.result) && "data" in value.result;
}

function isHookIngestResponse(value: unknown): value is RuntimeHookIngestResponse {
	return (
		isRecord(value) && typeof value.ok === "boolean" && (value.error === undefined || typeof value.error === "string")
	);
}

async function postHookIngest(
	request: {
		taskId: string;
		projectId: string;
		event: RuntimeHookEvent;
		metadata?: RuntimeHookMetadata;
		delivery?: RuntimeHookDelivery;
	},
	signal: AbortSignal,
): Promise<RuntimeHookIngestResponse> {
	const response = await postHookRuntimeJson(
		buildQuarterdeckRuntimeUrl("/api/trpc/hooks.ingest"),
		JSON.stringify(request),
		signal,
	);
	let payload: unknown;
	try {
		payload = JSON.parse(response.body);
	} catch {
		throw new Error(`Hook ingest returned a non-JSON response (status ${response.status}).`);
	}
	if (isTrpcErrorEnvelope(payload)) {
		throw new Error(payload.error.message || "Hook ingest failed");
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Hook ingest returned an unsuccessful response (status ${response.status}).`);
	}
	if (!isTrpcResultEnvelope(payload) || !isHookIngestResponse(payload.result.data)) {
		throw new Error(`Unexpected hook ingest response shape (status ${response.status}).`);
	}
	return payload.result.data;
}

async function ingestHookEvent(
	args: HooksIngestArgs,
	policy: HookIngestPolicy = RELIABLE_HOOK_INGEST_POLICY,
): Promise<void> {
	const attempt = async (timeoutMs: number): Promise<void> => {
		const ingestResponse = await withAbortableTimeout(
			(signal) =>
				postHookIngest(
					{
						taskId: args.taskId,
						projectId: args.projectId,
						event: args.event,
						metadata: args.metadata,
						delivery: args.delivery,
					},
					signal,
				),
			timeoutMs,
			"quarterdeck hooks ingest",
		);
		if (ingestResponse.ok === false) {
			throw new Error(ingestResponse.error ?? "Hook ingest failed");
		}
	};

	const startedAt = Date.now();
	try {
		await attempt(policy.timeoutMs);
	} catch (firstError) {
		if (!policy.retry) {
			throw firstError;
		}
		// Single retry after a short delay. State-transition hooks (to_review,
		// to_in_progress) are the only reliable channel — a lost hook means a
		// stuck task with no automatic recovery.
		writeHookCliDiagnostic(args, "ingest attempt failed; retrying", {
			error: formatError(firstError),
		});
		await new Promise((resolve) => setTimeout(resolve, policy.retryDelayMs));
		try {
			const retryTimeoutMs = policy.totalTimeoutMs - (Date.now() - startedAt);
			if (retryTimeoutMs <= 0) {
				throw new Error(`quarterdeck hooks ingest exhausted its ${policy.totalTimeoutMs}ms budget`);
			}
			await attempt(retryTimeoutMs);
		} catch (retryError) {
			writeHookCliDiagnostic(args, "ingest retry failed", {
				error: formatError(retryError),
				firstError: formatError(firstError),
			});
			// Re-throw the original error so callers see the first failure.
			throw firstError;
		}
	}
}

async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

export async function runHooksNotify(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	try {
		const stdinPayload = await readStdinText();
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		await ingestHookEvent(parsedArgs, BEST_EFFORT_HOOK_NOTIFY_POLICY);
	} catch {
		// Best effort only. Detached notify stdio is "ignore" so stderr writes
		// here would be dropped anyway — server-side hooks-api logging covers
		// anything that reaches the runtime.
	}
}

export async function runHooksIngest(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	try {
		const stdinPayload = await readStdinText();
		const args = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		const request = {
			taskId: args.taskId,
			projectId: args.projectId,
			event: args.event,
			metadata: args.metadata,
			delivery: args.delivery,
		};
		let queuedForReplay = false;
		try {
			queuedForReplay = await enqueueHookTransition(request);
		} catch (error) {
			writeHookCliDiagnostic(args, "failed to persist transition for replay", {
				error: formatError(error),
			});
		}
		try {
			await ingestHookEvent(args);
			if (queuedForReplay && args.delivery) {
				await acknowledgeHookTransition(args.delivery.id);
			}
		} catch (error) {
			if (!queuedForReplay || !args.delivery) {
				throw error;
			}
			writeHookCliDiagnostic(args, "ingest deferred to durable replay", {
				error: formatError(error),
				delivery: args.delivery.id,
			});
			// Hand the record to live replay now instead of after its writer-age bound.
			try {
				await abandonHookTransition(args.delivery.id);
			} catch (abandonError) {
				writeHookCliDiagnostic(args, "failed to mark deferred transition for replay", {
					error: formatError(abandonError),
				});
			}
		}
	} catch (error) {
		process.stderr.write(`quarterdeck hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}
