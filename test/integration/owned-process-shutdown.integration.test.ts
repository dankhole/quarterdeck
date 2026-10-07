import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopRuntimeOwnedProcessTrees } from "../../src/server/owned-process-shutdown.js";
import { queryOwnedProcessSnapshot } from "../../src/server/owned-process-snapshot.js";

function startProcess(script: string): ChildProcess {
	return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

async function dispose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

describe("exact-owned synthetic process shutdown", () => {
	it("confirms owned parent/child exit while preserving an unrelated identical executable", async () => {
		const unrelated = startProcess("console.log('ready'); setInterval(() => {}, 1000)");
		const owned = startProcess(
			"const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\"console.log('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>console.log('ready'));setInterval(()=>{},1000)",
		);
		try {
			if (!unrelated.stdout || !owned.stdout || !owned.pid) throw new Error("Synthetic process did not start.");
			await Promise.all([once(unrelated.stdout, "data"), once(owned.stdout, "data")]);
			const ownedPid = owned.pid;
			const before = await queryOwnedProcessSnapshot();
			const descendant = before.find((entry) => entry.parentPid === ownedPid);
			expect(descendant).toBeDefined();
			const result = await stopRuntimeOwnedProcessTrees({
				getRootPids: () => [ownedPid],
				stopSessions: () => {},
				graceMs: 100,
				timeoutMs: 2_000,
			});
			expect(result).toEqual({ status: "stopped" });
			const after = await queryOwnedProcessSnapshot();
			expect(after.some((entry) => entry.pid === ownedPid && !entry.zombie)).toBe(false);
			expect(after.some((entry) => entry.pid === descendant?.pid && !entry.zombie)).toBe(false);
			expect(after.some((entry) => entry.pid === unrelated.pid && !entry.zombie)).toBe(true);
		} finally {
			await Promise.all([dispose(owned), dispose(unrelated)]);
		}
	}, 10_000);

	it("escalates an exact-owned root that ignores TERM", async () => {
		const owned = startProcess("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)");
		try {
			if (!owned.stdout || !owned.pid) throw new Error("Synthetic process did not start.");
			const ownedPid = owned.pid;
			await once(owned.stdout, "data");
			expect(
				await stopRuntimeOwnedProcessTrees({
					getRootPids: () => [ownedPid],
					stopSessions: () => {},
					graceMs: 25,
					timeoutMs: 2_000,
				}),
			).toEqual({ status: "stopped" });
		} finally {
			await dispose(owned);
		}
	}, 10_000);
});
