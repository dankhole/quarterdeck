import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import http from "node:http";
import { isAbsolute } from "node:path";

const HOOK_COMMAND_ENV = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";
// Published only while the runtime's loopback hook HTTP channel is active;
// when present, best-effort activity hooks POST here in-process instead of
// spawning `hooks notify` (see `emitQuarterdeckHook`). Durable hooks always
// keep the CLI command above, regardless of this env var.
const HOOK_HTTP_URL_ENV = "__QUARTERDECK_PI_HOOK_HTTP_URL_ENV__";
const WORKTREE_TRUST_SCOPE_ENV = "__QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV__";
// Identity/credential env names and header names below must stay byte-for-byte
// in sync with `hook-http-channel.ts` (`QUARTERDECK_HOOK_HTTP_TOKEN_ENV`,
// `HOOK_HTTP_*_HEADER`) and `hook-runtime-context.ts` (`QUARTERDECK_HOOK_*_ENV`);
// this plain-JS asset cannot import those TS modules, so a test asserts equality.
const HOOK_HTTP_TOKEN_ENV = "QUARTERDECK_HOOK_HTTP_TOKEN";
const HOOK_HTTP_TASK_ID_ENV = "QUARTERDECK_HOOK_TASK_ID";
const HOOK_HTTP_PROJECT_ID_ENV = "QUARTERDECK_HOOK_PROJECT_ID";
const HOOK_HTTP_SESSION_INSTANCE_ID_ENV = "QUARTERDECK_HOOK_SESSION_INSTANCE_ID";
const HOOK_HTTP_TOKEN_HEADER = "x-quarterdeck-hook-token";
const HOOK_HTTP_TASK_ID_HEADER = "x-quarterdeck-hook-task-id";
const HOOK_HTTP_PROJECT_ID_HEADER = "x-quarterdeck-hook-project-id";
const HOOK_HTTP_SESSION_INSTANCE_ID_HEADER = "x-quarterdeck-hook-session-instance-id";
// Best-effort delivery only; matches the endpoint's activity-only query contract.
const HOOK_HTTP_EVENT = "activity";
const HOOK_HTTP_SOURCE = "pi";
// Short fire-and-forget budget, like Claude's `type: "http"` hooks; never
// retried and never falls back to spawning on failure (best-effort).
const HOOK_HTTP_TIMEOUT_MS = 1_000;
const MAX_TEXT_LENGTH = 600;
// Durable `hooks ingest` is `waitForExit`-blocking and can lose a to_review
// transition if it is killed before it durably persists. 30s gives a slow CLI
// under heavy machine load room to finish; non-durable `notify` calls never use
// this timeout (see `selectHookCommandArgs`/`spawnHookCommand`'s `waitForExit`
// branch) and stay fire-and-forget short.
const DURABLE_HOOK_TIMEOUT_MS = 30_000;
// pi-subagents (third-party, optional) announces background worker lifecycle
// on Pi's shared cross-extension bus `pi.events`. Pi core has no background
// work API of its own, so this is the only signal that a settled turn still
// has async subagent work in flight.
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
// After the last tracked background run completes while Pi is idle, wait
// this long for pi-subagents' wake turn (a fresh agent_start) before emitting
// the deferred Review, so a finished worker that immediately re-prompts the
// agent doesn't cause a Review -> Running flicker. pi-subagents batches its
// own completion delivery (up to ~1s) and compaction can further delay the
// wake turn, so this is intentionally looser than that batching window.
const BACKGROUND_WAKE_GRACE_MS = 3_000;
// Safety cap measured from the most recent background start/complete event
// (busy-idle grace retries do not extend it), so it also bounds a deferred
// Review waiting on a wake turn that never arrives. If background work never reports completion (e.g. a
// worker is killed without pi-subagents observing it, or Pi never reports
// idle), forget all tracked runs and flush any deferred Review so the task
// is never stuck Running forever.
const BACKGROUND_WORK_MAX_HOLD_MS = 60 * 60_000;
const toolInputsById = new Map();
let durableHookQueue = Promise.resolve();
let activeRunId = null;
let lastAssistantSummary = null;
let lastAssistantFailed = false;
let currentSessionId = null;
let currentSessionFileId = null;
// Most recent extension-context object seen from any Pi lifecycle hook, used
// only to ask `ctx.isIdle()` whether Pi is still mid-turn when the wake-grace
// timer expires. Never used for hook identity.
let lastCtx = null;
// id -> { mode, parentWorkflowRunId }. mode "workflow" marks a workflow
// coordinator run; its children (matched by parentWorkflowRunId) are tracked
// too, since we still must wait for them, but excluded from the displayed
// subagent count.
const backgroundRuns = new Map();
let deferredSettlement = null; // { runId, finalMessage, sessionId } | null
let backgroundWakeGraceTimer = null;
let backgroundHoldTimer = null;

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

// pi-subagents resolves its own notion of "current session" as
// `sessionManager.getSessionFile() ?? getSessionId()` (its session-identity
// helper), so the `sessionId` it reports on async lifecycle events is often a
// session file path rather than `getSessionId()`'s value. Capture both forms
// so we can recognize either.
function getSessionFileId(ctx) {
	try {
		return normalizeText(ctx.sessionManager.getSessionFile?.());
	} catch {
		return null;
	}
}

// File paths are data, not display text or normalized comparison identities.
function getSessionFilePath(ctx) {
	try {
		const path = ctx.sessionManager.getSessionFile?.();
		return typeof path === "string" && path.length > 0 && path.length <= 4096 ? path : null;
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

let hookHttpAgent = null;

function getHookHttpAgent() {
	if (!hookHttpAgent) {
		// A small keep-alive pool amortizes TCP setup across the many short-lived
		// best-effort hooks one Pi session emits. Node unrefs a keep-alive socket
		// once it is idle in the agent's free pool, so a kept-open connection
		// never by itself keeps this process alive past its own work.
		hookHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
	}
	return hookHttpAgent;
}

function readHookHttpUrl() {
	const raw = process.env[HOOK_HTTP_URL_ENV];
	if (!raw) {
		return null;
	}
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

// Best-effort activity hook delivered by an in-process POST to this runtime's
// loopback notify endpoint, mirroring Claude's `type: "http"` hooks. Returns
// null (never a pending promise) when no URL is published or it cannot be
// parsed, so the caller falls back to spawning `hooks notify`. Once started,
// this never retries and never falls back to spawning on its own failure -
// it is exactly as best-effort as the command it replaces.
function sendHookHttpNotify(metadata, ctx) {
	const url = readHookHttpUrl();
	if (!url) {
		return null;
	}
	return new Promise((resolve) => {
		let settled = false;
		let timer = null;
		function finish() {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			resolve();
		}

		try {
			const turnId = Object.prototype.hasOwnProperty.call(metadata, "turnId") ? metadata.turnId : activeRunId;
			const sessionId = Object.prototype.hasOwnProperty.call(metadata, "sessionId")
				? metadata.sessionId
				: getSessionId(ctx);
			const body = JSON.stringify({
				hook_event_name: truncate(metadata.hookEventName),
				activity_text: truncate(metadata.activityText),
				tool_name: truncate(metadata.toolName),
				tool_input_summary: truncate(metadata.toolInputSummary),
				turn_id: truncate(turnId),
				tool_use_id: truncate(metadata.toolUseId),
				session_id: truncate(sessionId),
				transcript_path: Object.prototype.hasOwnProperty.call(metadata, "transcriptPath")
					? metadata.transcriptPath
					: getSessionFilePath(ctx),
			});
			const search = new URLSearchParams({ event: HOOK_HTTP_EVENT, source: HOOK_HTTP_SOURCE }).toString();
			const sessionInstanceId = process.env[HOOK_HTTP_SESSION_INSTANCE_ID_ENV];
			const request = http.request(
				{
					agent: getHookHttpAgent(),
					method: "POST",
					// URL keeps IPv6 literals bracketed; http.request needs the bare address.
					hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
					port: url.port,
					path: `${url.pathname}?${search}`,
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
						[HOOK_HTTP_TOKEN_HEADER]: process.env[HOOK_HTTP_TOKEN_ENV] ?? "",
						[HOOK_HTTP_TASK_ID_HEADER]: process.env[HOOK_HTTP_TASK_ID_ENV] ?? "",
						[HOOK_HTTP_PROJECT_ID_HEADER]: process.env[HOOK_HTTP_PROJECT_ID_ENV] ?? "",
						...(sessionInstanceId ? { [HOOK_HTTP_SESSION_INSTANCE_ID_HEADER]: sessionInstanceId } : {}),
					},
				},
				(response) => {
					response.resume();
					response.on("end", finish);
				},
			);
			// Node unrefs a keep-alive socket once it is idle in the free pool, but
			// the active socket for an in-flight request stays ref'd; this is
			// fire-and-forget, so never let it (or this timeout) outlive Pi's exit.
			request.on("socket", (socket) => {
				socket.unref?.();
			});
			request.on("error", finish);
			timer = setTimeout(() => {
				request.destroy();
				finish();
			}, HOOK_HTTP_TIMEOUT_MS);
			timer.unref?.();
			request.end(body);
		} catch {
			finish();
		}
	});
}

function emitQuarterdeckHook(event, metadata, ctx, options = {}) {
	const waitForExit = options.waitForExit === true;
	// The notify endpoint admits only best-effort activity.
	if (!waitForExit && event === HOOK_HTTP_EVENT) {
		const httpDelivery = sendHookHttpNotify(metadata, ctx);
		if (httpDelivery) {
			return httpDelivery;
		}
	}
	const commandParts = readHookCommandParts();
	if (commandParts.length === 0) {
		return Promise.resolve();
	}
	const [binary, ...baseArgs] = commandParts;
	const args = [...selectHookCommandArgs(baseArgs, waitForExit), "--event", event, "--source", "pi"];
	appendFlag(args, "--activity-text", metadata.activityText);
	appendFlag(args, "--tool-name", metadata.toolName);
	appendFlag(args, "--tool-input-summary", metadata.toolInputSummary);
	appendFlag(args, "--final-message", metadata.finalMessage);
	appendFlag(args, "--hook-event-name", metadata.hookEventName);
	appendFlag(args, "--notification-type", metadata.notificationType);
	const turnId = Object.prototype.hasOwnProperty.call(metadata, "turnId") ? metadata.turnId : activeRunId;
	const sessionId = Object.prototype.hasOwnProperty.call(metadata, "sessionId")
		? metadata.sessionId
		: getSessionId(ctx);
	appendFlag(args, "--turn-id", turnId);
	appendFlag(args, "--tool-use-id", metadata.toolUseId);
	appendFlag(args, "--session-id", sessionId);
	const transcriptPath = Object.prototype.hasOwnProperty.call(metadata, "transcriptPath")
		? metadata.transcriptPath
		: getSessionFilePath(ctx);
	if (transcriptPath) args.push("--transcript-path", transcriptPath);

	return spawnHookCommand(binary, args, waitForExit);
}

function enqueueDurableHook(event, metadata, ctx) {
	// Durable emissions may wait behind an earlier hook while Pi has already
	// started another queued run. Freeze launch/run identity at enqueue time so
	// an older event can never inherit the next run's activeRunId. An explicit
	// (even null) turnId/sessionId own property - e.g. a deferred settlement's
	// captured identity - is never overridden by the live activeRunId/ctx;
	// only an absent property falls back to the current live run.
	const queuedMetadata = {
		...metadata,
		turnId: Object.prototype.hasOwnProperty.call(metadata, "turnId") ? metadata.turnId : activeRunId,
		sessionId: Object.prototype.hasOwnProperty.call(metadata, "sessionId") ? metadata.sessionId : getSessionId(ctx),
		transcriptPath: getSessionFilePath(ctx),
	};
	durableHookQueue = durableHookQueue.then(
		() => emitQuarterdeckHook(event, queuedMetadata, ctx, { waitForExit: true }),
		() => emitQuarterdeckHook(event, queuedMetadata, ctx, { waitForExit: true }),
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

function lastAssistantMessage(messages) {
	if (!Array.isArray(messages)) {
		return null;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		return message;
	}
	return null;
}

function isRecord(value) {
	return typeof value === "object" && value !== null;
}

function resolveAsyncCompleteRunId(payload) {
	if (!isRecord(payload)) {
		return null;
	}
	return normalizeText(typeof payload.runId === "string" ? payload.runId : payload.id);
}

// True only when `payloadSessionId` is present, we know at least one form of
// our own current session identity, and it matches neither form. Missing
// payload identity or unknown own identity is never treated as a mismatch,
// so a payload we cannot evaluate is always accepted (today's behavior).
function isAnotherSession(payloadSessionId) {
	if (!payloadSessionId) {
		return false;
	}
	if (!currentSessionId && !currentSessionFileId) {
		return false;
	}
	return payloadSessionId !== currentSessionId && payloadSessionId !== currentSessionFileId;
}

// Pi reports idle state itself (pi-subagents' own bridge code calls this
// same method); trust it over inferring idleness from our own hook history.
// A stale/disposed ctx or a host without the method is treated as idle so a
// detection failure can never strand the deferred Review.
function isPiIdle() {
	if (!lastCtx || typeof lastCtx.isIdle !== "function") {
		return true;
	}
	try {
		return lastCtx.isIdle() !== false;
	} catch {
		return true;
	}
}

function pluralizeSubagent(count) {
	return count === 1 ? "subagent" : "subagents";
}

// Workflow coordinators (mode "workflow") are excluded from the displayed
// count; we still wait for them (and their tracked children), but a person
// reading the card cares about the leaf work, not the orchestrating run.
function countDisplayableBackgroundRuns() {
	let count = 0;
	for (const run of backgroundRuns.values()) {
		if (run.mode !== "workflow") {
			count += 1;
		}
	}
	return count;
}

// A final message (e.g. a question the agent asked before background work
// finishes) must stay visible alongside the pending-background notice rather
// than being replaced by it.
function describeBackgroundPendingActivity(finalMessage, count) {
	const runningPhrase =
		count > 0 ? count + " background " + pluralizeSubagent(count) + " running" : "Background subagent work running";
	// Lead with the running phrase; --activity-text truncation would otherwise cut it off a long final message.
	return finalMessage ? runningPhrase + " · Final: " + finalMessage : runningPhrase;
}

function clearBackgroundWakeGraceTimer() {
	if (backgroundWakeGraceTimer) {
		clearTimeout(backgroundWakeGraceTimer);
		backgroundWakeGraceTimer = null;
	}
}

function clearBackgroundHoldTimer() {
	if (backgroundHoldTimer) {
		clearTimeout(backgroundHoldTimer);
		backgroundHoldTimer = null;
	}
}

function armBackgroundHoldTimer() {
	clearBackgroundHoldTimer();
	backgroundHoldTimer = setTimeout(() => {
		backgroundHoldTimer = null;
		// Never-observed completion (e.g. a killed worker pi-subagents never
		// saw finish, or a wake turn that never arrived): forget tracked runs
		// and flush today's Review rather than hold the task Running forever.
		backgroundRuns.clear();
		clearBackgroundWakeGraceTimer();
		flushDeferredSettlement();
	}, BACKGROUND_WORK_MAX_HOLD_MS);
	backgroundHoldTimer.unref?.();
}

function armBackgroundWakeGraceTimer() {
	clearBackgroundWakeGraceTimer();
	backgroundWakeGraceTimer = setTimeout(() => {
		backgroundWakeGraceTimer = null;
		if (!isPiIdle()) {
			// Pi still reports busy (e.g. a fresh turn whose agent_start hook
			// we have not observed yet); keep waiting rather than flush a
			// stale deferred Review. The hold timer remains the bound.
			armBackgroundWakeGraceTimer();
			return;
		}
		flushDeferredSettlement();
	}, BACKGROUND_WAKE_GRACE_MS);
	backgroundWakeGraceTimer.unref?.();
}

function flushDeferredSettlement() {
	const deferred = deferredSettlement;
	if (!deferred) {
		return;
	}
	deferredSettlement = null;
	clearBackgroundWakeGraceTimer();
	clearBackgroundHoldTimer();
	void enqueueDurableHook(
		"to_review",
		{
			hookEventName: "AgentSettled",
			activityText: deferred.finalMessage ? "Final: " + deferred.finalMessage : "Waiting for review",
			finalMessage: deferred.finalMessage,
			turnId: deferred.runId,
			sessionId: deferred.sessionId,
		},
		undefined,
	);
}

function clearBackgroundTracking() {
	backgroundRuns.clear();
	deferredSettlement = null;
	clearBackgroundWakeGraceTimer();
	clearBackgroundHoldTimer();
}

function subscribeToBackgroundSubagentEvents(pi) {
	if (typeof pi.events?.on !== "function") {
		// No cross-extension bus (older Pi, or pi-subagents not installed):
		// behavior stays exactly as it is today.
		return;
	}

	pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => {
		if (!isRecord(payload)) {
			return;
		}
		const id = normalizeText(payload.id);
		if (!id) {
			return;
		}
		if (isAnotherSession(normalizeText(payload.sessionId))) {
			return;
		}
		backgroundRuns.set(id, {
			mode: normalizeText(payload.mode),
			parentWorkflowRunId: normalizeText(payload.parentWorkflowRunId),
		});
		clearBackgroundWakeGraceTimer();
		armBackgroundHoldTimer();
	});

	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
		const runId = resolveAsyncCompleteRunId(payload);
		if (!runId) {
			return;
		}
		const completedRun = backgroundRuns.get(runId);
		let changed = backgroundRuns.delete(runId);
		if (completedRun?.mode === "workflow" || payload.mode === "workflow") {
			// The coordinator is done (a detached foreground workflow completes
			// without ever announcing a start); drop any children tracked under
			// it that never reported their own completion.
			for (const [childId, child] of backgroundRuns) {
				if (child.parentWorkflowRunId === runId) {
					backgroundRuns.delete(childId);
					changed = true;
				}
			}
		}
		if (!changed) {
			return;
		}
		if (backgroundRuns.size > 0) {
			armBackgroundHoldTimer();
			return;
		}
		if (!deferredSettlement) {
			// agent_start clears deferredSettlement, so its absence here means
			// either Pi is still running the current turn or there is nothing
			// waiting on a Review; either way there is nothing to flush.
			clearBackgroundHoldTimer();
			return;
		}
		// A workflow-awaited child reports triggerTurn: false because its
		// coordinator, not the child, will wake the parent.
		const noWakeComing =
			payload.awaitedByWorkflow !== true && (payload.triggerTurn === false || payload.intercomDelivered === true);
		if (noWakeComing) {
			flushDeferredSettlement();
			return;
		}
		// Keep a bounded fallback armed for the whole deferred-settlement
		// wait, not just while runs are tracked, in case the wake turn never
		// arrives.
		armBackgroundHoldTimer();
		armBackgroundWakeGraceTimer();
	});
}

export default function quarterdeckLifecycle(pi) {
	subscribeToBackgroundSubagentEvents(pi);
	// Freeze launch authority at initialization so later environment changes cannot
	// move it. The adapter supplies one verified canonical checkout.
	const trustScope = process.env[WORKTREE_TRUST_SCOPE_ENV];
	const managedTrustScope =
		trustScope &&
		isAbsolute(trustScope) &&
		[HOOK_HTTP_TASK_ID_ENV, HOOK_HTTP_PROJECT_ID_ENV, HOOK_HTTP_SESSION_INSTANCE_ID_ENV].every((key) =>
			Boolean(process.env[key]?.trim()),
		)
			? trustScope
			: null;
	pi.on("project_trust", async (event, ctx) => {
		if (managedTrustScope && typeof event.cwd === "string" && typeof ctx.cwd === "string") {
			try {
				if (isAbsolute(event.cwd) && isAbsolute(ctx.cwd)) {
					const [scope, eventCwd, contextCwd] = await Promise.all([
						realpath(managedTrustScope),
						realpath(event.cwd),
						realpath(ctx.cwd),
					]);
					if (scope === managedTrustScope && eventCwd === scope && contextCwd === scope) {
						return { trusted: "yes", remember: false };
					}
				}
			} catch {
				// Deleted or redirected paths cannot retain the launch's trust authority.
			}
		}
		return { trusted: "undecided" };
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		activeRunId = null;
		lastAssistantSummary = null;
		lastAssistantFailed = false;
		currentSessionId = getSessionId(ctx);
		currentSessionFileId = getSessionFileId(ctx);
		// New/replaced session: pi-subagents does not re-emit starts for
		// restored runs, so any previously tracked background work can never
		// be resolved here. Flush whatever Review this session already owes
		// before dropping tracking, so a reload cannot strand the previous
		// turn's deferred settlement in Running forever; falls back to
		// today's Review behavior for the new session.
		flushDeferredSettlement();
		clearBackgroundTracking();
		void enqueueDurableHook(
			"activity",
			{
				hookEventName: "session_meta",
				sessionId: currentSessionId,
			},
			ctx,
		);
	});

	pi.on("session_shutdown", () => {
		// Same reload-safety rationale as session_start: flush before
		// clearing so a pending deferred settlement is not silently lost.
		flushDeferredSettlement();
		clearBackgroundTracking();
		lastCtx = null;
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		activeRunId = randomUUID();
		lastAssistantSummary = null;
		lastAssistantFailed = false;
		currentSessionId = getSessionId(ctx);
		currentSessionFileId = getSessionFileId(ctx);
		// The new run supersedes any run awaiting a deferred Review; keep
		// tracked background runs, they still belong to this session.
		deferredSettlement = null;
		clearBackgroundWakeGraceTimer();
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
		lastCtx = ctx;
		const assistantMessage = lastAssistantMessage(event.messages);
		lastAssistantFailed = assistantMessage?.stopReason === "error";
		lastAssistantSummary = lastAssistantFailed
			? null
			: truncate(textFromContent(assistantMessage?.content)) ?? lastAssistantSummary;
		void enqueueDurableHook(
			"activity",
			{
				hookEventName: "AgentEnd",
				activityText: "Pi agent loop ended; waiting for settlement",
			},
			ctx,
		);
	});

	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		const settledRunId = activeRunId;
		const aborted = event.aborted === true;
		const failed = lastAssistantFailed;
		const finalMessage = aborted || failed ? null : lastAssistantSummary;
		currentSessionId = getSessionId(ctx);
		currentSessionFileId = getSessionFileId(ctx);
		// Interruption/failure must surface immediately even with background
		// work pending; only a clean settle can be deferred.
		if (!aborted && !failed && backgroundRuns.size > 0) {
			const pendingCount = countDisplayableBackgroundRuns();
			deferredSettlement = { runId: settledRunId, finalMessage, sessionId: currentSessionId };
			// The deferred record owns the run identity now; reset synchronously so a
			// completion arriving before this hook is delivered still sees Pi idle.
			activeRunId = null;
			lastAssistantSummary = null;
			lastAssistantFailed = false;
			void enqueueDurableHook(
				"activity",
				{
					hookEventName: "AgentSettledBackgroundPending",
					activityText: describeBackgroundPendingActivity(finalMessage, pendingCount),
					finalMessage,
					turnId: settledRunId,
				},
				ctx,
			);
			return;
		}
		// An abort before the next run's agent_start settles with no active run;
		// it then ends the run still awaiting a deferred Review.
		const reviewRunId = settledRunId ?? deferredSettlement?.runId ?? null;
		deferredSettlement = null;
		clearBackgroundWakeGraceTimer();
		void enqueueDurableHook(
			"to_review",
			{
				hookEventName: aborted ? "Interrupt" : failed ? "StopFailure" : "AgentSettled",
				activityText: aborted
					? "Pi interrupted"
					: failed
						? "Pi failed"
						: finalMessage ? "Final: " + finalMessage : "Waiting for review",
				finalMessage,
				turnId: reviewRunId,
			},
			ctx,
		).finally(() => {
			if (activeRunId === settledRunId) {
				activeRunId = null;
				lastAssistantSummary = null;
				lastAssistantFailed = false;
			}
		});
	});

	pi.on("session_before_switch", (_event, ctx) => {
		ctx.ui.notify("Quarterdeck-managed Pi sessions cannot switch provider session identity. Restart the task instead.", "warning");
		return { cancel: true };
	});

	pi.on("session_before_fork", (_event, ctx) => {
		ctx.ui.notify("Quarterdeck-managed Pi sessions cannot fork provider session identity.", "warning");
		return { cancel: true };
	});

	pi.on("tool_execution_start", (event, ctx) => {
		lastCtx = ctx;
		const toolInput = rememberToolInput(event);
		const toolInputSummary = summarizeToolInput(event.toolName, toolInput);
		void emitQuarterdeckHook(
			"activity",
			{
				hookEventName: "ToolExecutionStart",
				activityText: formatToolActivity("Using", event.toolName, toolInput),
				toolName: event.toolName,
				toolInputSummary,
				toolUseId: getToolCallId(event),
			},
			ctx,
		);
	});

	pi.on("tool_execution_update", (event, _ctx) => {
		rememberToolInput(event);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		lastCtx = ctx;
		const toolInput = resolveToolInput(event);
		const toolInputSummary = summarizeToolInput(event.toolName, toolInput);
		void emitQuarterdeckHook(
			"activity",
			{
				hookEventName: event.isError ? "ToolExecutionFailure" : "ToolExecutionEnd",
				activityText: formatToolActivity(event.isError ? "Failed" : "Completed", event.toolName, toolInput),
				toolName: event.toolName,
				toolInputSummary,
				toolUseId: getToolCallId(event),
			},
			ctx,
		);
		forgetToolInput(event);
	});
}
