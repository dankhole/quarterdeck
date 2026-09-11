import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createTempDir } from "./temp-dir";

describe("createTempDir", () => {
	it("creates and cleans up a temporary directory", () => {
		const { path, cleanup } = createTempDir("quarterdeck-unit-");

		expect(existsSync(path)).toBe(true);
		cleanup();
		expect(existsSync(path)).toBe(false);
	});

	it("awaits asynchronous directory removal and accepts repeated cleanup", async () => {
		const { path, cleanupAsync } = createTempDir("quarterdeck-unit-async-");
		expect(existsSync(path)).toBe(true);
		await cleanupAsync();
		expect(existsSync(path)).toBe(false);
		await cleanupAsync();
	});

	it.runIf(process.platform === "win32")(
		"lets a pending process release a Windows cwd lock during cleanup",
		async () => {
			const { path, cleanupAsync } = createTempDir("quarterdeck-unit-cwd-lock-");
			const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
				cwd: path,
				stdio: ["pipe", "ignore", "ignore"],
				windowsHide: true,
			});
			const closed = once(child, "close");
			let release: NodeJS.Timeout | undefined;
			try {
				await once(child, "spawn");
				// Windows cannot remove another process's cwd. Cleanup must yield so
				// this callback and the native process-handle close can release it.
				release = setTimeout(() => child.stdin?.end(), 50);
				await cleanupAsync();
				expect(existsSync(path)).toBe(false);
			} finally {
				clearTimeout(release);
				child.stdin?.end();
				await closed;
				await cleanupAsync();
			}
		},
	);
});
