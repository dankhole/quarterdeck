import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTempDir, withTemporaryHome } from "./temp-dir";

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

describe("withTemporaryHome", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each(["success", "rejection", "synchronous throw"] as const)(
		"isolates inherited state and restores the environment after %s",
		async (outcome) => {
			const original = createTempDir("quarterdeck-original-home-");
			vi.stubEnv("HOME", original.path);
			vi.stubEnv("USERPROFILE", original.path);
			vi.stubEnv("QUARTERDECK_STATE_HOME", join(original.path, "inherited-state"));
			const originalEnvironment = { ...process.env };
			const failure = new Error("fixture failure");
			let temporaryHome: string | undefined;
			try {
				const result = withTemporaryHome(() => {
					temporaryHome = process.env.HOME;
					expect(temporaryHome).toBeDefined();
					expect(temporaryHome).not.toBe(original.path);
					expect(process.env.USERPROFILE).toBe(temporaryHome);
					expect(process.env.QUARTERDECK_STATE_HOME).toBe(join(temporaryHome ?? "", ".quarterdeck"));
					if (outcome === "synchronous throw") throw failure;
					return outcome === "rejection" ? Promise.reject(failure) : Promise.resolve("done");
				});
				if (outcome === "success") await expect(result).resolves.toBe("done");
				else await expect(result).rejects.toBe(failure);
				expect(process.env).toEqual(originalEnvironment);
				expect(existsSync(temporaryHome ?? "")).toBe(false);
			} finally {
				original.cleanup();
			}
		},
	);

	it("removes the state override when the caller did not have one", async () => {
		vi.stubEnv("QUARTERDECK_STATE_HOME", undefined);
		await withTemporaryHome(async () => {
			expect(process.env.QUARTERDECK_STATE_HOME).toBe(join(process.env.HOME ?? "", ".quarterdeck"));
		});
		expect(process.env.QUARTERDECK_STATE_HOME).toBeUndefined();
	});
});
