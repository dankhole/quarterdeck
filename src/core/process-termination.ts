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

interface ObservableChildProcess extends TimeoutTerminatedChildProcess {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
}

export interface ChildProcessTimeoutGuard {
	/** True once a real timeout has been confirmed (see `armChildProcessTimeout`). */
	isTimedOut(): boolean;
	/** Call as soon as the owning exec callback fires, before reading `isTimedOut()`. */
	settle(): void;
}

export interface ArmChildProcessTimeoutOptions extends TerminateProcessForTimeoutOptions {
	/** Bounded wait for a lagging 'close' once the child has already exited. */
	closeGraceMs?: number;
}

/** Default bounded wait for 'close' to arrive after a child has already exited. */
export const CHILD_PROCESS_CLOSE_GRACE_MS = 1_000;

/**
 * Arms a bounded timeout for a spawned child process and returns a guard the
 * owning exec callback consults. `execFile`'s callback fires on 'close', which
 * waits for stdio to drain after 'exit' — under an event-loop stall that drain
 * can lag a stalled timer by multiple loop turns, so a timer firing is not itself
 * proof of a hang. When the timer fires: a child still running is terminated and
 * reported as timed out immediately (a hung process, or one that traps the
 * signal and exits late). A child that already exited gets a short grace period
 * for 'close' to arrive before it is treated as timed out and terminated too
 * (covers a descendant still holding stdio open). Call `settle()` from the exec
 * callback as soon as it fires; `isTimedOut()` is then authoritative.
 */
export function armChildProcessTimeout(
	child: ObservableChildProcess,
	timeoutMs: number,
	options: ArmChildProcessTimeoutOptions = {},
): ChildProcessTimeoutGuard {
	let settled = false;
	let timedOut = false;
	let graceTimer: NodeJS.Timeout | null = null;

	function markTimedOutAndTerminate(): void {
		if (settled) return;
		timedOut = true;
		terminateProcessForTimeout(child, options);
	}

	const timeout = setTimeout(() => {
		// Defer past the poll phase: 'exit' can be observed before the stdio drain
		// that 'close' (and so the exec callback) waits for. Deliberately not
		// unref'd: an unref'd immediate has no scheduling guarantee and can be
		// starved for seconds while the loop blocks in poll on the child's handles.
		setImmediate(() => {
			if (settled) return;
			if (child.exitCode !== null || child.signalCode !== null) {
				graceTimer = setTimeout(markTimedOutAndTerminate, options.closeGraceMs ?? CHILD_PROCESS_CLOSE_GRACE_MS);
				graceTimer.unref();
				return;
			}
			markTimedOutAndTerminate();
		});
	}, timeoutMs);
	timeout.unref();

	return {
		isTimedOut: () => timedOut,
		settle: () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (graceTimer) clearTimeout(graceTimer);
		},
	};
}
