import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const HOOK_COMMAND_ENV = "__QUARTERDECK_OPENCODE_HOOK_COMMAND_ENV__";
const MAX_TEXT_LENGTH = 600;
// Durable `hooks ingest` is `waitForExit`-blocking and can lose a to_review
// transition if it is killed before it durably persists. 30s gives a slow CLI
// under heavy machine load room to finish; non-durable `notify` calls never use
// this timeout and stay fire-and-forget short.
const DURABLE_HOOK_TIMEOUT_MS = 30_000;
// Grace window after the last background subagent finishes, so a root that
// immediately spawns another background task isn't settled out from under it.
const BACKGROUND_WAIT_GRACE_MS = 1_500;
// Safeguard cap so a stuck/abandoned background subagent can never hold a task
// In Progress forever.
const BACKGROUND_WAIT_CAP_MS = 60 * 60_000;

let rootSessionId = null;
let activeRunId = null;
let runSawRootError = null;
let currentAssistantMessageId = null;
let currentAssistantFailed = false;
let currentAssistantOrder = [];
let currentAssistantParts = new Map();
const busyChildSessions = new Set();
const toolInputsByCallId = new Map();
let backgroundWaitActive = false;
let backgroundGraceTimer = null;
let backgroundCapTimer = null;
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

// Never throws and never rejects: callers fire-and-forget this with `void` and
// rely on that invariant instead of attaching rejection handlers.
function emitQuarterdeckHook(event, metadata, options = {}) {
	const commandParts = readHookCommandParts();
	if (commandParts.length === 0) {
		return Promise.resolve();
	}
	const [binary, ...baseArgs] = commandParts;
	const args = [
		...selectHookCommandArgs(baseArgs, options.waitForExit === true),
		"--event",
		event,
		"--source",
		"opencode",
	];
	appendFlag(args, "--activity-text", metadata.activityText);
	appendFlag(args, "--tool-name", metadata.toolName);
	appendFlag(args, "--tool-input-summary", metadata.toolInputSummary);
	appendFlag(args, "--final-message", metadata.finalMessage);
	appendFlag(args, "--hook-event-name", metadata.hookEventName);
	appendFlag(args, "--notification-type", metadata.notificationType);
	const turnId = Object.prototype.hasOwnProperty.call(metadata, "turnId") ? metadata.turnId : activeRunId;
	appendFlag(args, "--turn-id", turnId);
	appendFlag(args, "--tool-use-id", metadata.toolUseId);
	const sessionId = Object.prototype.hasOwnProperty.call(metadata, "sessionId") ? metadata.sessionId : rootSessionId;
	appendFlag(args, "--session-id", sessionId);
	appendFlag(args, "--provider-agent-id", metadata.providerAgentId);

	return spawnHookCommand(binary, args, options.waitForExit === true);
}

function enqueueDurableHook(event, metadata) {
	// Durable emissions may wait behind an earlier hook while opencode has
	// already started another queued run. Freeze launch/run identity at enqueue
	// time so an older event can never inherit the next run's activeRunId.
	const queuedMetadata = {
		...metadata,
		turnId: Object.prototype.hasOwnProperty.call(metadata, "turnId") ? metadata.turnId : activeRunId,
		sessionId: Object.prototype.hasOwnProperty.call(metadata, "sessionId") ? metadata.sessionId : rootSessionId,
	};
	durableHookQueue = durableHookQueue.then(
		() => emitQuarterdeckHook(event, queuedMetadata, { waitForExit: true }),
		() => emitQuarterdeckHook(event, queuedMetadata, { waitForExit: true }),
	);
	return durableHookQueue;
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

function resetAssistantTracking() {
	currentAssistantMessageId = null;
	currentAssistantFailed = false;
	currentAssistantOrder = [];
	currentAssistantParts = new Map();
}

function joinAssistantText() {
	if (currentAssistantOrder.length === 0) {
		return null;
	}
	const text = currentAssistantOrder.map((partId) => currentAssistantParts.get(partId) ?? "").join("");
	return truncate(text);
}

function clearGraceTimer() {
	if (backgroundGraceTimer) {
		clearTimeout(backgroundGraceTimer);
		backgroundGraceTimer = null;
	}
}

function clearCapTimer() {
	if (backgroundCapTimer) {
		clearTimeout(backgroundCapTimer);
		backgroundCapTimer = null;
	}
}

function clearBackgroundWaitTimers() {
	clearGraceTimer();
	clearCapTimer();
}

function resetRunState() {
	activeRunId = null;
	runSawRootError = null;
	resetAssistantTracking();
	busyChildSessions.clear();
	backgroundWaitActive = false;
	clearBackgroundWaitTimers();
}

function handleSessionInfoEvent(info) {
	if (!info || typeof info !== "object") {
		return;
	}
	if (info.parentID) {
		// Child session: never establishes or changes root identity.
		return;
	}
	const id = normalizeText(info.id);
	if (!id || id === rootSessionId) {
		return;
	}
	rootSessionId = id;
	resetRunState();
	void enqueueDurableHook("activity", { hookEventName: "session_meta" });
}

function startNewRun() {
	activeRunId = randomUUID();
	runSawRootError = null;
	resetAssistantTracking();
	void enqueueDurableHook("to_in_progress", { hookEventName: "AgentStart", activityText: "opencode is working" });
}

function endBackgroundWaitBookkeeping() {
	backgroundWaitActive = false;
	clearBackgroundWaitTimers();
}

function beginOrRefreshBackgroundWait() {
	if (backgroundWaitActive) {
		return;
	}
	backgroundWaitActive = true;
	void emitQuarterdeckHook("activity", {
		hookEventName: "BackgroundWait",
		activityText: "Waiting for background subagents",
	});
	const runIdAtWaitStart = activeRunId;
	backgroundCapTimer = setTimeout(() => {
		backgroundCapTimer = null;
		if (activeRunId === runIdAtWaitStart) {
			settleRun();
		}
	}, BACKGROUND_WAIT_CAP_MS);
}

function scheduleGraceSettle() {
	clearGraceTimer();
	const runIdAtScheduling = activeRunId;
	backgroundGraceTimer = setTimeout(() => {
		backgroundGraceTimer = null;
		if (activeRunId === runIdAtScheduling && backgroundWaitActive && busyChildSessions.size === 0) {
			settleRun();
		}
	}, BACKGROUND_WAIT_GRACE_MS);
}

function settleRun() {
	const settledRunId = activeRunId;
	const errorInfo = runSawRootError;
	const aborted = errorInfo?.name === "MessageAbortedError";
	const failed = Boolean(errorInfo) && !aborted;
	const finalMessage = aborted || failed || currentAssistantFailed ? null : joinAssistantText();
	endBackgroundWaitBookkeeping();
	void enqueueDurableHook("to_review", {
		hookEventName: aborted ? "Interrupt" : failed ? "StopFailure" : "AgentSettled",
		activityText: aborted
			? "opencode interrupted"
			: failed
				? "opencode failed"
				: finalMessage
					? "Final: " + finalMessage
					: "Waiting for review",
		finalMessage,
		turnId: settledRunId,
	}).finally(() => {
		if (activeRunId === settledRunId) {
			activeRunId = null;
			runSawRootError = null;
			resetAssistantTracking();
			busyChildSessions.clear();
		}
	});
}

function handleRootStatus(status) {
	const type = status?.type;
	if (type === "busy") {
		if (activeRunId === null) {
			startNewRun();
		} else if (backgroundWaitActive) {
			// Root resumed work before the grace/cap settle fired; drop the wait
			// bookkeeping without settling. A later idle re-evaluates children.
			endBackgroundWaitBookkeeping();
		}
		return;
	}
	if (type === "retry" && activeRunId !== null) {
		void emitQuarterdeckHook("activity", { hookEventName: "Retry", activityText: "opencode retrying" });
	}
	// The dedicated session.idle event, not session.status's idle variant, is
	// the canonical settlement trigger (see handleRootIdle).
}

function handleRootIdle() {
	if (activeRunId === null) {
		// Ignored; may still end a stale BackgroundWait defensively.
		endBackgroundWaitBookkeeping();
		return;
	}
	if (runSawRootError !== null) {
		// Interrupt/failure settle immediately regardless of background children.
		settleRun();
		return;
	}
	if (busyChildSessions.size > 0) {
		beginOrRefreshBackgroundWait();
		return;
	}
	settleRun();
}

function handleChildStatus(sessionID, status) {
	if (status?.type !== "busy") {
		return;
	}
	if (!busyChildSessions.has(sessionID)) {
		busyChildSessions.add(sessionID);
		void emitQuarterdeckHook("activity", {
			hookEventName: "SubagentStart",
			activityText: "Subagent working",
			providerAgentId: sessionID,
		});
	}
}

function handleChildSettled(sessionID) {
	if (!busyChildSessions.has(sessionID)) {
		return;
	}
	busyChildSessions.delete(sessionID);
	void enqueueDurableHook("activity", {
		hookEventName: "SubagentStop",
		activityText: "Subagent finished",
		providerAgentId: sessionID,
	});
	if (backgroundWaitActive && busyChildSessions.size === 0) {
		scheduleGraceSettle();
	}
}

function isChildSession(sessionID) {
	return typeof sessionID === "string" && sessionID.length > 0 && sessionID !== rootSessionId;
}

function handleEvent(event) {
	if (!event || typeof event.type !== "string") {
		return;
	}
	const properties = event.properties ?? {};
	switch (event.type) {
		case "session.created":
		case "session.updated": {
			handleSessionInfoEvent(properties.info);
			break;
		}
		case "session.status": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			if (sessionID === rootSessionId) {
				handleRootStatus(properties.status);
			} else if (isChildSession(sessionID)) {
				handleChildStatus(sessionID, properties.status);
			}
			break;
		}
		case "session.idle": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			if (sessionID === rootSessionId) {
				handleRootIdle();
			} else if (isChildSession(sessionID)) {
				handleChildSettled(sessionID);
			}
			break;
		}
		case "session.error": {
			const sessionID = normalizeText(properties.sessionID);
			if (sessionID && sessionID === rootSessionId) {
				runSawRootError = properties.error ?? { name: "UnknownError" };
			} else if (sessionID && isChildSession(sessionID)) {
				// A child's eventual session.idle retires its wait; no separate signal needed.
			}
			break;
		}
		case "message.updated": {
			const info = properties.info;
			if (!info || info.role !== "assistant") break;
			const sessionID = normalizeText(info.sessionID);
			if (!sessionID || sessionID !== rootSessionId) break;
			if (info.id !== currentAssistantMessageId) {
				currentAssistantMessageId = info.id;
				currentAssistantOrder = [];
				currentAssistantParts = new Map();
			}
			currentAssistantFailed = Boolean(info.error);
			break;
		}
		case "message.part.updated": {
			const part = properties.part;
			if (!part || part.type !== "text") break;
			const sessionID = normalizeText(part.sessionID);
			if (!sessionID || sessionID !== rootSessionId) break;
			if (part.messageID !== currentAssistantMessageId) {
				if (currentAssistantMessageId !== null) break;
				currentAssistantMessageId = part.messageID;
				currentAssistantOrder = [];
				currentAssistantParts = new Map();
			}
			if (!currentAssistantParts.has(part.id)) {
				currentAssistantOrder.push(part.id);
			}
			currentAssistantParts.set(part.id, typeof part.text === "string" ? part.text : "");
			break;
		}
		case "permission.updated": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			void enqueueDurableHook("to_review", {
				hookEventName: "PermissionRequest",
				activityText: "Needs permission: " + (normalizeText(properties.title) ?? normalizeText(properties.type) ?? ""),
				toolName: properties.type,
				toolUseId: properties.callID,
				notificationType: "permission_prompt",
				providerAgentId: isChildSession(sessionID) ? sessionID : undefined,
			});
			break;
		}
		case "permission.replied": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			const providerAgentId = isChildSession(sessionID) ? sessionID : undefined;
			if (properties.response === "reject") {
				void emitQuarterdeckHook("activity", {
					hookEventName: "PermissionRejected",
					activityText: "Permission rejected",
					providerAgentId,
				});
			} else {
				void enqueueDurableHook("to_in_progress", {
					hookEventName: "PermissionReplied",
					activityText: "Permission granted",
					providerAgentId,
				});
			}
			break;
		}
		case "question.asked": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			void enqueueDurableHook("to_review", {
				hookEventName: "QuestionAsked",
				activityText: "Question asked",
				toolUseId: properties.id,
				notificationType: "question",
				providerAgentId: isChildSession(sessionID) ? sessionID : undefined,
			});
			break;
		}
		case "question.replied": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			void enqueueDurableHook("to_in_progress", {
				hookEventName: "QuestionReplied",
				activityText: "Question answered",
				providerAgentId: isChildSession(sessionID) ? sessionID : undefined,
			});
			break;
		}
		case "question.rejected": {
			const sessionID = normalizeText(properties.sessionID);
			if (!sessionID) break;
			void emitQuarterdeckHook("activity", {
				hookEventName: "QuestionRejected",
				activityText: "Question dismissed",
				providerAgentId: isChildSession(sessionID) ? sessionID : undefined,
			});
			break;
		}
		default:
			break;
	}
}

async function quarterdeckOpencodeLifecyclePluginServer() {
	return {
		dispose: async () => {
			clearBackgroundWaitTimers();
		},
		event: async (input) => {
			try {
				handleEvent(input?.event);
			} catch {
				// Hooks must never throw or they can alter opencode's own behavior.
			}
		},
		// Deliberately does not implement `permission.ask`: classification only
		// reads the `permission.updated`/`permission.replied` events above, so
		// there is nothing here that could leave `output.status` touched.
		"tool.execute.before": async (input, output) => {
			try {
				const sessionID = normalizeText(input?.sessionID);
				if (!sessionID || sessionID !== rootSessionId) {
					return;
				}
				const callId = normalizeText(input?.callID);
				const toolInput = output?.args ?? null;
				if (callId && toolInput && typeof toolInput === "object") {
					toolInputsByCallId.set(callId, toolInput);
				}
				void emitQuarterdeckHook("activity", {
					hookEventName: "ToolExecutionStart",
					activityText: formatToolActivity("Using", input.tool, toolInput),
					toolName: input.tool,
					toolInputSummary: summarizeToolInput(input.tool, toolInput),
					toolUseId: callId,
				});
			} catch {
				// Never throw out of a hook.
			}
		},
		"tool.execute.after": async (input, output) => {
			try {
				const sessionID = normalizeText(input?.sessionID);
				if (!sessionID || sessionID !== rootSessionId) {
					return;
				}
				const callId = normalizeText(input?.callID);
				const toolInput = input?.args ?? (callId ? toolInputsByCallId.get(callId) ?? null : null);
				const failed = Boolean(output?.metadata?.error);
				void emitQuarterdeckHook("activity", {
					hookEventName: failed ? "ToolExecutionFailure" : "ToolExecutionEnd",
					activityText: formatToolActivity(failed ? "Failed" : "Completed", input.tool, toolInput),
					toolName: input.tool,
					toolInputSummary: summarizeToolInput(input.tool, toolInput),
					toolUseId: callId,
				});
				if (callId) {
					toolInputsByCallId.delete(callId);
				}
			} catch {
				// Never throw out of a hook.
			}
		},
	};
}

export default {
	id: "quarterdeck-lifecycle",
	server: quarterdeckOpencodeLifecyclePluginServer,
};
