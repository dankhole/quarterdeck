#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import {
	extractPromptArgument,
	type FakeAgentCommand,
	parseFakeAgentCommand,
	resolveFakeAgentScenario,
} from "./fake-agent-protocol";
import { AgentLabScenarioSchema } from "./types";

const args = process.argv.slice(2);
const taskId = process.env.QUARTERDECK_HOOK_TASK_ID ?? "unknown-task";
const sessionId = `agent-lab-${taskId}`;
let turn = 0;
let closing = false;
let approvalOverlayActive = false;

function writeLine(message = ""): void {
	process.stdout.write(`${message}\r\n`);
}

function nextTurnId(): string {
	turn += 1;
	return `agent-lab-turn-${turn}`;
}

async function emitHook(
	event: "activity" | "to_in_progress" | "to_review",
	options: {
		hookEventName: string;
		activityText?: string;
		finalMessage?: string;
		notificationType?: string;
		toolName?: string;
	} = { hookEventName: "AgentLab" },
): Promise<void> {
	const tsxCliPath = process.env.QUARTERDECK_AGENT_LAB_TSX_CLI;
	const cliEntrypointPath = process.env.QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT;
	if (!tsxCliPath || !cliEntrypointPath) {
		writeLine("[agent-lab] Hook environment is incomplete.");
		return;
	}
	const hookArgs = [
		tsxCliPath,
		cliEntrypointPath,
		"hooks",
		"ingest",
		"--event",
		event,
		"--source",
		"codex",
		"--hook-event-name",
		options.hookEventName,
		"--session-id",
		sessionId,
		"--turn-id",
		nextTurnId(),
	];
	if (options.activityText) {
		hookArgs.push("--activity-text", options.activityText);
	}
	if (options.finalMessage) {
		hookArgs.push("--final-message", options.finalMessage);
	}
	if (options.notificationType) {
		hookArgs.push("--notification-type", options.notificationType);
	}
	if (options.toolName) {
		hookArgs.push("--tool-name", options.toolName);
	}

	await new Promise<void>((resolveHook) => {
		const hook = spawn(process.execPath, hookArgs, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "ignore", "pipe"],
		});
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
		const child = spawn("git", args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
	writeLine("  /needs-input [message]       request approval/input");
	writeLine("  /approval-overlay            render approval without a native hook");
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
			writeLine(`AGENT LAB NEEDS INPUT: ${command.message}`);
			await emitHook("to_review", {
				hookEventName: "PermissionRequest",
				activityText: "Waiting for approval",
				notificationType: "permission_prompt",
			});
			return;
		case "approval-overlay":
			approvalOverlayActive = true;
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
		case "review":
			writeLine(`AGENT LAB REVIEW READY: ${command.message}`);
			await emitHook("to_review", {
				hookEventName: "Stop",
				activityText: command.message,
				finalMessage: command.message,
			});
			return;
		case "working":
			writeLine(`AGENT LAB WORKING: ${command.message}`);
			await emitHook("to_in_progress", {
				hookEventName: "PostToolUse",
				activityText: command.message,
				toolName: "AgentLab",
			});
			return;
		case "write": {
			const destination = resolveFixturePath(command.relativePath);
			await emitHook("to_in_progress", {
				hookEventName: "PostToolUse",
				activityText: `Writing ${command.relativePath}`,
				toolName: "Write",
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
	}
}

function handleProbe(): boolean {
	if (args.includes("--version") || args[0] === "version") {
		process.stdout.write("codex-cli 0.142.5\n");
		return true;
	}
	if (args[0] === "features" && args[1] === "list") {
		process.stdout.write("hooks                                stable             true\n");
		return true;
	}
	return false;
}

async function main(): Promise<void> {
	if (handleProbe()) {
		return;
	}
	const prompt = extractPromptArgument(args);
	const fallbackScenario = AgentLabScenarioSchema.parse(process.env.QUARTERDECK_AGENT_LAB_SCENARIO ?? "idle");
	const scenario = resolveFakeAgentScenario(prompt, fallbackScenario);
	writeLine("Quarterdeck Agent Lab — deterministic fake Codex");
	writeLine(`AGENT LAB READY task=${taskId} scenario=${scenario}`);
	writeLine("Type /help for deterministic test commands.");
	void emitHook("activity", { hookEventName: "SessionStart", activityText: "Agent-lab session started" });

	const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	let clipboardResponseBuffer = "";
	process.stdin.on("data", (chunk: Buffer | string) => {
		const input = String(chunk);
		if (approvalOverlayActive && input === "\u001b") {
			approvalOverlayActive = false;
			process.stdout.write("\u001b[2J\u001b[H");
			writeLine("AGENT LAB APPROVAL DISMISSED");
			terminal.prompt();
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
				if (!closing && !approvalOverlayActive) {
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
	for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
		process.once(signal, () => {
			closing = true;
			terminal.close();
			process.exit(signal === "SIGINT" ? 130 : 0);
		});
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`[agent-lab fake codex] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
