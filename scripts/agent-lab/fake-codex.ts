#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { buildGitCommandArgs, resolveWindowsCompatibleCommand } from "../../src/core";

import {
	buildClaudeHookPayload,
	type FakeAgentCommand,
	getFakeAgentVersionOutput,
	parseFakeAgentCommand,
	parseFakeAgentProvider,
	resolveFakeAgentInvocation,
	resolveFakeAgentScenario,
	shouldFakeClaudeUseFullscreen,
} from "./fake-agent-protocol";
import { AgentLabScenarioSchema } from "./types";

const args = process.argv.slice(2);
const provider = parseFakeAgentProvider(process.env.QUARTERDECK_AGENT_LAB_PROVIDER);
const invocation = resolveFakeAgentInvocation(provider, args);
const APPROVAL_COMPLETION_DELAY_MS = 5_000;
const taskId = process.env.QUARTERDECK_HOOK_TASK_ID ?? "unknown-task";
const requestedSessionId = invocation.requestedSessionId;
const sessionId = requestedSessionId || `agent-lab-${taskId}`;
let turn = 0;
let currentTurnId: string | null = null;
let promptSequence = 0;
let currentPromptId: string | null = null;
let lastSettledTurnId: string | null = null;
let toolUseSequence = 0;
let pendingToolUseId: string | null = null;
let closing = false;
let approvalOverlayActive = false;
let nativePermissionActive = false;
let pendingApprovalCompletion: NodeJS.Timeout | null = null;
let preserveRenderedPromptOnce = false;

function clearPendingApprovalCompletion(): void {
	if (!pendingApprovalCompletion) return;
	clearTimeout(pendingApprovalCompletion);
	pendingApprovalCompletion = null;
}

function scheduleApprovedToolCompletion(message: string): void {
	clearPendingApprovalCompletion();
	pendingApprovalCompletion = setTimeout(() => {
		pendingApprovalCompletion = null;
		void executeCommand({ kind: "working", message });
	}, APPROVAL_COMPLETION_DELAY_MS);
	pendingApprovalCompletion.unref();
}

function writeLine(message = ""): void {
	process.stdout.write(`${message}\r\n`);
}

function ensureTurnId(): string {
	if (!currentTurnId) {
		turn += 1;
		currentTurnId = `agent-lab-turn-${turn}`;
	}
	return currentTurnId;
}

function ensurePromptId(): string {
	if (!currentPromptId) {
		promptSequence += 1;
		currentPromptId = `agent-lab-prompt-${promptSequence}`;
	}
	return currentPromptId;
}

function nextToolUseId(): string {
	toolUseSequence += 1;
	return `agent-lab-tool-${toolUseSequence}`;
}

async function emitHook(
	event: "activity" | "to_in_progress" | "to_review",
	options: {
		hookEventName: string;
		activityText?: string;
		finalMessage?: string;
		notificationType?: string;
		toolName?: string;
		toolUseId?: string;
		includeTurnId?: boolean;
		turnId?: string;
		promptId?: string;
		providerAgentId?: string;
		elicitationId?: string;
		message?: string;
		error?: string;
		backgroundWork?: boolean;
		sessionSource?: "startup" | "resume";
	} = { hookEventName: "AgentLab" },
): Promise<void> {
	const tsxCliPath = process.env.QUARTERDECK_AGENT_LAB_TSX_CLI;
	const cliEntrypointPath = process.env.QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT;
	if (!tsxCliPath || !cliEntrypointPath) {
		writeLine("[agent-lab] Hook environment is incomplete.");
		return;
	}
	const reliableActivity = options.hookEventName === "SessionStart" || options.hookEventName === "PermissionDenied";
	const hookArgs = [
		tsxCliPath,
		cliEntrypointPath,
		"hooks",
		event === "activity" && !reliableActivity ? "notify" : "ingest",
		"--event",
		event,
		"--source",
		provider,
	];
	const claudePayload =
		provider === "claude"
			? buildClaudeHookPayload(options.hookEventName, {
					sessionId,
					cwd: process.cwd(),
					promptId:
						options.includeTurnId === false || options.hookEventName === "SessionStart"
							? null
							: (options.promptId ?? ensurePromptId()),
					toolName: options.toolName,
					toolUseId: options.hookEventName === "PermissionRequest" ? undefined : options.toolUseId,
					elicitationId: options.elicitationId,
					providerAgentId: options.providerAgentId,
					notificationType: options.hookEventName === "PermissionRequest" ? undefined : options.notificationType,
					message: options.message ?? options.activityText,
					finalMessage: options.finalMessage,
					error: options.error,
					backgroundWork: options.backgroundWork,
					sessionSource: options.sessionSource,
				})
			: null;
	if (!claudePayload) {
		hookArgs.push("--hook-event-name", options.hookEventName, "--session-id", sessionId);
		if (options.includeTurnId !== false) {
			hookArgs.push("--turn-id", options.turnId ?? ensureTurnId());
		}
		if (options.activityText) hookArgs.push("--activity-text", options.activityText);
		if (options.finalMessage) hookArgs.push("--final-message", options.finalMessage);
		if (options.notificationType) hookArgs.push("--notification-type", options.notificationType);
		if (options.toolName) hookArgs.push("--tool-name", options.toolName);
		if (options.toolUseId) hookArgs.push("--tool-use-id", options.toolUseId);
	}

	await new Promise<void>((resolveHook) => {
		const hook = spawn(process.execPath, hookArgs, {
			cwd: process.cwd(),
			env: process.env,
			stdio: [claudePayload ? "pipe" : "ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		if (claudePayload) {
			hook.stdin?.end(`${JSON.stringify(claudePayload)}\n`);
		}
		let stderr = "";
		hook.stderr?.setEncoding("utf8");
		hook.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		hook.once("error", (error) => {
			writeLine(`[agent-lab hook error] ${error.message}`);
			resolveHook();
		});
		hook.once("exit", (code) => {
			if (code !== 0) {
				writeLine(`[agent-lab hook error] ${stderr.trim() || `exit ${code}`}`);
			}
			resolveHook();
		});
	});
}

function resolveFixturePath(relativePath: string): string {
	if (!relativePath || isAbsolute(relativePath)) {
		throw new Error("File path must be relative to the disposable project.");
	}
	const checkoutPath = resolve(process.cwd());
	const destination = resolve(checkoutPath, relativePath);
	const relativeToCheckout = relative(checkoutPath, destination);
	if (relativeToCheckout === ".." || relativeToCheckout.startsWith(`..${sep}`) || isAbsolute(relativeToCheckout)) {
		throw new Error("File path escaped the disposable project.");
	}
	return destination;
}

async function runGit(args: string[]): Promise<{ output: string; code: number }> {
	return new Promise((resolveGit) => {
		const command = resolveWindowsCompatibleCommand("git", buildGitCommandArgs(args));
		const child = spawn(command.binary, command.args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", (error) => resolveGit({ output: error.message, code: 1 }));
		child.once("exit", (code) => resolveGit({ output, code: code ?? 1 }));
	});
}

function printHelp(): void {
	writeLine("Agent-lab commands:");
	writeLine("  /needs-input [message]       request approval; y accepts, esc dismisses");
	writeLine("  /needs-input-auto [message]  request then provider-approve without local input");
	writeLine("  /approval-overlay            render hookless approval; y accepts, esc dismisses");
	writeLine("  /turn-interrupted            render Codex turn interruption without a native hook");
	writeLine("  /new-turn [message]          emit a new-turn UserPromptSubmit hook");
	writeLine("  /redraw-interruption-history redraw old interruption above current work");
	writeLine("  /local-action [message]      accept a TUI-local action without a hook");
	writeLine("  /compact                     run activity-only manual compaction hooks");
	writeLine("  /notification [message]      emit a Claude attention notification");
	writeLine("  /elicitation [message]       emit a Claude MCP elicitation wait");
	writeLine("  /elicitation-result [message] resolve the current Claude elicitation");
	writeLine("  /background-stop [message]   emit a pending root Stop and SubagentStop");
	writeLine("  /stop-failure [message]      emit a Claude StopFailure review");
	writeLine("  /queued-follow-up [message]  emit agent_end followed by a queued agent_start");
	writeLine("  /stale-run                   replay the last completed Pi run identity");
	writeLine("  /fail-next-resume            crash now and fail the next targeted Pi resume");
	writeLine("  /working [message]           transition back to running");
	writeLine("  /review [message]            finish the turn for review");
	writeLine("  /write <path> <contents>     write inside the disposable checkout");
	writeLine("  /commit [message]            commit all disposable changes");
	writeLine("  /status                      show git status");
	writeLine("  /clipboard-read              read the lab clipboard through OSC 52");
	writeLine("  /spam [1-2000]               produce terminal scrollback");
	writeLine("  /alt-on | /alt-off           exercise the alternate screen");
	writeLine("  /delay-review <ms> [message] schedule a review hook");
	writeLine("  /fail [message]              exit non-zero");
	writeLine("  /exit [code]                 exit with a chosen code");
}

async function executeCommand(command: FakeAgentCommand): Promise<void> {
	switch (command.kind) {
		case "help":
			printHelp();
			return;
		case "needs-input":
			clearPendingApprovalCompletion();
			approvalOverlayActive = false;
			nativePermissionActive = true;
			pendingToolUseId = nextToolUseId();
			writeLine(`AGENT LAB NEEDS INPUT: ${command.message}`);
			await emitHook(provider === "claude" ? "to_in_progress" : "activity", {
				hookEventName: "PreToolUse",
				activityText: command.message,
				toolName: "AgentLab",
				toolUseId: pendingToolUseId,
			});
			await emitHook("to_review", {
				hookEventName: "PermissionRequest",
				activityText: "Waiting for approval",
				notificationType: "permission_prompt",
				toolName: "AgentLab",
				toolUseId: pendingToolUseId,
			});
			return;
		case "needs-input-auto":
			clearPendingApprovalCompletion();
			approvalOverlayActive = false;
			nativePermissionActive = false;
			pendingToolUseId = nextToolUseId();
			writeLine(`AGENT LAB AUTO APPROVAL REQUEST: ${command.message}`);
			await emitHook(provider === "claude" ? "to_in_progress" : "activity", {
				hookEventName: "PreToolUse",
				activityText: command.message,
				toolName: "AgentLab",
				toolUseId: pendingToolUseId,
			});
			await emitHook("to_review", {
				hookEventName: "PermissionRequest",
				activityText: "Waiting for provider approval",
				notificationType: "permission_prompt",
				toolName: "AgentLab",
			});
			scheduleApprovedToolCompletion("Provider-approved tool completed");
			return;
		case "approval-overlay":
			clearPendingApprovalCompletion();
			nativePermissionActive = false;
			approvalOverlayActive = true;
			pendingToolUseId = nextToolUseId();
			{
				const rows = Math.max(10, process.stdout.rows ?? 40);
				const startRow = rows - 8;
				process.stdout.write("\u001b[2J\u001b[H");
				process.stdout.write(`\u001b[${startRow};1H  Would you like to run the following command?`);
				process.stdout.write(`\u001b[${startRow + 2};1H  $ echo agent-lab-approval`);
				process.stdout.write(`\u001b[${startRow + 4};1H› 1. Yes, proceed (y)`);
				process.stdout.write(`\u001b[${startRow + 5};1H  2. No, and tell Codex what to do differently (esc)`);
				process.stdout.write(`\u001b[${rows};1H  Press enter to confirm or esc to cancel`);
			}
			return;
		case "turn-interrupted":
			preserveRenderedPromptOnce = true;
			process.stdout.write(
				"\u001b[2J\u001b[H\u001b[31m■ Conversation interrupted - tell the model what to do differently. " +
					"Something went wrong? Hit `/feedback` to report the issue.\u001b[0m\r\n\r\n› Ask Codex to do anything",
			);
			return;
		case "new-turn":
			currentTurnId = null;
			currentPromptId = null;
			writeLine(`AGENT LAB NEW TURN: ${command.message}`);
			await emitHook("to_in_progress", {
				hookEventName: "UserPromptSubmit",
				activityText: command.message,
			});
			return;
		case "redraw-interruption-history":
			preserveRenderedPromptOnce = true;
			process.stdout.write(
				"\u001b[2J\u001b[H\u001b[31m■ Conversation interrupted - tell the model what to do differently. " +
					"Something went wrong? Hit `/feedback` to report the issue.\u001b[0m\r\n\r\n" +
					"› Ask Codex to do anything\r\n\r\nAGENT LAB CURRENT TURN WORKING\r\n\r\n› Ask Codex to do anything",
			);
			return;
		case "local-action":
			writeLine(`AGENT LAB LOCAL ACTION: ${command.message}`);
			return;
		case "compact":
			writeLine("AGENT LAB COMPACTION STARTED");
			await emitHook("activity", {
				hookEventName: "PreCompact",
				activityText: "Compacting local conversation context",
			});
			await emitHook("activity", {
				hookEventName: "PostCompact",
				activityText: "Local conversation context compacted",
			});
			writeLine("AGENT LAB COMPACTION COMPLETE");
			return;
		case "notification":
			if (provider !== "claude") {
				writeLine("AGENT LAB UNSUPPORTED: /notification requires fake Claude");
				return;
			}
			writeLine(`AGENT LAB CLAUDE NOTIFICATION: ${command.message}`);
			await emitHook("activity", {
				hookEventName: "Notification",
				notificationType: "agent_needs_input",
				message: command.message,
			});
			return;
		case "elicitation":
			if (provider !== "claude") {
				writeLine("AGENT LAB UNSUPPORTED: /elicitation requires fake Claude");
				return;
			}
			writeLine(`AGENT LAB CLAUDE ELICITATION: ${command.message}`);
			await emitHook("to_review", {
				hookEventName: "Elicitation",
				activityText: command.message,
				elicitationId: "agent-lab-elicitation-1",
			});
			return;
		case "elicitation-result":
			if (provider !== "claude") {
				writeLine("AGENT LAB UNSUPPORTED: /elicitation-result requires fake Claude");
				return;
			}
			writeLine(`AGENT LAB CLAUDE ELICITATION RESULT: ${command.message}`);
			await emitHook("to_in_progress", {
				hookEventName: "ElicitationResult",
				activityText: command.message,
				elicitationId: "agent-lab-elicitation-1",
			});
			return;
		case "background-stop":
			if (provider !== "claude") {
				writeLine("AGENT LAB UNSUPPORTED: /background-stop requires fake Claude");
				return;
			}
			writeLine(`AGENT LAB CLAUDE BACKGROUND STOP: ${command.message}`);
			await emitHook("to_review", {
				hookEventName: "Stop",
				activityText: command.message,
				finalMessage: command.message,
				backgroundWork: true,
			});
			await emitHook("activity", {
				hookEventName: "SubagentStop",
				activityText: "Synthetic background agent completed",
				finalMessage: "Synthetic background agent completed",
				providerAgentId: "agent-lab-background-1",
			});
			return;
		case "stop-failure":
			if (provider !== "claude") {
				writeLine("AGENT LAB UNSUPPORTED: /stop-failure requires fake Claude");
				return;
			}
			writeLine(`AGENT LAB CLAUDE STOP FAILURE: ${command.message}`);
			await emitHook("to_review", {
				hookEventName: "StopFailure",
				finalMessage: command.message,
				error: "agent_lab_simulated_failure",
			});
			currentPromptId = null;
			return;
		case "queued-follow-up": {
			const endedTurnId = ensureTurnId();
			writeLine("AGENT LAB PI QUEUED FOLLOW-UP: agent_end emitted");
			await emitHook("activity", {
				hookEventName: "AgentEnd",
				activityText: "Pi agent loop ended with queued input pending",
				turnId: endedTurnId,
			});
			currentTurnId = null;
			writeLine(`AGENT LAB PI QUEUED FOLLOW-UP STARTED: ${command.message}`);
			await emitHook("to_in_progress", {
				hookEventName: "AgentStart",
				activityText: command.message,
			});
			return;
		}
		case "stale-run":
			if (!lastSettledTurnId) {
				writeLine("AGENT LAB PI STALE RUN SKIPPED: no settled run");
				return;
			}
			writeLine(`AGENT LAB PI STALE RUN REPLAYED: ${lastSettledTurnId}`);
			await emitHook("to_in_progress", {
				hookEventName: "AgentStart",
				activityText: "Stale completed Pi run replay",
				turnId: lastSettledTurnId,
			});
			return;
		case "fail-next-resume":
			await writeResumeFailureMarker();
			writeLine("AGENT LAB PI NEXT TARGETED RESUME WILL FAIL");
			closing = true;
			setTimeout(() => process.exit(1), 20).unref();
			return;
		case "review":
			clearPendingApprovalCompletion();
			nativePermissionActive = false;
			writeLine(`AGENT LAB REVIEW READY: ${command.message}`);
			if (provider === "pi") {
				const settledTurnId = ensureTurnId();
				await emitHook("activity", {
					hookEventName: "AgentEnd",
					activityText: "Pi agent loop ended; waiting for settlement",
					turnId: settledTurnId,
				});
				await emitHook("to_review", {
					hookEventName: "AgentSettled",
					activityText: command.message,
					finalMessage: command.message,
					turnId: settledTurnId,
				});
				lastSettledTurnId = settledTurnId;
			} else {
				await emitHook("to_review", {
					hookEventName: "Stop",
					activityText: command.message,
					finalMessage: command.message,
				});
			}
			currentTurnId = null;
			currentPromptId = null;
			pendingToolUseId = null;
			return;
		case "working":
			clearPendingApprovalCompletion();
			nativePermissionActive = false;
			writeLine(`AGENT LAB WORKING: ${command.message}`);
			await emitHook("to_in_progress", {
				hookEventName: provider === "pi" ? (pendingToolUseId ? "PermissionResolved" : "AgentStart") : "PostToolUse",
				activityText: command.message,
				toolName: "AgentLab",
				toolUseId: pendingToolUseId ?? nextToolUseId(),
			});
			pendingToolUseId = null;
			return;
		case "write": {
			const destination = resolveFixturePath(command.relativePath);
			await emitHook("to_in_progress", {
				hookEventName: "PostToolUse",
				activityText: `Writing ${command.relativePath}`,
				toolName: "Write",
				toolUseId: nextToolUseId(),
			});
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, `${command.contents}\n`, "utf8");
			writeLine(`AGENT LAB WROTE: ${command.relativePath}`);
			return;
		}
		case "commit": {
			await emitHook("to_in_progress", {
				hookEventName: "PostToolUse",
				activityText: "Committing fixture changes",
				toolName: "Bash",
				toolUseId: nextToolUseId(),
			});
			const add = await runGit(["add", "--all"]);
			if (add.code !== 0) {
				writeLine(`AGENT LAB GIT ERROR: ${add.output.trim()}`);
				return;
			}
			const commit = await runGit(["commit", "-m", command.message]);
			writeLine(
				commit.code === 0 ? `AGENT LAB COMMITTED: ${command.message}` : `AGENT LAB GIT: ${commit.output.trim()}`,
			);
			return;
		}
		case "status": {
			const status = await runGit(["status", "--short", "--branch"]);
			writeLine("AGENT LAB GIT STATUS:");
			for (const line of status.output.trimEnd().split("\n")) {
				writeLine(line);
			}
			return;
		}
		case "clipboard-read":
			process.stdout.write("\u001b]52;c;?\u0007");
			writeLine("AGENT LAB CLIPBOARD READ REQUESTED");
			return;
		case "spam":
			for (let index = 1; index <= command.count; index += 1) {
				writeLine(`AGENT LAB OUTPUT ${String(index).padStart(4, "0")}/${String(command.count).padStart(4, "0")}`);
			}
			return;
		case "alternate-screen":
			process.stdout.write(command.enabled ? "\u001b[?1049h\u001b[2J\u001b[H" : "\u001b[?1049l");
			writeLine(command.enabled ? "AGENT LAB ALTERNATE SCREEN" : "AGENT LAB NORMAL SCREEN");
			return;
		case "delay-review":
			writeLine(`AGENT LAB REVIEW SCHEDULED: ${command.delayMs}ms`);
			setTimeout(() => {
				void executeCommand({ kind: "review", message: command.message });
			}, command.delayMs).unref();
			return;
		case "fail":
			writeLine(`AGENT LAB FAILURE: ${command.message}`);
			closing = true;
			setTimeout(() => process.exit(1), 20).unref();
			return;
		case "exit":
			writeLine(`AGENT LAB EXIT: ${command.code}`);
			closing = true;
			setTimeout(() => process.exit(command.code), 20).unref();
			return;
		case "echo":
			writeLine(`AGENT LAB ECHO: ${command.text}`);
	}
}

async function runScenario(scenario: ReturnType<typeof AgentLabScenarioSchema.parse>): Promise<void> {
	switch (scenario) {
		case "idle":
			return;
		case "needs-input":
			await executeCommand({ kind: "needs-input", message: "Scenario requested approval" });
			return;
		case "review":
			await executeCommand({ kind: "review", message: "Scenario completed for review" });
			return;
		case "failure":
			await executeCommand({ kind: "fail", message: "Scenario simulated an agent failure" });
			return;
		case "git-dirty":
			await executeCommand({
				kind: "write",
				relativePath: "agent-lab-output.txt",
				contents: "dirty fixture change",
			});
			return;
		case "terminal-stress":
			await executeCommand({ kind: "spam", count: 400 });
			return;
		case "claude-lifecycle":
			await executeCommand({ kind: "new-turn", message: "Synthetic Claude prompt submitted" });
			await executeCommand({ kind: "needs-input", message: "Synthetic Claude permission request" });
			await executeCommand({ kind: "notification", message: "Synthetic Claude notification" });
			await executeCommand({ kind: "working", message: "Synthetic Claude tool completed" });
			await executeCommand({ kind: "elicitation", message: "Choose a synthetic option" });
			await executeCommand({ kind: "elicitation-result", message: "Synthetic option selected" });
			await executeCommand({ kind: "background-stop", message: "Waiting for synthetic background work" });
			await executeCommand({ kind: "review", message: "Synthetic Claude lifecycle completed" });
			return;
		case "claude-failure":
			await executeCommand({ kind: "new-turn", message: "Synthetic Claude failing prompt submitted" });
			await executeCommand({ kind: "stop-failure", message: "Synthetic Claude turn failed" });
	}
}

function handleProbe(): boolean {
	if (args.includes("--version") || args[0] === "version") {
		process.stdout.write(`${getFakeAgentVersionOutput(provider)}\n`);
		return true;
	}
	if (args[0] === "features" && args[1] === "list") {
		process.stdout.write("hooks                                stable             true\n");
		return true;
	}
	return false;
}

function getResumeFailureMarkerPath(): string {
	const stateHome = process.env.QUARTERDECK_STATE_HOME;
	if (!stateHome) {
		throw new Error("QUARTERDECK_STATE_HOME is required for deterministic Pi resume failure.");
	}
	return join(stateHome, "agent-lab", "pi-resume-failures", taskId);
}

async function writeResumeFailureMarker(): Promise<void> {
	const markerPath = getResumeFailureMarkerPath();
	await mkdir(dirname(markerPath), { recursive: true });
	await writeFile(markerPath, "fail-once\n", "utf8");
}

async function consumeResumeFailureMarker(): Promise<boolean> {
	if (provider !== "pi" || !requestedSessionId) {
		return false;
	}
	try {
		await unlink(getResumeFailureMarkerPath());
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function assertClaudeLaunchContract(): Promise<void> {
	if (provider !== "claude") return;
	if (args.includes("--continue") && requestedSessionId) {
		throw new Error("Fake Claude received conflicting --continue and --resume options.");
	}
	if (!invocation.settingsPath) {
		throw new Error("Fake Claude requires Quarterdeck's launch-scoped --settings file.");
	}
	const parsed = JSON.parse(await readFile(invocation.settingsPath, "utf8")) as {
		hooks?: Record<string, unknown>;
	};
	const expectedHookCommands = {
		SessionStart: ["ingest", "activity"],
		UserPromptSubmit: ["ingest", "to_in_progress"],
		PreToolUse: ["ingest", "to_in_progress"],
		PermissionRequest: ["ingest", "to_review"],
		Notification: ["notify", "activity"],
		PostToolUse: ["ingest", "to_in_progress"],
		SubagentStop: ["notify", "activity"],
		Elicitation: ["ingest", "to_review"],
		ElicitationResult: ["ingest", "to_in_progress"],
		Stop: ["ingest", "to_review"],
		StopFailure: ["ingest", "to_review"],
	} as const;
	for (const [hookName, [delivery, event]] of Object.entries(expectedHookCommands)) {
		const serializedHook = JSON.stringify(parsed.hooks?.[hookName]);
		const expectedCommand = `'hooks' '${delivery}' '--event' '${event}' '--source' 'claude'`;
		if (!serializedHook.includes(expectedCommand)) {
			throw new Error(`Fake Claude settings do not map ${hookName} to ${delivery}:${event}.`);
		}
	}
}

async function main(): Promise<void> {
	if (handleProbe()) {
		return;
	}
	await assertClaudeLaunchContract();
	if (await consumeResumeFailureMarker()) {
		writeLine(`AGENT LAB PI TARGETED RESUME FAILED: ${requestedSessionId}`);
		process.exitCode = 78;
		return;
	}
	const prompt = invocation.prompt;
	const fallbackScenario = AgentLabScenarioSchema.parse(process.env.QUARTERDECK_AGENT_LAB_SCENARIO ?? "idle");
	const scenario = resolveFakeAgentScenario(prompt, fallbackScenario);
	const providerLabel = provider === "pi" ? "Pi" : provider === "claude" ? "Claude" : "Codex";
	if (shouldFakeClaudeUseFullscreen(provider, process.env)) {
		process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H");
	}
	writeLine(`Quarterdeck Agent Lab — deterministic fake ${providerLabel}`);
	writeLine(`AGENT LAB READY task=${taskId} scenario=${scenario}`);
	writeLine("Type /help for deterministic test commands.");
	void emitHook("activity", {
		hookEventName: provider === "pi" ? "session_meta" : "SessionStart",
		activityText: "Agent-lab session started",
		includeTurnId: provider !== "pi",
		sessionSource: invocation.resumeKind === "fresh" ? "startup" : "resume",
	});

	const terminal = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
		// The fake consumes bare Escape as an immediate approval cancellation.
		// Keep Readline from retaining it as a long-lived ANSI prefix that can
		// swallow the leading slash of the next deterministic command.
		escapeCodeTimeout: 25,
	});
	let clipboardResponseBuffer = "";
	process.stdin.on("data", (chunk: Buffer | string) => {
		const input = String(chunk);
		if (nativePermissionActive && input.toLowerCase() === "y") {
			nativePermissionActive = false;
			// The real Codex approval pane consumes this hotkey immediately rather
			// than buffering it as prompt text. Mirror that behavior deterministically.
			terminal.write(null, { ctrl: true, name: "u" });
			writeLine("AGENT LAB NATIVE APPROVAL RESPONSE SUBMITTED");
			scheduleApprovedToolCompletion("Approved native tool completed");
		} else if (nativePermissionActive && input === "\u001b") {
			nativePermissionActive = false;
			const deniedToolUseId = pendingToolUseId;
			pendingToolUseId = null;
			writeLine("AGENT LAB NATIVE APPROVAL DISMISSED");
			if (provider === "pi" && deniedToolUseId) {
				void emitHook("to_in_progress", {
					hookEventName: "PermissionDenied",
					activityText: "Pi tool approval denied",
					toolName: "AgentLab",
					toolUseId: deniedToolUseId,
				});
			}
			terminal.prompt();
		} else if (approvalOverlayActive && input === "\u001b") {
			approvalOverlayActive = false;
			process.stdout.write("\u001b[2J\u001b[H");
			writeLine("AGENT LAB APPROVAL DISMISSED");
			terminal.prompt();
		} else if (approvalOverlayActive && (input.includes("\r") || input.toLowerCase() === "y")) {
			approvalOverlayActive = false;
			terminal.write(null, { ctrl: true, name: "u" });
			process.stdout.write("\u001b[2J\u001b[H");
			writeLine("AGENT LAB APPROVAL RESPONSE SUBMITTED");
			scheduleApprovedToolCompletion("Approved tool completed");
		}
		clipboardResponseBuffer = `${clipboardResponseBuffer}${input}`.slice(-4096);
		const responsePrefix = "\u001b]52;c;";
		const responseStart = clipboardResponseBuffer.indexOf(responsePrefix);
		const responseEnd = clipboardResponseBuffer.indexOf("\u0007", responseStart + responsePrefix.length);
		if (responseStart === -1 || responseEnd === -1) {
			return;
		}
		const encodedText = clipboardResponseBuffer.slice(responseStart + responsePrefix.length, responseEnd);
		clipboardResponseBuffer = clipboardResponseBuffer.slice(responseEnd + 1);
		const clipboardText = Array.from(Buffer.from(encodedText, "base64").toString("utf8"))
			.map((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127 ? " " : character;
			})
			.join("")
			.slice(0, 200);
		writeLine(`AGENT LAB CLIPBOARD READ: ${clipboardText}`);
	});
	terminal.setPrompt("lab> ");
	let commandQueue = Promise.resolve();
	terminal.on("line", (line) => {
		commandQueue = commandQueue
			.then(() => executeCommand(parseFakeAgentCommand(line)))
			.catch((error: unknown) =>
				writeLine(`AGENT LAB ERROR: ${error instanceof Error ? error.message : String(error)}`),
			)
			.finally(() => {
				if (preserveRenderedPromptOnce) {
					preserveRenderedPromptOnce = false;
				} else if (!closing && !approvalOverlayActive) {
					terminal.prompt();
				}
			});
	});
	terminal.on("close", () => {
		if (!closing) {
			closing = true;
			process.exit(0);
		}
	});
	terminal.prompt();
	setTimeout(() => {
		commandQueue = commandQueue.then(() => runScenario(scenario));
	}, 250).unref();
	for (const signal of [
		"SIGINT",
		"SIGTERM",
		"SIGHUP",
		...(process.platform === "win32" ? ["SIGBREAK"] : []),
	] as NodeJS.Signals[]) {
		process.once(signal, () => {
			closing = true;
			terminal.close();
			process.exit(
				signal === "SIGINT"
					? 130
					: signal === "SIGHUP"
						? 129
						: signal === "SIGTERM"
							? 143
							: signal === "SIGBREAK"
								? 149
								: 1,
			);
		});
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`[agent-lab fake agent] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
