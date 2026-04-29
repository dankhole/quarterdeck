export const QUARTERDECK_PI_HOOK_COMMAND_ENV = "QUARTERDECK_PI_HOOK_COMMAND_JSON";

export function buildPiLifecycleExtensionSource(): string {
	return String.raw`import { spawn } from "node:child_process";

const HOOK_COMMAND_ENV = "${QUARTERDECK_PI_HOOK_COMMAND_ENV}";
const MAX_TEXT_LENGTH = 600;
const DURABLE_HOOK_TIMEOUT_MS = 8_000;
const PERMISSION_TOOL_NAMES = new Set(["bash"]);
const toolInputsById = new Map();
let durableHookQueue = Promise.resolve();

function normalizeText(value) {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

function truncate(value, maxLength = MAX_TEXT_LENGTH) {
	const normalized = normalizeText(value);
	if (!normalized) {
		return null;
	}
	return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
}

function readHookCommandParts() {
	const encoded = process.env[HOOK_COMMAND_ENV];
	if (!encoded) {
		return [];
	}
	try {
		const parsed = JSON.parse(encoded);
		return Array.isArray(parsed) ? parsed.filter((part) => typeof part === "string" && part.length > 0) : [];
	} catch {
		return [];
	}
}

function getSessionId(ctx) {
	try {
		return normalizeText(ctx.sessionManager.getSessionId());
	} catch {
		return null;
	}
}

function appendFlag(args, flag, value) {
	const normalized = truncate(value);
	if (normalized) {
		args.push(flag, normalized);
	}
}

function selectHookCommandArgs(baseArgs, waitForExit) {
	if (!waitForExit) {
		return baseArgs;
	}
	const durableArgs = [...baseArgs];
	if (durableArgs[durableArgs.length - 1] === "notify") {
		durableArgs[durableArgs.length - 1] = "ingest";
	}
	return durableArgs;
}

function spawnHookCommand(binary, args, waitForExit) {
	return new Promise((resolve) => {
		let settled = false;
		let timeout = null;
		function finish() {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			resolve();
		}

		try {
			const child = spawn(binary, args, {
				detached: !waitForExit,
				env: process.env,
				stdio: "ignore",
				windowsHide: true,
			});
			child.on("error", finish);
			if (waitForExit) {
				child.on("exit", finish);
				child.on("close", finish);
				timeout = setTimeout(() => {
					try {
						child.kill("SIGTERM");
					} catch {
						// Best effort.
					}
					finish();
				}, DURABLE_HOOK_TIMEOUT_MS);
				return;
			}
			child.unref();
			finish();
		} catch {
			finish();
		}
	});
}

function emitQuarterdeckHook(event, metadata, ctx, options = {}) {
	const commandParts = readHookCommandParts();
	if (commandParts.length === 0) {
		return Promise.resolve();
	}
	const [binary, ...baseArgs] = commandParts;
	const args = [...selectHookCommandArgs(baseArgs, options.waitForExit === true), "--event", event, "--source", "pi"];
	appendFlag(args, "--activity-text", metadata.activityText);
	appendFlag(args, "--tool-name", metadata.toolName);
	appendFlag(args, "--tool-input-summary", metadata.toolInputSummary);
	appendFlag(args, "--final-message", metadata.finalMessage);
	appendFlag(args, "--hook-event-name", metadata.hookEventName);
	appendFlag(args, "--notification-type", metadata.notificationType);
	appendFlag(args, "--session-id", metadata.sessionId ?? getSessionId(ctx));

	return spawnHookCommand(binary, args, options.waitForExit === true);
}

function enqueueDurableHook(event, metadata, ctx) {
	durableHookQueue = durableHookQueue.then(
		() => emitQuarterdeckHook(event, metadata, ctx, { waitForExit: true }),
		() => emitQuarterdeckHook(event, metadata, ctx, { waitForExit: true }),
	);
	return durableHookQueue;
}

function getToolCallId(event) {
	return (
		normalizeText(event?.toolCallId) ??
		normalizeText(event?.tool_call_id) ??
		normalizeText(event?.callId) ??
		normalizeText(event?.id) ??
		normalizeText(event?.toolExecutionId) ??
		normalizeText(event?.executionId) ??
		(event?.toolName ? "tool:" + event.toolName : null)
	);
}

function rememberToolInput(event) {
	const input = event?.args ?? event?.input ?? null;
	const key = getToolCallId(event);
	if (key && input && typeof input === "object") {
		toolInputsById.set(key, input);
	}
	return input;
}

function resolveToolInput(event) {
	const direct = event?.args ?? event?.input ?? null;
	if (direct) {
		return direct;
	}
	const key = getToolCallId(event);
	return key ? (toolInputsById.get(key) ?? null) : null;
}

function forgetToolInput(event) {
	const key = getToolCallId(event);
	if (key) {
		toolInputsById.delete(key);
	}
}

function readToolInputValue(input, keys) {
	if (!input || typeof input !== "object") {
		return null;
	}
	for (const key of keys) {
		const value = normalizeText(input[key]);
		if (value) {
			return value;
		}
	}
	return null;
}

function summarizeToolInput(toolName, input) {
	const named =
		readToolInputValue(input, ["command", "cmd", "query", "pattern", "description"]) ??
		readToolInputValue(input, ["file_path", "filePath", "path"]);
	if (named) {
		return truncate(named);
	}
	if (!input || typeof input !== "object") {
		return null;
	}
	try {
		return truncate(JSON.stringify(input), 240);
	} catch {
		return normalizeText(toolName);
	}
}

function formatToolActivity(prefix, toolName, input) {
	const summary = summarizeToolInput(toolName, input);
	return summary ? prefix + " " + toolName + ": " + summary : prefix + " " + toolName;
}

function textFromContent(content) {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.join("");
}

function lastAssistantText(messages) {
	if (!Array.isArray(messages)) {
		return null;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const text = truncate(textFromContent(message.content));
		if (text) {
			return text;
		}
	}
	return null;
}

async function confirmPermission(ctx, question) {
	if (!ctx.hasUI) {
		return false;
	}
	try {
		return await ctx.ui.confirm("Pi Permission", question);
	} catch {
		return false;
	}
}

export default function quarterdeckLifecycle(pi) {
	pi.on("session_start", (_event, ctx) => {
		void enqueueDurableHook(
			"activity",
			{
				hookEventName: "session_meta",
				sessionId: getSessionId(ctx),
			},
			ctx,
		);
	});

	pi.on("input", (_event, ctx) => {
		void enqueueDurableHook(
			"to_in_progress",
			{
				hookEventName: "Input",
				activityText: "Pi received input",
			},
			ctx,
		);
	});

	pi.on("agent_start", (_event, ctx) => {
		void enqueueDurableHook(
			"to_in_progress",
			{
				hookEventName: "AgentStart",
				activityText: "Pi is working",
			},
			ctx,
		);
	});

	pi.on("agent_end", (event, ctx) => {
		const finalMessage = lastAssistantText(event.messages);
		void enqueueDurableHook(
			"to_review",
			{
				hookEventName: "AgentEnd",
				activityText: finalMessage ? "Final: " + finalMessage : "Waiting for review",
				finalMessage,
			},
			ctx,
		);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const toolInput = rememberToolInput(event);
		const toolInputSummary = summarizeToolInput(event.toolName, toolInput);
		void emitQuarterdeckHook(
			"activity",
			{
				hookEventName: "ToolExecutionStart",
				activityText: formatToolActivity("Using", event.toolName, toolInput),
				toolName: event.toolName,
				toolInputSummary,
			},
			ctx,
		);
	});

	pi.on("tool_execution_update", (event, _ctx) => {
		rememberToolInput(event);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const toolInput = resolveToolInput(event);
		const toolInputSummary = summarizeToolInput(event.toolName, toolInput);
		void emitQuarterdeckHook(
			"activity",
			{
				hookEventName: event.isError ? "ToolExecutionFailure" : "ToolExecutionEnd",
				activityText: formatToolActivity(event.isError ? "Failed" : "Completed", event.toolName, toolInput),
				toolName: event.toolName,
				toolInputSummary,
			},
			ctx,
		);
		forgetToolInput(event);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!PERMISSION_TOOL_NAMES.has(event.toolName)) {
			return;
		}

		const toolInputSummary = summarizeToolInput(event.toolName, event.input);
		await enqueueDurableHook(
			"to_review",
			{
				hookEventName: "PermissionRequest",
				notificationType: "permission_prompt",
				activityText: "Waiting for approval",
				toolName: event.toolName,
				toolInputSummary,
			},
			ctx,
		);

		const question = toolInputSummary ? "Allow bash command?\n\n" + toolInputSummary : "Allow bash command?";
		const confirmed = await confirmPermission(ctx, question);
		if (!confirmed) {
			await enqueueDurableHook(
				"to_in_progress",
				{
					hookEventName: "PermissionDenied",
					activityText: "Denied bash command",
					toolName: event.toolName,
					toolInputSummary,
				},
				ctx,
			);
			return { block: true, reason: "Blocked by user" };
		}

		await enqueueDurableHook(
			"to_in_progress",
			{
				hookEventName: "PermissionResolved",
				activityText: "Approved bash command",
				toolName: event.toolName,
				toolInputSummary,
			},
			ctx,
		);
	});
}
`;
}
