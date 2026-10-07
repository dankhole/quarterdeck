import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
	collectOwnedDesktopProcesses,
	listDesktopProcesses,
	stopOwnedDesktopProcesses,
} from "../../scripts/agent-lab/desktop-processes";
import type { DesktopLabProcess } from "../../scripts/agent-lab/desktop-types";

describe.skipIf(process.platform !== "darwin")("desktop lab real-process cleanup", () => {
	it("stops a synthetic parent/child tree while leaving another process alive", async () => {
		const parent = spawn(
			process.execPath,
			[
				"-e",
				"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
			],
			{ stdio: "ignore" },
		);
		const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		let owned: DesktopLabProcess[] = [];
		try {
			if (!parent.pid || !unrelated.pid) throw new Error("Synthetic process did not receive a PID.");
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				owned = collectOwnedDesktopProcesses(await listDesktopProcesses(), [parent.pid]);
				if (owned.length === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(owned).toHaveLength(2);
			expect(await stopOwnedDesktopProcesses(owned)).toEqual([]);
			expect(collectOwnedDesktopProcesses(await listDesktopProcesses(), [], owned)).toEqual([]);
			expect(() => process.kill(unrelated.pid as number, 0)).not.toThrow();
		} finally {
			await stopOwnedDesktopProcesses(owned);
			parent.kill("SIGKILL");
			unrelated.kill("SIGKILL");
		}
	});
});
