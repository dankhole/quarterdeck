import { spawn } from "node:child_process";
import { join } from "node:path";

import treeKill from "tree-kill";

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

export async function closeAgentLabBrowserSession(repoRoot: string, sessionName: string): Promise<void> {
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
	const browserEntrypoint = join(repoRoot, "scripts", "agent-browser.ts");
	const closeResult = await new Promise<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		error: Error | null;
	}>((resolveClose) => {
		const child = spawn(process.execPath, ["--import", "tsx", browserEntrypoint, `-s=${sessionName}`, "close"], {
			cwd: repoRoot,
			env: process.env,
			stdio: "ignore",
		});
		let settled = false;
		const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveClose(result);
		};
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) treeKill(child.pid, "SIGTERM", () => {});
			finish({ exitCode: null, signal: "SIGTERM", error: new Error("Browser close command timed out.") });
		}, BROWSER_CLOSE_TIMEOUT_MS);
		timeout.unref();
		child.once("error", (error) => finish({ exitCode: null, signal: null, error }));
		child.once("exit", (exitCode, signal) => finish({ exitCode, signal, error: null }));
	});
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
};
