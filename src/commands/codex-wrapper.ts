import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildQuarterdeckCommandParts,
	buildWindowsCmdArgsArray,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core";
import { parseHookRuntimeContextFromEnv } from "../terminal";
import { type CodexMappedHookEvent, startCodexSessionWatcher } from "./codex-hook-events";
import { appendMetadataFlags } from "./hook-metadata";

interface CodexWrapperArgs {
	realBinary: string;
	agentArgs: string[];
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

function notifyCodexSessionWatcherEvent(mapped: CodexMappedHookEvent): void {
	spawnDetachedQuarterdeck(appendMetadataFlags(["hooks", "notify", "--event", mapped.event], mapped.metadata));
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

export async function runCodexWrapperSubcommand(wrapperArgs: CodexWrapperArgs): Promise<void> {
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
