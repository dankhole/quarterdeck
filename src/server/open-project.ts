import { spawn } from "node:child_process";

import {
	RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM,
	type RuntimeOpenTargetId,
	type RuntimeOpenTargetPlatform,
	resolveWindowsCompatibleCommand,
	resolveWindowsRootExecutablePath,
	terminateProcessForTimeout,
} from "../core";

export interface OpenProjectCommandCandidate {
	executable: string;
	args: string[];
}

export interface OpenProjectCommandProcessResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	error?: Error;
	timedOut?: boolean;
}

export type RunOpenProjectCommand = (
	executable: string,
	args: string[],
	cwd: string,
) => Promise<OpenProjectCommandProcessResult>;

export type SystemOpenProjectResult =
	| { kind: "opened" }
	| { kind: "unavailable"; error: string }
	| { kind: "failed"; error: string };

export interface OpenProjectOnHostOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	runCommand?: RunOpenProjectCommand;
}

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const OPEN_PROJECT_TIMEOUT_MS = 60_000;

const MAC_APP_NAMES: Partial<Record<RuntimeOpenTargetId, readonly string[]>> = {
	vscode: ["Visual Studio Code"],
	"vscode-insiders": ["Visual Studio Code - Insiders"],
	cursor: ["Cursor"],
	windsurf: ["Windsurf"],
	terminal: ["Terminal"],
	iterm2: ["iTerm", "iTerm2"],
	ghostty: ["Ghostty", "Ghostie"],
	warp: ["Warp"],
	xcode: ["Xcode"],
	intellijidea: ["IntelliJ IDEA", "IntelliJ IDEA CE"],
	rider: ["Rider", "JetBrains Rider"],
	zed: ["Zed"],
};

const DIRECT_EXECUTABLES: Partial<Record<RuntimeOpenTargetId, string>> = {
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	windsurf: "windsurf",
	rider: "rider",
	zed: "zed",
};

function resolvePlatform(platform: NodeJS.Platform): RuntimeOpenTargetPlatform {
	if (platform === "darwin") {
		return "mac";
	}
	if (platform === "win32") {
		return "windows";
	}
	if (platform === "linux") {
		return "linux";
	}
	return "other";
}

function normalizeTargetId(targetId: RuntimeOpenTargetId, platform: RuntimeOpenTargetPlatform): RuntimeOpenTargetId {
	const supportedTargets: readonly RuntimeOpenTargetId[] = RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM[platform];
	return supportedTargets.includes(targetId) ? targetId : "vscode";
}

export function resolveOpenProjectCommandCandidates(
	targetId: RuntimeOpenTargetId,
	projectPath: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv = process.env,
): OpenProjectCommandCandidate[] {
	const resolvedPlatform = resolvePlatform(platform);
	const resolvedTargetId = normalizeTargetId(targetId, resolvedPlatform);
	if (resolvedPlatform === "mac") {
		if (resolvedTargetId === "finder") {
			return [{ executable: "open", args: [projectPath] }];
		}
		const appNames = MAC_APP_NAMES[resolvedTargetId] ?? MAC_APP_NAMES.vscode ?? [];
		return appNames.map((appName) => ({
			executable: "open",
			args: ["-a", appName, projectPath],
		}));
	}
	if (resolvedTargetId === "finder") {
		return [
			{
				executable:
					resolvedPlatform === "windows" ? resolveWindowsRootExecutablePath("explorer.exe", env) : "xdg-open",
				args: [projectPath],
			},
		];
	}
	return [
		{
			executable: DIRECT_EXECUTABLES[resolvedTargetId] ?? "code",
			args: [projectPath],
		},
	];
}

function errorCode(error: unknown): string | null {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return null;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : null;
}

function runOpenProjectCommand(
	executable: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<OpenProjectCommandProcessResult> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | null = null;
		const appendOutput = (current: string, chunk: string): string => {
			const next = current + chunk;
			return next.length <= OUTPUT_LIMIT_BYTES ? next : next.slice(0, OUTPUT_LIMIT_BYTES);
		};
		const settle = (result: Omit<OpenProjectCommandProcessResult, "durationMs">): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			resolve({ ...result, durationMs: Date.now() - startedAt });
		};
		child.stdout?.on("data", (chunk: string | Buffer) => {
			stdout = appendOutput(stdout, String(chunk));
		});
		child.stderr?.on("data", (chunk: string | Buffer) => {
			stderr = appendOutput(stderr, String(chunk));
		});
		child.on("error", (error) => {
			settle({ stdout, stderr, status: null, signal: null, error, timedOut });
		});
		child.on("close", (status, signal) => {
			settle({ stdout, stderr, status, signal, timedOut });
		});
		timeout = setTimeout(() => {
			timedOut = true;
			terminateProcessForTimeout(child);
		}, OPEN_PROJECT_TIMEOUT_MS);
	});
}

function resolveExecutableLaunch(
	candidate: OpenProjectCommandCandidate,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): OpenProjectCommandCandidate {
	const command = resolveWindowsCompatibleCommand(candidate.executable, candidate.args, platform, env);
	return { executable: command.binary, args: command.args };
}

function describeNonzeroLaunch(executable: string, result: OpenProjectCommandProcessResult): string {
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();
	return (
		[stdout, stderr].filter(Boolean).join("\n") ||
		`Host launcher "${executable}" exited with code ${result.status ?? 1}.`
	);
}

export async function openProjectOnHost(
	targetId: RuntimeOpenTargetId,
	projectPath: string,
	options: OpenProjectOnHostOptions = {},
): Promise<SystemOpenProjectResult> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const candidates = resolveOpenProjectCommandCandidates(targetId, projectPath, platform, env);
	const runCommand =
		options.runCommand ?? ((executable, args, cwd) => runOpenProjectCommand(executable, args, cwd, env));
	let lastUnavailable: string | null = null;
	let lastFailure: string | null = null;

	for (const candidate of candidates) {
		let launch: OpenProjectCommandCandidate;
		try {
			launch = resolveExecutableLaunch(candidate, platform, env);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				lastUnavailable = `Host launcher "${candidate.executable}" is unavailable.`;
				continue;
			}
			return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
		}
		const result = await runCommand(launch.executable, launch.args, projectPath);
		if (errorCode(result.error) === "ENOENT") {
			lastUnavailable = `Host launcher "${candidate.executable}" is unavailable.`;
			continue;
		}
		if (result.error) {
			return { kind: "failed", error: result.error.message || String(result.error) };
		}
		if (result.timedOut) {
			return { kind: "failed", error: `Host launcher "${candidate.executable}" timed out.` };
		}
		if (result.signal) {
			return {
				kind: "failed",
				error: `Host launcher "${candidate.executable}" terminated by signal ${result.signal}.`,
			};
		}
		if (result.status === 0) {
			return { kind: "opened" };
		}
		lastFailure = describeNonzeroLaunch(candidate.executable, result);
	}

	if (lastFailure) {
		return { kind: "failed", error: lastFailure };
	}
	return {
		kind: "unavailable",
		error: lastUnavailable ?? "No host launcher is available for this open target.",
	};
}
