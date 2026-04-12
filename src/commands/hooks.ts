import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core/api-contract";
import { buildQuarterdeckCommandParts } from "../core/quarterdeck-command";
import { buildQuarterdeckRuntimeUrl } from "../core/runtime-endpoint";
import { buildWindowsCmdArgsArray, resolveWindowsComSpec, shouldUseWindowsCmdLaunch } from "../core/windows-cmd-launch";
import { parseHookRuntimeContextFromEnv } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { extractLastAssistantMessage } from "./claude-transcript-parser";
import {
	type CodexMappedHookEvent,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./codex-hook-events";

export {
	createCodexWatcherState,
	parseCodexEventLine,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./codex-hook-events";

const VALID_EVENTS = new Set<RuntimeHookEvent>(["to_review", "to_in_progress", "activity"]);

interface HooksIngestArgs {
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	metadata?: Partial<RuntimeTaskHookActivity>;
	payload?: Record<string, unknown> | null;
}

interface HookCommandMetadataOptionValues {
	source?: string;
	activityText?: string;
	toolName?: string;
	finalMessage?: string;
	hookEventName?: string;
	notificationType?: string;
	metadataBase64?: string;
}

interface CodexWrapperArgs {
	realBinary: string;
	agentArgs: string[];
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

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const normalized = normalizeWhitespace(value);
	return normalized.length > 0 ? normalized : null;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
	let current: unknown = record;
	for (const key of path) {
		const candidate = asRecord(current);
		if (!candidate || !(key in candidate)) {
			return null;
		}
		current = candidate[key];
	}
	if (typeof current !== "string") {
		return null;
	}
	const normalized = normalizeWhitespace(current);
	return normalized.length > 0 ? normalized : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function parseMetadataFromOptions(options: HookCommandMetadataOptionValues): Partial<RuntimeTaskHookActivity> {
	const metadata: Partial<RuntimeTaskHookActivity> = {};
	const activityText = options.activityText;
	const toolName = options.toolName;
	const finalMessage = options.finalMessage;
	const hookEventName = options.hookEventName;
	const notificationType = options.notificationType;
	const source = options.source;

	if (activityText) {
		metadata.activityText = normalizeWhitespace(activityText);
	}
	if (toolName) {
		metadata.toolName = normalizeWhitespace(toolName);
	}
	if (finalMessage) {
		metadata.finalMessage = normalizeWhitespace(finalMessage);
	}
	if (hookEventName) {
		metadata.hookEventName = normalizeWhitespace(hookEventName);
	}
	if (notificationType) {
		metadata.notificationType = normalizeWhitespace(notificationType);
	}
	if (source) {
		metadata.source = normalizeWhitespace(source);
	}

	return metadata;
}

function parseMetadataFromBase64(encoded: string | undefined): Record<string, unknown> | null {
	if (!encoded) {
		return null;
	}
	try {
		return asRecord(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	} catch {
		return null;
	}
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
	const direct = asRecord(payload.tool_input);
	if (direct) {
		return direct;
	}
	const directCamel = asRecord(payload.toolInput);
	if (directCamel) {
		return directCamel;
	}
	const preTool = asRecord(payload.preToolUse);
	const preParams = preTool ? asRecord(preTool.parameters) : null;
	if (preParams) {
		return preParams;
	}
	const preInput = preTool ? asRecord(preTool.input) : null;
	if (preInput) {
		return preInput;
	}
	const postTool = asRecord(payload.postToolUse);
	const postParams = postTool ? asRecord(postTool.parameters) : null;
	if (postParams) {
		return postParams;
	}
	const postInput = postTool ? asRecord(postTool.input) : null;
	if (postInput) {
		return postInput;
	}
	const output = asRecord(payload.output);
	const outputArgs = output ? asRecord(output.args) : null;
	return outputArgs;
}

function describeToolOperation(toolName: string | null, toolInput: Record<string, unknown> | null): string | null {
	if (!toolName || !toolInput) {
		return null;
	}

	const command =
		readStringField(toolInput, "command") ??
		readStringField(toolInput, "cmd") ??
		readStringField(toolInput, "query") ??
		readStringField(toolInput, "description");
	if (command) {
		return `${toolName}: ${command}`;
	}

	const filePath =
		readStringField(toolInput, "file_path") ??
		readStringField(toolInput, "filePath") ??
		readStringField(toolInput, "path");
	if (filePath) {
		return `${toolName}: ${filePath}`;
	}

	return toolName;
}

function inferActivityText(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	toolName: string | null,
	finalMessage: string | null,
	notificationType: string | null,
): string | null {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const normalizedHookEvent = hookEventName?.toLowerCase() ?? "";
	const codexType = payload ? readStringField(payload, "type") : null;
	const normalizedCodexType = codexType?.toLowerCase() ?? "";
	const toolInput = payload ? extractToolInput(payload) : null;
	const toolOperation = describeToolOperation(toolName, toolInput);

	if (normalizedCodexType === "task_started") {
		return "Working on task";
	}
	if (normalizedCodexType === "exec_command_begin") {
		return "Running command";
	}
	if (normalizedCodexType.endsWith("_approval_request")) {
		return "Waiting for approval";
	}

	if (normalizedHookEvent === "pretooluse" || normalizedHookEvent === "beforetool") {
		return toolOperation ? `Using ${toolOperation}` : "Using tool";
	}
	if (normalizedHookEvent === "posttooluse" || normalizedHookEvent === "aftertool") {
		return toolOperation ? `Completed ${toolOperation}` : "Completed tool";
	}
	if (normalizedHookEvent === "posttoolusefailure") {
		const error = payload ? readStringField(payload, "error") : null;
		if (toolOperation && error) {
			return `Failed ${toolOperation}: ${error}`;
		}
		if (toolOperation) {
			return `Failed ${toolOperation}`;
		}
		return error ? `Tool failed: ${error}` : "Tool failed";
	}
	if (normalizedHookEvent === "permissionrequest") {
		return "Waiting for approval";
	}
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (
		normalizedHookEvent === "stop" ||
		normalizedHookEvent === "subagentstop" ||
		normalizedHookEvent === "afteragent"
	) {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
	}
	if (notificationType === "user_attention") {
		return null;
	}

	if (event === "to_review") {
		return null;
	}
	if (event === "to_in_progress") {
		return "Agent active";
	}
	return null;
}

export function inferHookSourceFromPayload(payload: Record<string, unknown> | null): string | null {
	const transcriptPath = payload
		? (readStringField(payload, "transcript_path") ?? readStringField(payload, "transcriptPath"))
		: null;
	const normalizedTranscriptPath = transcriptPath?.replaceAll("\\", "/").toLowerCase() ?? null;
	if (normalizedTranscriptPath?.includes("/.claude/")) {
		return "claude";
	}
	if (payload && readStringField(payload, "type") === "agent-turn-complete") {
		return "codex";
	}
	return null;
}

function normalizeHookMetadata(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	flagMetadata: Partial<RuntimeTaskHookActivity>,
): Partial<RuntimeTaskHookActivity> | undefined {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const toolName = payload
		? (readStringField(payload, "tool_name") ??
			readStringField(payload, "toolName") ??
			readNestedString(payload, ["preToolUse", "tool"]) ??
			readNestedString(payload, ["preToolUse", "toolName"]) ??
			readNestedString(payload, ["postToolUse", "tool"]) ??
			readNestedString(payload, ["postToolUse", "toolName"]) ??
			readNestedString(payload, ["input", "tool"]) ??
			readNestedString(payload, ["input", "toolName"]))
		: null;
	const notificationType = payload
		? (readStringField(payload, "notification_type") ??
			readStringField(payload, "notificationType") ??
			readNestedString(payload, ["event", "type"]) ??
			readNestedString(payload, ["notification", "event"]))
		: null;
	const finalMessage = payload
		? (readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "lastAssistantMessage") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"]))
		: null;

	const inferredSource = inferHookSourceFromPayload(payload);

	const activityText = inferActivityText(event, payload, toolName, finalMessage, notificationType);
	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? inferredSource ?? null,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage: flagMetadata.finalMessage ?? (finalMessage ? normalizeWhitespace(finalMessage) : null),
		activityText: flagMetadata.activityText ?? (activityText ? normalizeWhitespace(activityText) : null),
	};

	const hasValue = Object.values(merged).some((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasValue) {
		return undefined;
	}

	return merged;
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

function spawnDetachedQuarterdeck(args: string[]): void {
	try {
		const commandParts = buildQuarterdeckCommandParts(args);
		const child = spawn(commandParts[0], commandParts.slice(1), {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
	} catch {
		// Best effort: hook notification failures should never block agents.
	}
}

function appendMetadataFlags(args: string[], metadata?: Partial<RuntimeTaskHookActivity>): string[] {
	if (!metadata) {
		return args;
	}
	if (metadata.source) {
		args.push("--source", metadata.source);
	}
	if (metadata.activityText) {
		args.push("--activity-text", metadata.activityText);
	}
	if (metadata.toolName) {
		args.push("--tool-name", metadata.toolName);
	}
	if (metadata.finalMessage) {
		args.push("--final-message", metadata.finalMessage);
	}
	if (metadata.hookEventName) {
		args.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata.notificationType) {
		args.push("--notification-type", metadata.notificationType);
	}
	return args;
}

function notifyCodexSessionWatcherEvent(mapped: CodexMappedHookEvent): void {
	spawnDetachedQuarterdeck(appendMetadataFlags(["hooks", "notify", "--event", mapped.event], mapped.metadata));
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
		? (readStringField(args.payload, "transcript_path") ?? readStringField(args.payload, "transcriptPath"))
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

export function buildCodexWrapperChildArgs(agentArgs: string[]): string[] {
	const childArgs = [...agentArgs];
	const hasNotifyOverride = childArgs.some((arg, index) => {
		if (arg === "-c" || arg === "--config") {
			const next = childArgs[index + 1];
			return typeof next === "string" && next.startsWith("notify=");
		}
		return arg.startsWith("-cnotify=") || arg.startsWith("--config=notify=");
	});
	if (hasNotifyOverride) {
		return childArgs;
	}
	// Session log formats can change across Codex versions. Always wire legacy notify
	// so task completion still transitions to review when watcher parsing misses events.
	const reviewNotifyCommandParts = buildQuarterdeckCommandParts([
		"hooks",
		"notify",
		"--event",
		"to_review",
		"--source",
		"codex",
	]);
	const notifyConfig = `notify=${JSON.stringify(reviewNotifyCommandParts)}`;
	childArgs.unshift(notifyConfig);
	childArgs.unshift("-c");
	return childArgs;
}

export function buildCodexWrapperSpawn(
	realBinary: string,
	agentArgs: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
	const childArgs = buildCodexWrapperChildArgs(agentArgs);
	if (!shouldUseWindowsCmdLaunch(realBinary, platform, env)) {
		return {
			binary: realBinary,
			args: childArgs,
		};
	}
	return {
		binary: resolveWindowsComSpec(env),
		args: buildWindowsCmdArgsArray(realBinary, childArgs),
	};
}

async function runCodexWrapperSubcommand(wrapperArgs: CodexWrapperArgs): Promise<void> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	let shuttingDown = false;
	let stopWatcher: () => Promise<void> = async () => {};
	let watcherStartPromise: Promise<void> | null = null;

	let shouldWatchSessionLog = false;
	try {
		parseHookRuntimeContextFromEnv(childEnv);
		shouldWatchSessionLog = true;
	} catch {
		shouldWatchSessionLog = false;
	}

	if (shouldWatchSessionLog) {
		childEnv.CODEX_TUI_RECORD_SESSION = "1";
		if (!childEnv.CODEX_TUI_SESSION_LOG_PATH) {
			childEnv.CODEX_TUI_SESSION_LOG_PATH = join(
				tmpdir(),
				`quarterdeck-codex-session-${process.pid}_${Date.now()}.jsonl`,
			);
		}
		const sessionLogPath = childEnv.CODEX_TUI_SESSION_LOG_PATH;
		if (sessionLogPath) {
			watcherStartPromise = (async () => {
				const startedStopWatcher = await startCodexSessionWatcher(
					sessionLogPath,
					notifyCodexSessionWatcherEvent,
					undefined,
					{
						cwd: process.cwd(),
					},
				);
				if (shuttingDown) {
					await startedStopWatcher();
					return;
				}
				stopWatcher = startedStopWatcher;
			})().catch(() => {
				// Best effort only.
			});
		}
	}

	const childLaunch = buildCodexWrapperSpawn(wrapperArgs.realBinary, wrapperArgs.agentArgs);
	const child = spawn(childLaunch.binary, childLaunch.args, {
		stdio: "inherit",
		env: childEnv,
	});

	const forwardSignal = (signal: NodeJS.Signals) => {
		if (!child.killed) {
			child.kill(signal);
		}
	};

	const onSigint = () => {
		forwardSignal("SIGINT");
	};
	const onSigterm = () => {
		forwardSignal("SIGTERM");
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const WRAPPER_CLEANUP_TIMEOUT_MS = 3000;
	const cleanup = async () => {
		shuttingDown = true;
		const cleanupWork = (async () => {
			await watcherStartPromise;
			await stopWatcher();
		})();
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, WRAPPER_CLEANUP_TIMEOUT_MS));
		await Promise.race([cleanupWork, timeout]);
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};

	await new Promise<void>((resolve) => {
		let finished = false;
		const finish = (exitCode: number) => {
			if (finished) {
				return;
			}
			finished = true;
			void (async () => {
				await cleanup();
				process.exitCode = exitCode;
				resolve();
			})();
		};

		child.on("error", () => {
			finish(1);
		});
		child.on("exit", (code) => {
			finish(code ?? 1);
		});
	});
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
