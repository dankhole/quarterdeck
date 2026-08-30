import { spawn } from "node:child_process";
import { Socket as NetSocket } from "node:net";
import { constants as osConstants } from "node:os";

import { terminateProcessTree } from "./process-tree.mjs";

// The runtime owns an eight-second Windows shutdown budget so it can exit before
// Windows' roughly ten-second console-close deadline. Parent wrappers need one
// extra second so their force-kill fallback cannot race the runtime's own timer.
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = process.platform === "win32" ? 9_000 : 11_000;

const HANDLED_SIGNALS =
	process.platform === "win32"
		? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
		: ["SIGINT", "SIGTERM", "SIGHUP"];

export function getExitCodeForSignal(signal) {
	if (!signal) {
		return 0;
	}
	if (signal === "SIGBREAK") return 149;
	return 128 + (osConstants.signals[signal] ?? 0);
}

function isNoSuchProcessError(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function signalProcess(child, signal) {
	if (child.exitCode !== null || child.pid == null) {
		return;
	}
	try {
		child.kill(signal);
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error;
		}
	}
}

function endChildStdin(child) {
	if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
		return false;
	}
	child.stdin.end();
	return true;
}

function signalProcessGroup(child, signal, terminateTree = terminateProcessTree) {
	if (child.exitCode !== null || child.pid == null) {
		return;
	}
	terminateTree(child.pid, signal, (error) => {
		if (error && !isNoSuchProcessError(error)) {
			signalProcess(child, signal);
		}
	});
}

export function launchManagedProcess(command, args, options = {}) {
	const configuredStdio = options.stdio ?? ["ignore", "inherit", "inherit"];
	const stdio =
		options.gracefulShutdownViaStdin === true && Array.isArray(configuredStdio)
			? ["pipe", ...configuredStdio.slice(1)]
			: configuredStdio;
	const child = spawn(command, args, {
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? process.env,
		stdio,
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	let shutdownSignal = null;
	let forceKillTimer = null;
	let exitInfo = null;

	const clearForceKillTimer = () => {
		if (forceKillTimer !== null) {
			clearTimeout(forceKillTimer);
			forceKillTimer = null;
		}
	};

	const exitPromise = new Promise((resolve) => {
		child.once("error", (error) => {
			clearForceKillTimer();
			exitInfo = { code: 1, signal: null, error };
			resolve(exitInfo);
		});
		child.once("close", (code, signal) => {
			clearForceKillTimer();
			exitInfo = { code, signal, error: null };
			resolve(exitInfo);
		});
	});

	const requestShutdown = (signal = "SIGTERM") => {
		if (shutdownSignal !== null) {
			return false;
		}
		shutdownSignal = signal;
		if (options.gracefulShutdownViaStdin !== true || !endChildStdin(child)) {
			signalProcessGroup(child, signal, options.terminateProcessTree);
		}
		forceKillTimer = setTimeout(() => {
			if (exitInfo !== null) {
				return;
			}
			options.onForceKill?.(signal);
			signalProcessGroup(child, "SIGKILL", options.terminateProcessTree);
		}, shutdownTimeoutMs);
		return true;
	};

	return {
		child,
		exitPromise,
		get exitInfo() {
			return exitInfo;
		},
		get shutdownSignal() {
			return shutdownSignal;
		},
		requestShutdown,
	};
}

export function installForwardedShutdownHandlers(requestShutdown) {
	const handlers = new Map();
	for (const signal of HANDLED_SIGNALS) {
		const handler = () => {
			requestShutdown(signal);
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	const handleParentDisconnect = () => {
		requestShutdown("SIGTERM");
	};
	const observesParentDisconnect = process.stdin instanceof NetSocket && !process.stdin.isTTY;
	if (observesParentDisconnect) {
		process.stdin.resume();
		process.stdin.on("end", handleParentDisconnect);
	}
	return () => {
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
		handlers.clear();
		if (observesParentDisconnect) {
			process.stdin.off("end", handleParentDisconnect);
		}
	};
}

export function resolveExitCode(exitInfo, fallbackSignal = null) {
	if (exitInfo?.error) {
		return 1;
	}
	if (typeof exitInfo?.code === "number") {
		return exitInfo.code;
	}
	if (exitInfo?.signal) {
		return getExitCodeForSignal(exitInfo.signal);
	}
	return getExitCodeForSignal(fallbackSignal);
}
