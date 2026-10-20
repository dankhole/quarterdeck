import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

import { resolveNpmCommand } from "./npm-command.mjs";

function removeWindowsNamespacePrefix(path) {
	const normalizedSeparators = path.replaceAll("/", "\\");
	if (/^\\\\\?\\unc\\/iu.test(normalizedSeparators)) return `\\\\${normalizedSeparators.slice(8)}`;
	if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalizedSeparators)) return normalizedSeparators.slice(4);
	return path;
}

export function normalizeCheckoutPathForComparison(path, platform = process.platform) {
	if (platform === "win32") {
		return win32.resolve(removeWindowsNamespacePrefix(path)).toLowerCase();
	}
	return posix.resolve(path);
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export async function findActiveRuntimePids(stateHome) {
	const instancesRoot = join(stateHome, "diagnostics", "instances");
	const entries = await readdir(instancesRoot, { withFileTypes: true }).catch(() => []);
	const pids = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const descriptor = JSON.parse(await readFile(join(instancesRoot, entry.name, "runtime.json"), "utf8"));
			if (
				(descriptor.status === "starting" || descriptor.status === "ready") &&
				typeof descriptor.pid === "number" &&
				isProcessAlive(descriptor.pid)
			) {
				pids.push(descriptor.pid);
			}
		} catch {}
	}
	return [...new Set(pids)].sort((left, right) => left - right);
}

export async function resolveGlobalLinkedCheckout(command) {
	const invocation = command
		? { command, args: ["root", "-g"] }
		: resolveNpmCommand(["root", "-g"]);
	const result = spawnSync(invocation.command, invocation.args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
	if (result.status !== 0) return null;
	const packagePath = join(String(result.stdout).trim(), "quarterdeck");
	try {
		return await realpath(packagePath);
	} catch {
		return null;
	}
}

export async function assertLinkedRuntimeIsStopped(
	checkoutRoot,
	options = {},
) {
	const stateHome = options.stateHome ?? process.env.QUARTERDECK_STATE_HOME ?? join(homedir(), ".quarterdeck");
	const [activeRuntimePids, linkedCheckout, resolvedCheckout] = await Promise.all([
		options.activeRuntimePids ?? findActiveRuntimePids(stateHome),
		options.linkedCheckout === undefined ? resolveGlobalLinkedCheckout() : options.linkedCheckout,
		realpath(checkoutRoot),
	]);
	if (activeRuntimePids.length === 0 || !linkedCheckout) return;
	const resolvedLinkedCheckout = await realpath(linkedCheckout).catch(() => resolve(linkedCheckout));
	if (normalizeCheckoutPathForComparison(resolvedLinkedCheckout) !== normalizeCheckoutPathForComparison(resolvedCheckout)) {
		return;
	}
	throw new Error(
		`Quarterdeck is running from this linked checkout (PID${activeRuntimePids.length === 1 ? "" : "s"} ${activeRuntimePids.join(", ")}). Stop Quarterdeck before reinstalling dependencies, rebuilding, or relinking this checkout, then retry.`,
	);
}

