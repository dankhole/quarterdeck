import {
	buildHookIngestRequest,
	type HookCommandMetadataOptionValues,
	parseJsonObject,
	parseMetadataFromBase64,
	parseMetadataFromOptions,
} from "./commands/hook-metadata.js";
import type { RuntimeHookDelivery, RuntimeHookEvent, RuntimeHookMetadata } from "./core/api/task-session.js";
import {
	BEST_EFFORT_HOOK_NOTIFY_POLICY,
	deliverPublishedHook,
	HookPublicationUnavailableError,
	ingestHookRequest,
	type PublishedHook,
	publishReliableHook,
} from "./hook-reliable-delivery.js";
import { parseHookRuntimeContextFromEnv } from "./terminal/hook-runtime-context.js";

export {
	HOOK_INGEST_ATTEMPT_TIMEOUT_MS,
	HOOK_INGEST_RETRY_DELAY_MS,
	HOOK_INGEST_TOTAL_TIMEOUT_MS,
	HOOK_NOTIFY_TIMEOUT_MS,
	withAbortableTimeout,
} from "./hook-reliable-delivery.js";

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
		await ingestHookRequest(parsedArgs, { policy: BEST_EFFORT_HOOK_NOTIFY_POLICY });
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
		let publication: PublishedHook | undefined;
		try {
			publication = await publishReliableHook(request);
		} catch (error) {
			// CLI compatibility: legacy launches without replay identity and local
			// storage failures still attempt online delivery. Never call this durable.
			if (!(error instanceof HookPublicationUnavailableError)) {
				writeHookCliDiagnostic(args, "failed to persist transition for replay", {
					error: formatError(error),
				});
			}
		}
		const onDiagnostic = (message: string, fields: Record<string, string>) =>
			writeHookCliDiagnostic(args, message, fields);
		if (publication) {
			const result = await deliverPublishedHook(publication, { onDiagnostic });
			if (result.status === "deferred") {
				writeHookCliDiagnostic(args, "ingest deferred to durable replay", { error: formatError(result.error) });
				if (result.abandonError) {
					writeHookCliDiagnostic(args, "failed to mark deferred transition for replay", {
						error: formatError(result.abandonError),
					});
				}
			}
		} else {
			await ingestHookRequest(request, { onDiagnostic });
		}
	} catch (error) {
		process.stderr.write(`quarterdeck hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}
