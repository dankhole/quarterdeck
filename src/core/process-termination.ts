import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

import { resolveWindowsSystem32ExecutablePath } from "./windows-system-paths.js";

interface TimeoutTerminatedChildProcess {
	pid?: number;
	kill: (signal?: NodeJS.Signals | number) => boolean;
}

export type KillProcessTree = (pid: number, signal?: string | number, callback?: (error?: Error) => void) => void;

interface TerminateProcessForTimeoutOptions {
	platform?: NodeJS.Platform;
	killProcessTree?: KillProcessTree;
}

const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;

/** Terminate an exact Windows PID tree without shell or PATH resolution. */
export const terminateWindowsProcessTree: KillProcessTree = (pid, _signal, callback) => {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		callback?.(new Error("Windows process-tree termination requires a positive integer PID."));
		return;
	}
	execFile(
		resolveWindowsSystem32ExecutablePath("taskkill.exe"),
		["/pid", String(pid), "/T", "/F"],
		{ timeout: WINDOWS_TASKKILL_TIMEOUT_MS, windowsHide: true },
		(error: ExecFileException | null) => callback?.(error ?? undefined),
	);
};

/**
 * Terminates a managed process tree without a shell lookup. Windows delegates
 * to absolute System32 `taskkill.exe`; POSIX launchers use detached process
 * groups and fall back to the exact root when no matching group exists.
 */
export const terminateProcessTree: KillProcessTree = (pid, signal = "SIGTERM", callback) => {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		callback?.(new Error("Process-tree termination requires a positive integer PID."));
		return;
	}
	if (process.platform === "win32") {
		terminateWindowsProcessTree(pid, signal, callback);
		return;
	}

	const normalizedSignal = signal as NodeJS.Signals | number;
	try {
		process.kill(-pid, normalizedSignal);
		callback?.();
		return;
	} catch {
		// A non-detached child has no process group whose id matches its pid.
	}
	try {
		process.kill(pid, normalizedSignal);
		callback?.();
	} catch (error) {
		callback?.(error instanceof Error ? error : new Error(String(error)));
	}
};

/**
 * Terminate a timed-out child and, on Windows, its command-shim descendants.
 * Windows agent CLIs commonly launch through `.cmd` wrappers, so killing only
 * the wrapper can leave the real process alive.
 */
export function terminateProcessForTimeout(
	child: TimeoutTerminatedChildProcess,
	options: TerminateProcessForTimeoutOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		const pid = typeof child.pid === "number" ? child.pid : 0;
		if (pid > 0) {
			try {
				(options.killProcessTree ?? terminateWindowsProcessTree)(pid, "SIGTERM", (error) => {
					// Preserve the root PID until taskkill has captured the tree. If tree
					// termination fails, fall back to Node's exact-root kill.
					if (error) child.kill();
				});
			} catch {
				child.kill();
			}
			return;
		}
		child.kill();
		return;
	}

	child.kill("SIGTERM");
}
