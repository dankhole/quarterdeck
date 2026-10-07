import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

import { terminateProcessTree } from "../../src/core";

import {
	type AgentLabBrowserProcessTree,
	findAgentLabBrowserProcessTree,
	mergeAgentLabBrowserProcessTrees,
	terminateAgentLabBrowserProcessTree,
} from "./browser-processes";

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_CLEANUP_MAX_PASSES = 5;
const BROWSER_QUIESCENCE_MS = 100;

interface BrowserCleanupDependencies {
	inspect: () => Promise<AgentLabBrowserProcessTree>;
	terminate: (tree: AgentLabBrowserProcessTree) => Promise<number[]>;
	wait: (milliseconds: number) => Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateUntilBrowserSessionIsQuiescent(
	initialTree: AgentLabBrowserProcessTree,
	dependencies: BrowserCleanupDependencies,
): Promise<number[]> {
	let pendingTree = initialTree;
	let remainingPids: number[] = [];
	for (let pass = 0; pass < BROWSER_CLEANUP_MAX_PASSES; pass += 1) {
		remainingPids = await dependencies.terminate(pendingTree);
		const verifiedTree = await dependencies.inspect();
		if (remainingPids.length > 0 || verifiedTree.processPids.length > 0) {
			pendingTree = mergeAgentLabBrowserProcessTrees({ rootPids: [], processPids: remainingPids }, verifiedTree);
			continue;
		}

		await dependencies.wait(BROWSER_QUIESCENCE_MS);
		const confirmationTree = await dependencies.inspect();
		if (confirmationTree.processPids.length === 0) return [];
		pendingTree = confirmationTree;
	}

	const finalTree = await dependencies.inspect();
	return [...new Set([...remainingPids, ...finalTree.processPids])].sort((left, right) => left - right);
}

interface NamedBrowserSnapshot {
	tree: AgentLabBrowserProcessTree;
	processes: Array<{ pid: number; parentPid: number }>;
}

interface NamedBrowserCloseDependencies {
	inspect: () => Promise<NamedBrowserSnapshot>;
	close: () => Promise<BrowserCloseResult>;
	wait: (milliseconds: number) => Promise<void>;
}

interface BrowserCloseResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error: Error | null;
}

export interface AgentLabBrowserCloseOptions {
	/** Never signal a PID or process group if the wrapper cannot confirm closure. */
	mode?: "named-session-only";
}

function parseStrictBrowserProcesses(stdout: string): Array<{ pid: number; parentPid: number; command: string }> {
	const lines = stdout.trim().split("\n").filter(Boolean);
	if (lines.length === 0 || lines.length > 10_000) throw new Error("Browser process inspection is unconfirmed.");
	const seen = new Set<number>();
	return lines.map((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
		const pid = Number(match?.[1]);
		const parentPid = Number(match?.[2]);
		if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || seen.has(pid)) {
			throw new Error("Browser process inspection is unconfirmed.");
		}
		seen.add(pid);
		return { pid, parentPid, command: match[3] ?? "" };
	});
}

async function inspectNamedBrowserSession(repoRoot: string, sessionName: string): Promise<NamedBrowserSnapshot> {
	// This option is used by the macOS desktop lane. Unsupported inspection fails closed.
	if (process.platform === "win32")
		throw new Error("Named browser close verification is unavailable on this platform.");
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			"/bin/ps",
			["-ax", "-o", "pid=,ppid=,command="],
			{ encoding: "utf8", timeout: BROWSER_CLOSE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(error, output) => {
				if (error) reject(new Error("Browser process inspection is unconfirmed."));
				else resolve(output);
			},
		);
	});
	const processes = parseStrictBrowserProcesses(stdout);
	const tree = await findAgentLabBrowserProcessTree(repoRoot, sessionName, {
		runProcessList: async () => ({ ok: true, stdout }),
	});
	return { tree, processes };
}

async function closeNamedSessionOnly(dependencies: NamedBrowserCloseDependencies): Promise<void> {
	let initial: NamedBrowserSnapshot | undefined;
	try {
		initial = await dependencies.inspect();
	} catch {
		// Still request ordinary wrapper closure, but never interpret a failed scan as empty.
	}
	const result = await dependencies.close();
	if (result.error || result.exitCode !== 0 || !initial || initial.tree.rootPids.length === 0) {
		throw new Error("Named browser session cleanup is unconfirmed; retain the synthetic fixture.");
	}
	const observedPids = new Set(initial.tree.processPids);
	let emptyScans = 0;
	for (let pass = 0; pass < BROWSER_CLEANUP_MAX_PASSES; pass += 1) {
		const snapshot = await dependencies.inspect();
		for (const pid of snapshot.tree.processPids) observedPids.add(pid);
		// Retain initially observed descendants after reparenting, and include any new children
		// of surviving observed processes. PID reuse conservatively prevents confirmation.
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const row of snapshot.processes) {
				if (observedPids.has(row.parentPid) && !observedPids.has(row.pid)) {
					observedPids.add(row.pid);
					expanded = true;
				}
			}
		}
		const remaining = snapshot.processes.some((row) => observedPids.has(row.pid));
		emptyScans = !remaining && snapshot.tree.processPids.length === 0 ? emptyScans + 1 : 0;
		if (emptyScans === 2) return;
		await dependencies.wait(BROWSER_QUIESCENCE_MS);
	}
	throw new Error("Named browser session cleanup is unconfirmed; retain the synthetic fixture.");
}

function runBrowserCloseCommand(
	createChild: () => ChildProcess,
	namedSessionOnly: boolean,
	timeoutMs = BROWSER_CLOSE_TIMEOUT_MS,
): Promise<BrowserCloseResult> {
	return new Promise((resolveClose) => {
		const child = createChild();
		let settled = false;
		const finish = (result: BrowserCloseResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveClose(result);
		};
		const timeout = setTimeout(() => {
			if (namedSessionOnly) {
				// The wrapper's signal handler itself invokes legacy tree termination. Do not
				// signal even our close-command child in this mode; retain the fixture instead.
				child.unref();
			} else if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGTERM", () => {});
			finish({ exitCode: null, signal: null, error: new Error("Browser close command timed out.") });
		}, timeoutMs);
		timeout.unref();
		child.once("error", (error) => finish({ exitCode: null, signal: null, error }));
		child.once("exit", (exitCode, signal) => finish({ exitCode, signal, error: null }));
	});
}

export async function closeAgentLabBrowserSession(
	repoRoot: string,
	sessionName: string,
	options: AgentLabBrowserCloseOptions = {},
): Promise<void> {
	const close = () =>
		runBrowserCloseCommand(
			() =>
				spawn(
					process.execPath,
					["--import", "tsx", join(repoRoot, "scripts", "agent-browser.ts"), `-s=${sessionName}`, "close"],
					{
						cwd: repoRoot,
						env: process.env,
						stdio: "ignore",
						windowsHide: true,
					},
				),
			options.mode === "named-session-only",
		);
	if (options.mode === "named-session-only") {
		return await closeNamedSessionOnly({
			inspect: () => inspectNamedBrowserSession(repoRoot, sessionName),
			close,
			wait,
		});
	}
	const inspectionErrors: Error[] = [];
	const inspect = async () => {
		try {
			return await findAgentLabBrowserProcessTree(repoRoot, sessionName);
		} catch (error) {
			inspectionErrors.push(error instanceof Error ? error : new Error(String(error)));
			return { rootPids: [], processPids: [] };
		}
	};
	const beforeClose = await inspect();
	const closeResult = await close();
	const afterClose = await inspect();
	const remainingPids = await terminateUntilBrowserSessionIsQuiescent(
		mergeAgentLabBrowserProcessTrees(beforeClose, afterClose),
		{
			inspect,
			terminate: terminateAgentLabBrowserProcessTree,
			wait,
		},
	);
	if (remainingPids.length > 0) {
		throw new Error(`Agent Lab browser cleanup left process IDs running: ${remainingPids.join(", ")}`);
	}
	if (inspectionErrors.length > 0) throw inspectionErrors[0];
	if (closeResult.error) throw closeResult.error;
	if (closeResult.exitCode !== 0) {
		throw new Error(`Browser close command exited with ${closeResult.signal ?? closeResult.exitCode ?? "unknown"}.`);
	}
}

export const _testing = {
	terminateUntilBrowserSessionIsQuiescent,
	closeNamedSessionOnly,
	runBrowserCloseCommand,
	parseStrictBrowserProcesses,
};
