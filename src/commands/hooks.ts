import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core";
import { buildQuarterdeckRuntimeUrl } from "../core";
import { parseHookRuntimeContextFromEnv } from "../terminal";
import type { RuntimeAppRouter } from "../trpc";
import { extractLastAssistantMessage } from "./claude-transcript-parser";
import { resolveCodexRolloutFinalMessageForCwd } from "./codex-hook-events";
import { runCodexWrapperSubcommand } from "./codex-wrapper";
import {
	type HookCommandMetadataOptionValues,
	normalizeHookMetadata,
	parseJsonObject,
	parseMetadataFromBase64,
	parseMetadataFromOptions,
	readPayloadStringField,
} from "./hook-metadata";

export {
	createCodexWatcherState,
	parseCodexEventLine,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./codex-hook-events";
export { buildCodexWrapperChildArgs, buildCodexWrapperSpawn } from "./codex-wrapper";
// Re-exports for backward compatibility (tests and other consumers).
export { inferHookSourceFromPayload } from "./hook-metadata";

const VALID_EVENTS = new Set<RuntimeHookEvent>(["to_review", "to_in_progress", "activity"]);

interface HooksIngestArgs {
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	metadata?: Partial<RuntimeTaskHookActivity>;
	payload?: Record<string, unknown> | null;
}

function formatError(error: unknown): string {
	if (error instanceof TRPCClientError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function parseHookEvent(value: string): RuntimeHookEvent {
	if (!VALID_EVENTS.has(value as RuntimeHookEvent)) {
		throw new Error(`Invalid event "${value}". Must be one of: ${[...VALID_EVENTS].join(", ")}`);
	}
	return value as RuntimeHookEvent;
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
	const metadata = normalizeHookMetadata(event, payload, flagMetadata);
	return {
		event,
		taskId: context.taskId,
		workspaceId: context.workspaceId,
		metadata,
		payload,
	};
}

const HOOK_INGEST_TIMEOUT_MS = 3000;
const HOOK_INGEST_RETRY_DELAY_MS = 1000;

async function ingestHookEvent(args: HooksIngestArgs): Promise<void> {
	const trpcClient = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildQuarterdeckRuntimeUrl("/api/trpc"),
				maxItems: 1,
			}),
		],
	});

	const attempt = async (): Promise<void> => {
		const ingestResponse = await withTimeout(
			trpcClient.hooks.ingest.mutate({
				taskId: args.taskId,
				workspaceId: args.workspaceId,
				event: args.event,
				metadata: args.metadata,
			}),
			HOOK_INGEST_TIMEOUT_MS,
			"quarterdeck hooks ingest",
		);
		if (ingestResponse.ok === false) {
			throw new Error(ingestResponse.error ?? "Hook ingest failed");
		}
	};

	try {
		await attempt();
	} catch (firstError) {
		// Single retry after a short delay. State-transition hooks (to_review,
		// to_in_progress) are the only reliable channel — a lost hook means a
		// stuck task with no automatic recovery.
		await new Promise((resolve) => setTimeout(resolve, HOOK_INGEST_RETRY_DELAY_MS));
		try {
			await attempt();
		} catch {
			// Re-throw the original error so callers see the first failure.
			throw firstError;
		}
	}
}

async function enrichCodexReviewMetadata(args: HooksIngestArgs, cwd: string): Promise<HooksIngestArgs> {
	if (args.event !== "to_review") {
		return args;
	}
	const metadata = args.metadata ?? {};
	const source = metadata.source?.toLowerCase();
	if (source !== "codex") {
		return args;
	}
	const existingFinalMessage =
		typeof metadata.finalMessage === "string" && metadata.finalMessage.trim().length > 0
			? metadata.finalMessage
			: null;
	if (existingFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? `Final: ${existingFinalMessage}`,
			},
		};
	}

	const fallbackFinalMessage = await resolveCodexRolloutFinalMessageForCwd(cwd);
	if (!fallbackFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? "Waiting for review",
			},
		};
	}

	return {
		...args,
		metadata: {
			...metadata,
			finalMessage: fallbackFinalMessage,
			activityText: metadata.activityText ?? `Final: ${fallbackFinalMessage}`,
		},
	};
}

/**
 * Enrich Claude Stop hook metadata with a conversation summary extracted from
 * the transcript JSONL file.
 *
 * Follows the same pattern as enrichCodexReviewMetadata - reads agent-specific
 * files on the CLI side before the tRPC call to the server.
 */
async function enrichClaudeStopMetadata(args: HooksIngestArgs): Promise<HooksIngestArgs> {
	if (args.event !== "to_review") {
		return args;
	}
	const metadata = args.metadata ?? {};
	const source = metadata.source?.toLowerCase();
	if (source !== "claude") {
		return args;
	}

	// Extract transcript_path from payload (check both key variants).
	const transcriptPath = args.payload
		? (readPayloadStringField(args.payload, "transcript_path") ??
			readPayloadStringField(args.payload, "transcriptPath"))
		: null;
	if (!transcriptPath) {
		return args;
	}

	const extractedText = await extractLastAssistantMessage(transcriptPath);
	if (!extractedText) {
		return args;
	}

	// finalMessage and activityText are set alongside conversationSummaryText for backward
	// compatibility — legacy consumers and the activity feed read these fields rather than
	// conversationSummaryText, so the redundancy is deliberate.
	return {
		...args,
		metadata: {
			...metadata,
			conversationSummaryText: extractedText,
			finalMessage: metadata.finalMessage ?? extractedText,
			activityText: metadata.activityText ?? `Final: ${extractedText}`,
		},
	};
}

async function runHooksNotify(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	try {
		const stdinPayload = await readStdinText();
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		const args = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		await ingestHookEvent(args);
	} catch {
		// Best effort only.
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

async function runHooksIngest(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let args: HooksIngestArgs;
	try {
		const stdinPayload = await readStdinText();
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		const codexEnriched = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		try {
			args = await enrichClaudeStopMetadata(codexEnriched);
		} catch {
			// If enrichment crashes, fall back to unenriched args so the hook is still ingested.
			args = codexEnriched;
		}
	} catch (error) {
		process.stderr.write(`quarterdeck hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	// Diagnostic stderr logging — always emitted so it shows in the agent's PTY
	// output. Enable debug logging in the UI to see the matching server-side logs.
	const meta = args.metadata;
	process.stderr.write(
		`[hooks:cli] event=${args.event} hookEvent=${meta?.hookEventName ?? "-"} tool=${meta?.toolName ?? "-"} notifType=${meta?.notificationType ?? "-"} activity=${meta?.activityText?.slice(0, 60) ?? "-"}\n`,
	);

	try {
		await ingestHookEvent(args);
	} catch (error) {
		process.stderr.write(`quarterdeck hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerHooksCommand(program: Command): void {
	const hooks = program.command("hooks").description("Runtime hook helpers for agent integrations.");

	hooks
		.command("ingest [payload]")
		.description("Ingest hook event into Quarterdeck runtime.")
		.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent)
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksIngest(options.event, options, payload);
			},
		);

	hooks
		.command("notify [payload]")
		.description("Best-effort hook ingest that never throws.")
		.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent)
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksNotify(options.event, options, payload);
			},
		);

	hooks
		.command("codex-wrapper [agentArgs...]")
		.description("Codex wrapper that emits Quarterdeck hook notifications.")
		.requiredOption("--real-binary <path>", "Path to the actual codex binary.")
		.allowUnknownOption(true)
		.action(async (agentArgs: string[] | undefined, options: { realBinary: string }) => {
			await runCodexWrapperSubcommand({
				realBinary: options.realBinary,
				agentArgs: agentArgs ?? [],
			});
		});
}
