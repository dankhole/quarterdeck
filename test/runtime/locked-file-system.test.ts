import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { cleanupStaleLockAndTempFiles, LockedFileSystem } from "../../src/fs";

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	it("omits onCompromised when no handler is provided", async () => {
		const tempDir = createTempDir("quarterdeck-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options).not.toHaveProperty("onCompromised");
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("forwards onCompromised when a handler is provided", async () => {
		const tempDir = createTempDir("quarterdeck-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});
});

describe("cleanupStaleLockAndTempFiles", () => {
	/** Backdate an entry's mtime to 30 seconds ago so it's clearly stale. */
	function makeStale(path: string): void {
		const oldTime = new Date(Date.now() - 30_000);
		utimesSync(path, oldTime, oldTime);
	}

	it("removes stale .lock directories and .tmp. files while preserving normal files", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			// Create normal files that should survive cleanup
			writeFileSync(join(tempDir.path, "index.json"), "{}");
			writeFileSync(join(tempDir.path, "config.json"), "{}");

			// Create stale lock directories (proper-lockfile uses directories)
			const locks = ["index.json.lock", "project-abc.lock", ".projects.lock"];
			for (const name of locks) {
				const p = join(tempDir.path, name);
				mkdirSync(p);
				makeStale(p);
			}

			// Create orphaned temp files from interrupted atomic writes
			const temps = ["index.json.tmp.12345.1700000000.abc-uuid", "board.json.tmp.99999.1700000001.def-uuid"];
			for (const name of temps) {
				const p = join(tempDir.path, name);
				writeFileSync(p, "partial");
				makeStale(p);
			}

			await cleanupStaleLockAndTempFiles([tempDir.path]);

			const remaining = readdirSync(tempDir.path).sort();
			expect(remaining).toEqual(["config.json", "index.json"]);
		} finally {
			tempDir.cleanup();
		}
	});

	it("scans multiple directories", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			const dirA = join(tempDir.path, "a");
			const dirB = join(tempDir.path, "b");
			mkdirSync(dirA);
			mkdirSync(dirB);

			const lockPath = join(dirA, "config.json.lock");
			mkdirSync(lockPath);
			makeStale(lockPath);

			const tempPath = join(dirB, "state.json.tmp.1.2.3");
			writeFileSync(tempPath, "partial");
			makeStale(tempPath);

			await cleanupStaleLockAndTempFiles([dirA, dirB]);

			expect(readdirSync(dirA)).toEqual([]);
			expect(readdirSync(dirB)).toEqual([]);
		} finally {
			tempDir.cleanup();
		}
	});

	it("skips directories that do not exist", async () => {
		await expect(cleanupStaleLockAndTempFiles(["/nonexistent/path/that/does/not/exist"])).resolves.toBeUndefined();
	});

	it("preserves subdirectories that are not lock artifacts", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			const projectDir = join(tempDir.path, "my-project");
			mkdirSync(projectDir);
			writeFileSync(join(projectDir, "board.json"), "{}");

			// Lock artifact sibling to the project dir
			const lockPath = join(tempDir.path, "my-project.lock");
			mkdirSync(lockPath);
			makeStale(lockPath);

			await cleanupStaleLockAndTempFiles([tempDir.path]);

			const remaining = readdirSync(tempDir.path);
			expect(remaining).toEqual(["my-project"]);
			expect(readFileSync(join(projectDir, "board.json"), "utf8")).toBe("{}");
		} finally {
			tempDir.cleanup();
		}
	});

	it("removes stale artifacts inside project subdirectories when included in directories list", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			// Simulate a projects root with per-project subdirectories
			const projectA = join(tempDir.path, "project-abc");
			const projectB = join(tempDir.path, "project-def");
			mkdirSync(projectA);
			mkdirSync(projectB);

			// Normal files inside project dirs should survive
			writeFileSync(join(projectA, "board.json"), "{}");
			writeFileSync(join(projectB, "board.json"), "{}");

			// Stale temp files inside project dirs (the common case after a crash)
			const staleTemp1 = join(projectA, "board.json.tmp.12345.1700000000.abc-uuid");
			const staleTemp2 = join(projectB, "board.json.tmp.99999.1700000001.def-uuid");
			writeFileSync(staleTemp1, "partial");
			writeFileSync(staleTemp2, "partial");
			makeStale(staleTemp1);
			makeStale(staleTemp2);

			// Pass project subdirectories explicitly (as the caller in cli.ts would)
			await cleanupStaleLockAndTempFiles([tempDir.path, projectA, projectB]);

			// Project directories themselves should survive
			expect(readdirSync(tempDir.path).sort()).toEqual(["project-abc", "project-def"]);
			// Stale temp files inside should be removed; board.json should remain
			expect(readdirSync(projectA)).toEqual(["board.json"]);
			expect(readdirSync(projectB)).toEqual(["board.json"]);
		} finally {
			tempDir.cleanup();
		}
	});

	it("invokes the warn callback for each removed artifact", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			const staleLock = join(tempDir.path, "stale.lock");
			const staleTemp = join(tempDir.path, "data.json.tmp.1.2.uuid");
			mkdirSync(staleLock);
			writeFileSync(staleTemp, "partial");
			makeStale(staleLock);
			makeStale(staleTemp);

			const warnings: string[] = [];
			await cleanupStaleLockAndTempFiles([tempDir.path], 10_000, (message) => {
				warnings.push(message);
			});

			expect(warnings).toHaveLength(2);
			const joined = warnings.join("\n");
			expect(joined).toContain("stale.lock");
			expect(joined).toContain("data.json.tmp.1.2.uuid");
		} finally {
			tempDir.cleanup();
		}
	});

	it("does not invoke the warn callback when no artifacts are removed", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			writeFileSync(join(tempDir.path, "board.json"), "{}");

			const warnings: string[] = [];
			await cleanupStaleLockAndTempFiles([tempDir.path], 10_000, (message) => {
				warnings.push(message);
			});

			expect(warnings).toHaveLength(0);
		} finally {
			tempDir.cleanup();
		}
	});

	it("preserves lock entries whose mtime is within the stale threshold", async () => {
		const tempDir = createTempDir("quarterdeck-lock-cleanup-");
		try {
			const staleLock = join(tempDir.path, "stale.lock");
			const freshLock = join(tempDir.path, "fresh.lock");
			const staleTemp = join(tempDir.path, "data.json.tmp.1.2.uuid");
			const freshTemp = join(tempDir.path, "data.json.tmp.3.4.uuid");

			mkdirSync(staleLock);
			mkdirSync(freshLock);
			writeFileSync(staleTemp, "partial");
			writeFileSync(freshTemp, "partial");

			// Backdate the stale entries to 30 seconds ago
			const oldTime = new Date(Date.now() - 30_000);
			utimesSync(staleLock, oldTime, oldTime);
			utimesSync(staleTemp, oldTime, oldTime);

			// Leave fresh entries at their default mtime (just created = now)

			await cleanupStaleLockAndTempFiles([tempDir.path], 10_000);

			const remaining = readdirSync(tempDir.path).sort();
			expect(remaining).toEqual(["data.json.tmp.3.4.uuid", "fresh.lock"]);
		} finally {
			tempDir.cleanup();
		}
	});
});
