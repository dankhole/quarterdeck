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

interface ReleasableStdio {
	destroy(): void;
}

interface ObservableChildProcess extends TimeoutTerminatedChildProcess {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly stdout?: ReleasableStdio | null;
	readonly stderr?: ReleasableStdio | null;
	once?(event: "exit", listener: () => void): unknown;
}

export interface ChildProcessTimeoutGuard {
	/** True once the timeout fired while the child was still running (see `armChildProcessTimeout`). */
	isTimedOut(): boolean;
	/** Call as soon as the owning exec callback fires, before reading `isTimedOut()`. */
	settle(): void;
}

export interface ArmChildProcessTimeoutOptions extends TerminateProcessForTimeoutOptions {
	/** How long the child's pipes may stay open after it exits before they are released. */
	closeGraceMs?: number;
	/** After timeout termination, how long before a still-running child is force-killed. */
	killGraceMs?: number;
	/**
	 * Called at most once when a timed-out child still has not let its owner
	 * settle after termination, force-kill, and pipe release (for example, an
	 * unreapable process). The owner must then settle as timed out.
	 */
	onAbandoned?: () => void;
}

/** Default wait for a child's pipes to close after it exits, before they are released. */
export const CHILD_PROCESS_CLOSE_GRACE_MS = 1_000;
/** Default wait between timeout termination and a force-kill. */
export const CHILD_PROCESS_KILL_GRACE_MS = 2_000;

/**
 * Arms a bounded timeout for a spawned child process and returns a guard the
 * owning exec callback consults. Every step is deferred past the poll phase, so
 * after an event-loop stall the child's pending exit, output, and 'close' are
 * observed before a stalled timer can misreport a finished command.
 *
 * - The timer fires while the child is still running: it is terminated (a tree
 *   on Windows) and reported as timed out, force-killed after `killGraceMs`, and
 *   abandoned through `onAbandoned` if it still cannot settle after the close
 *   grace that follows.
 * - The child exited in time: its own exit status stands, even if the timer
 *   fires before 'close'.
 * - After any exit, pipes still held open past `closeGraceMs` (a descendant
 *   inherited them) are released, so the owner settles with the child's result
 *   instead of waiting for the descendant.
 *
 * Call `settle()` from the exec callback as soon as it fires; `isTimedOut()` is
 * then authoritative.
 */
export function armChildProcessTimeout(
	child: ObservableChildProcess,
	timeoutMs: number,
	options: ArmChildProcessTimeoutOptions = {},
): ChildProcessTimeoutGuard {
	const closeGraceMs = options.closeGraceMs ?? CHILD_PROCESS_CLOSE_GRACE_MS;
	const killGraceMs = options.killGraceMs ?? CHILD_PROCESS_KILL_GRACE_MS;
	const timers = new Set<NodeJS.Timeout>();
	let settled = false;
	let timedOut = false;
	let pipeReleaseScheduled = false;

	const after = (delayMs: number, callback: () => void): void => {
		if (settled) return;
		const timer = setTimeout(() => {
			timers.delete(timer);
			// Deliberately not unref'd: an unref'd immediate has no scheduling
			// guarantee and can be starved while the loop blocks in poll on the
			// child's handles.
			setImmediate(() => {
				if (!settled) callback();
			});
		}, delayMs);
		timer.unref();
		timers.add(timer);
	};
	// Mocks may omit these fields; only a recorded status proves the child exited.
	const hasExited = (): boolean => typeof child.exitCode === "number" || typeof child.signalCode === "string";
	const releasePipes = (): void => {
		child.stdout?.destroy();
		child.stderr?.destroy();
	};
	const releasePipesAfterExit = (): void => {
		if (pipeReleaseScheduled) return;
		pipeReleaseScheduled = true;
		after(closeGraceMs, releasePipes);
	};

	child.once?.("exit", releasePipesAfterExit);
	if (hasExited()) releasePipesAfterExit();

	after(timeoutMs, () => {
		if (hasExited()) {
			// Finished in time; a stall only delayed observing it.
			releasePipesAfterExit();
			return;
		}
		timedOut = true;
		terminateProcessForTimeout(child, options);
		after(killGraceMs, () => {
			if (!hasExited()) child.kill("SIGKILL");
		});
		after(killGraceMs + closeGraceMs, () => {
			releasePipes();
			after(0, () => options.onAbandoned?.());
		});
	});

	return {
		isTimedOut: () => timedOut,
		settle: () => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
	};
}
