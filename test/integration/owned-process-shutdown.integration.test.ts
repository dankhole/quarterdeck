import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { stopRuntimeOwnedProcessTrees } from "../../src/server/owned-process-shutdown.js";
import { queryOwnedProcessSnapshot } from "../../src/server/owned-process-snapshot.js";
import { createTempDir } from "../utilities/temp-dir";

function startProcess(script: string): ChildProcess {
	return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

async function dispose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

async function waitForPidExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while ((await queryOwnedProcessSnapshot()).some((row) => row.pid === pid && !row.zombie)) {
		if (Date.now() >= deadline) throw new Error("Synthetic descendant remained live after cleanup.");
		await delay(10);
	}
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

	it.skipIf(process.platform !== "darwin")(
		"confirms a reparented BSD descendant after it exits",
		async () => {
			const sandbox = createTempDir("quarterdeck-owned-reparent-");
			const exitMarker = join(sandbox.path, "exit-descendant");
			const descendantScript = `
			const { existsSync } = require("node:fs");
			setInterval(() => {
				if (existsSync(process.argv[1])) process.exit(0);
			}, 10);
			process.send("ready");
			process.disconnect();
		`;
			const owned = startProcess(`
			const { spawn } = require("node:child_process");
			const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, ${JSON.stringify(exitMarker)}], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			child.once("message", () => console.log(child.pid));
			setInterval(() => {}, 1000);
		`);
			let descendantPid: number | undefined;
			try {
				if (!owned.stdout || !owned.pid) throw new Error("Synthetic process did not start.");
				const [ready] = await once(owned.stdout, "data");
				descendantPid = Number(String(ready).trim());
				expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
				const ownedPid = owned.pid;
				const parentExit = once(owned, "exit");
				let snapshots = 0;
				let observedReparenting = false;
				const signals: number[] = [];
				const result = await stopRuntimeOwnedProcessTrees({
					getRootPids: () => [ownedPid],
					stopSessions: () => {
						owned.kill("SIGTERM");
					},
					signal: (pid) => signals.push(pid),
					timeoutMs: 2_000,
					snapshot: async () => {
						if (++snapshots === 1) {
							const rows = await queryOwnedProcessSnapshot();
							expect(rows.find((row) => row.pid === descendantPid)?.parentPid).toBe(ownedPid);
							return rows;
						}
						if (observedReparenting) return await queryOwnedProcessSnapshot();
						await parentExit;
						const rows = await queryOwnedProcessSnapshot();
						const descendant = rows.find((row) => row.pid === descendantPid);
						if (!descendant || descendant.parentPid === ownedPid)
							throw new Error("Synthetic descendant did not reparent.");
						expect(descendant.preciseIdentity).toBe(false);
						observedReparenting = true;
						// Keep the real descendant alive until its changed ancestry was observed.
						await writeFile(exitMarker, "exit");
						return rows;
					},
				});
				expect(observedReparenting).toBe(true);
				expect(result).toEqual({ status: "stopped" });
				expect(signals).toEqual([]);
				expect((await queryOwnedProcessSnapshot()).some((row) => row.pid === descendantPid && !row.zombie)).toBe(
					false,
				);
			} finally {
				await writeFile(exitMarker, "exit");
				await dispose(owned);
				if (descendantPid !== undefined) await waitForPidExit(descendantPid);
				sandbox.cleanup();
			}
		},
		10_000,
	);
});
