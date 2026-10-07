import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { Readable } from "node:stream";

import { stopRuntimeOwnedProcessTrees } from "../../src/server/owned-process-shutdown.js";

const LOGIN_SHELLS = new Set([
	"/bin/zsh",
	"/bin/bash",
	"/bin/sh",
	"/usr/local/bin/zsh",
	"/usr/local/bin/bash",
	"/usr/local/bin/fish",
	"/opt/homebrew/bin/zsh",
	"/opt/homebrew/bin/bash",
	"/opt/homebrew/bin/fish",
]);
const SAFE_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HELPER_INJECTION_VARIABLES = new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"NODE_INSPECT_RESUME_ON_START",
	"NODE_CHANNEL_FD",
	"NODE_CHANNEL_SERIALIZATION_MODE",
	"ELECTRON_RUN_AS_NODE",
	"VSCODE_INSPECTOR_OPTIONS",
	"VSCODE_DEBUG_SETTINGS",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
]);
const ENVIRONMENT_CAPTURE_COMMAND = "exec /usr/bin/env -0 >&3";

export type DesktopEnvironmentMode = "auto" | "inherit" | "login-shell";
export type DesktopEnvironmentFailureReason =
	| "unsupported_shell"
	| "capture_failed"
	| "capture_timeout"
	| "capture_output_limit"
	| "capture_invalid";

export type DesktopLaunchEnvironmentResult =
	| { source: "inherited" | "login-shell"; environment: NodeJS.ProcessEnv }
	| {
			source: "fallback";
			environment: NodeJS.ProcessEnv;
			failureReason: DesktopEnvironmentFailureReason;
			processCleanup: "not_needed" | "stopped" | "unconfirmed";
	  };

export interface DesktopLaunchEnvironmentOptions {
	nodePath: string;
	inheritedEnvironment: Readonly<NodeJS.ProcessEnv>;
	mode?: DesktopEnvironmentMode;
	isolatedLab?: boolean;
	platform?: NodeJS.Platform;
	captureTimeoutMs?: number;
	maxCaptureBytes?: number;
	cleanupTimeoutMs?: number;
	/** Main-process dependencies only; no renderer can provide commands or arguments. */
	getLoginShell?: () => string | null;
	spawnCapture?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
	stopCaptureTree?: (child: ChildProcess) => Promise<"stopped" | "unconfirmed">;
}

/** Preserve provider configuration while preventing inherited Node/Electron injection. */
export function sanitizeDesktopHelperEnvironment(
	environment: Readonly<NodeJS.ProcessEnv>,
	nodePath: string,
): NodeJS.ProcessEnv {
	if (!isAbsolute(nodePath) || /[\0\r\n]/u.test(nodePath)) {
		throw new Error("The bundled Node executable must have a valid absolute path.");
	}
	const entries: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(environment)) {
		if (
			value === undefined ||
			!ENVIRONMENT_NAME.test(name) ||
			value.includes("\0") ||
			HELPER_INJECTION_VARIABLES.has(name.toUpperCase())
		)
			continue;
		entries.push([name, value]);
	}
	const sanitized: NodeJS.ProcessEnv = Object.fromEntries(entries);
	const paths = [dirname(nodePath), ...(sanitized.PATH ?? "").split(":"), ...SAFE_PATH];
	sanitized.PATH = Array.from(new Set(paths.filter((path) => isAbsolute(path) && !/[\0\r\n]/u.test(path)))).join(":");
	return sanitized;
}

function hasTerminalEnvironment(environment: Readonly<NodeJS.ProcessEnv>): boolean {
	return Boolean(environment.TERM_PROGRAM || environment.TERM_SESSION_ID || environment.SSH_TTY);
}

function parseEnvironment(bytes: Buffer): NodeJS.ProcessEnv | null {
	if (bytes.length === 0 || bytes.at(-1) !== 0) return null;
	let records: string[];
	try {
		records = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
	} catch {
		return null;
	}
	records.pop();
	const entries: Array<[string, string]> = [];
	const names = new Set<string>();
	for (const record of records) {
		const separator = record.indexOf("=");
		if (separator < 1) return null;
		const name = record.slice(0, separator);
		if (!ENVIRONMENT_NAME.test(name) || names.has(name)) return null;
		names.add(name);
		entries.push([name, record.slice(separator + 1)]);
	}
	return Object.fromEntries(entries);
}

type CaptureResult =
	| { ok: true; environment: NodeJS.ProcessEnv }
	| { ok: false; reason: DesktopEnvironmentFailureReason; child: ChildProcess | null };

async function captureLoginEnvironment(
	options: DesktopLaunchEnvironmentOptions,
	shell: string,
	environment: NodeJS.ProcessEnv,
): Promise<CaptureResult> {
	let child: ChildProcess;
	try {
		child = (options.spawnCapture ?? spawn)(shell, ["-l", "-c", ENVIRONMENT_CAPTURE_COMMAND], {
			env: environment,
			stdio: ["ignore", "ignore", "ignore", "pipe"],
			shell: false,
			detached: false,
		});
	} catch {
		return { ok: false, reason: "capture_failed", child: null };
	}
	return await new Promise<CaptureResult>((resolve) => {
		const channel = child.stdio[3];
		let complete = false;
		let size = 0;
		const chunks: Buffer[] = [];
		const finish = (result: CaptureResult): void => {
			if (complete) return;
			complete = true;
			clearTimeout(timer);
			resolve(result);
		};
		const fail = (reason: DesktopEnvironmentFailureReason): void => finish({ ok: false, reason, child });
		const timer = setTimeout(() => fail("capture_timeout"), options.captureTimeoutMs ?? 3_000);
		child.on("error", () => fail("capture_failed"));
		child.once("close", (code) => {
			if (complete) return;
			if (code !== 0) {
				fail("capture_failed");
				return;
			}
			const captured = parseEnvironment(Buffer.concat(chunks, size));
			if (captured) finish({ ok: true, environment: captured });
			else fail("capture_invalid");
		});
		if (!(channel instanceof Readable)) {
			fail("capture_failed");
			return;
		}
		channel.on("error", () => fail("capture_failed"));
		channel.on("data", (chunk: Buffer) => {
			if (complete) return;
			size += chunk.length;
			if (size > (options.maxCaptureBytes ?? 256 * 1024)) fail("capture_output_limit");
			else chunks.push(chunk);
		});
	});
}

async function stopCapture(
	options: DesktopLaunchEnvironmentOptions,
	child: ChildProcess,
): Promise<"not_needed" | "stopped" | "unconfirmed"> {
	if (!child.pid) return "not_needed";
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"unconfirmed">((resolve) => {
		cleanupTimer = setTimeout(() => resolve("unconfirmed"), options.cleanupTimeoutMs ?? 4_000);
	});
	const cleanup = (async (): Promise<"stopped" | "unconfirmed"> => {
		try {
			if (options.stopCaptureTree) return await options.stopCaptureTree(child);
			const outcome = await stopRuntimeOwnedProcessTrees({
				getRootPids: () => (child.pid ? [child.pid] : []),
				stopSessions: () => {},
				graceMs: 0,
				timeoutMs: 1_000,
			});
			return outcome.status;
		} catch {
			return "unconfirmed";
		}
	})();
	const result = await Promise.race([cleanup, deadline]);
	if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
	return result;
}

async function resolveLaunchEnvironment(
	options: DesktopLaunchEnvironmentOptions,
): Promise<DesktopLaunchEnvironmentResult> {
	const environment = sanitizeDesktopHelperEnvironment(options.inheritedEnvironment, options.nodePath);
	if (
		(options.platform ?? process.platform) !== "darwin" ||
		options.isolatedLab ||
		options.inheritedEnvironment.QUARTERDECK_AGENT_LAB === "1" ||
		options.mode === "inherit" ||
		((options.mode ?? "auto") === "auto" && hasTerminalEnvironment(options.inheritedEnvironment))
	)
		return { source: "inherited", environment };
	let shell: string | null;
	try {
		shell = options.getLoginShell ? options.getLoginShell() : userInfo().shell;
	} catch {
		shell = null;
	}
	if (!shell || !LOGIN_SHELLS.has(shell)) {
		return { source: "fallback", environment, failureReason: "unsupported_shell", processCleanup: "not_needed" };
	}
	const captured = await captureLoginEnvironment(options, shell, environment);
	if (captured.ok) {
		return {
			source: "login-shell",
			environment: sanitizeDesktopHelperEnvironment({ ...environment, ...captured.environment }, options.nodePath),
		};
	}
	return {
		source: "fallback",
		environment,
		failureReason: captured.reason,
		processCleanup: captured.child ? await stopCapture(options, captured.child) : "not_needed",
	};
}

/** Resolve once per application startup; retries and task launches reuse the settled environment. */
export function createDesktopLaunchEnvironmentResolver(
	options: DesktopLaunchEnvironmentOptions,
): () => Promise<DesktopLaunchEnvironmentResult> {
	const startupOptions = { ...options, inheritedEnvironment: { ...options.inheritedEnvironment } };
	let resolution: Promise<DesktopLaunchEnvironmentResult> | null = null;
	return () => {
		resolution ??= resolveLaunchEnvironment(startupOptions);
		return resolution;
	};
}
