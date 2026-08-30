import { execFile } from "node:child_process";
import { win32 } from "node:path";

const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;

function getWindowsEnvironmentValue(env, key) {
	const directValue = env[key];
	if (typeof directValue === "string") {
		return directValue;
	}

	const normalizedKey = key.toLowerCase();
	for (const [entryKey, entryValue] of Object.entries(env)) {
		if (entryKey.toLowerCase() === normalizedKey && typeof entryValue === "string") {
			return entryValue;
		}
	}
	return undefined;
}

function resolveWindowsSystemRoot(env) {
	const configuredRoot =
		getWindowsEnvironmentValue(env, "SystemRoot")?.trim() ||
		getWindowsEnvironmentValue(env, "WINDIR")?.trim();
	return configuredRoot && win32.isAbsolute(configuredRoot) && !/["\r\n]/u.test(configuredRoot)
		? configuredRoot
		: "C:\\Windows";
}

export function resolveWindowsTaskkillPath(env = process.env) {
	return win32.join(resolveWindowsSystemRoot(env), "System32", "taskkill.exe");
}

/**
 * Terminates a process tree without a shell or PATH lookup. POSIX callers are
 * expected to launch managed children in detached process groups.
 */
export function terminateProcessTree(pid, signal = "SIGTERM", callback, dependencies = {}) {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		callback?.(new Error("Process-tree termination requires a positive integer PID."));
		return;
	}

	const platform = dependencies.platform ?? process.platform;
	if (platform === "win32") {
		const execFileImpl = dependencies.execFile ?? execFile;
		execFileImpl(
			resolveWindowsTaskkillPath(dependencies.env ?? process.env),
			["/pid", String(pid), "/T", "/F"],
			{ timeout: WINDOWS_TASKKILL_TIMEOUT_MS, windowsHide: true },
			(error) => callback?.(error ?? undefined),
		);
		return;
	}

	const killImpl = dependencies.kill ?? process.kill;
	try {
		killImpl(-pid, signal);
		callback?.();
		return;
	} catch {}

	try {
		killImpl(pid, signal);
		callback?.();
	} catch (error) {
		callback?.(error instanceof Error ? error : new Error(String(error)));
	}
}
