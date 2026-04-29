import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const HANDLED_SIGNALS =
	process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];

export function getExitCodeForSignal(signal) {
	if (!signal) {
		return 0;
	}
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

function signalProcessGroup(child, signal) {
	if (child.exitCode !== null || child.pid == null) {
		return;
	}
	if (process.platform === "win32") {
		signalProcess(child, signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (isNoSuchProcessError(error)) {
			return;
		}
		signalProcess(child, signal);
	}
}

export function launchManagedProcess(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? process.env,
		stdio: options.stdio ?? ["ignore", "inherit", "inherit"],
		detached: process.platform !== "win32",
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
		signalProcess(child, signal);
		forceKillTimer = setTimeout(() => {
			if (exitInfo !== null) {
				return;
			}
			options.onForceKill?.(signal);
			signalProcessGroup(child, "SIGKILL");
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
	return () => {
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
		handlers.clear();
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
