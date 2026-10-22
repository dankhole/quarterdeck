import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));
const fileSystemMocks = vi.hoisted(() => ({
	writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	fileSystemMocks.writeFile.mockImplementation(actual.writeFile);
	return {
		...actual,
		writeFile: fileSystemMocks.writeFile,
	};
});

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { setRuntimeDiagnosticLogSink } from "../../src/core/runtime-logger";
import {
	cleanupStaleLockAndTempFiles,
	IN_PROCESS_LOCK_SLOW_WAIT_MS,
	InProcessLockReentryError,
	LockedFileSystem,
} from "../../src/fs";

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
		fileSystemMocks.writeFile.mockClear();
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

	it("deduplicates case aliases before acquiring Windows locks", async () => {
		const tempDir = createTempDir("quarterdeck-locked-fs-windows-alias-");
		try {
			const lockedFileSystem = new LockedFileSystem("win32");

			await lockedFileSystem.withLocks(
				[
					{ path: join(tempDir.path, "README.md"), type: "file" },
					{ path: join(tempDir.path, "readme.md"), type: "file" },
				],
				async () => {},
			);

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	describe("in-process owner serialization", () => {
		const heldLockfiles = new Set<string>();
		beforeEach(() => {
			heldLockfiles.clear();
			// An exclusive filesystem lock whose retry budget is already exhausted:
			// any overlapping acquisition fails exactly like proper-lockfile's ELOCKED.
			lockfileMocks.lock.mockImplementation(async (_path: string, options: { lockfilePath: string }) => {
				const key = options.lockfilePath.toLowerCase();
				if (heldLockfiles.has(key)) {
					throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
				}
				heldLockfiles.add(key);
				return async () => {
					heldLockfiles.delete(key);
				};
			});
		});

		async function holdThenRequest(
			lockedFileSystem: LockedFileSystem,
			tempPath: string,
			serializeInProcess: boolean,
		): Promise<{ owner: Promise<void>; queued: Promise<string>; release: () => void }> {
			let release = () => {};
			const blocker = new Promise<void>((resolve) => {
				release = resolve;
			});
			const request = (lockfileName: string) => ({
				path: join(tempPath, "project"),
				type: "directory" as const,
				lockfilePath: join(tempPath, lockfileName),
				serializeInProcess,
			});
			const owner = lockedFileSystem.withLock(request("Project.lock"), () => blocker);
			await vi.waitFor(() => expect(lockfileMocks.lock).toHaveBeenCalledTimes(1));
			// Windows spells one lockfile with different case; both owners must share a turn.
			const queued = lockedFileSystem.withLock(request("PROJECT.LOCK"), async () => "queued result");
			return { owner, queued, release };
		}

		it("queues same-process owners of a serialized Windows lock instead of exhausting its retry budget", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-in-process-");
			try {
				const { owner, queued, release } = await holdThenRequest(new LockedFileSystem("win32"), tempDir.path, true);
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
				release();
				await owner;
				await expect(queued).resolves.toBe("queued result");
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(2);
				expect(heldLockfiles.size).toBe(0);
			} finally {
				tempDir.cleanup();
			}
		});

		const serialized = (tempPath: string, lockfileName: string) => ({
			path: join(tempPath, "project"),
			type: "directory" as const,
			lockfilePath: join(tempPath, lockfileName),
			serializeInProcess: true,
		});
		const lockfileNames = () =>
			lockfileMocks.lock.mock.calls.map(([, options]) =>
				basename((options as { lockfilePath: string }).lockfilePath),
			);

		it("advances the queue after the head loses to another process or its operation fails", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-queue-failure-");
			try {
				const lockedFileSystem = new LockedFileSystem("win32");
				let exhaustBudget = () => {};
				const otherProcessHolds = new Promise<void>((resolve) => {
					exhaustBudget = resolve;
				});
				lockfileMocks.lock.mockImplementationOnce(async () => {
					await otherProcessHolds;
					throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
				});
				const head = lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => "unreachable");
				const headFailure = expect(head).rejects.toThrow("Lock file is already being held");
				await vi.waitFor(() => expect(lockfileMocks.lock).toHaveBeenCalledTimes(1));
				const failing = lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => {
					throw new Error("Synthetic operation failure");
				});
				const failingFailure = expect(failing).rejects.toThrow("Synthetic operation failure");
				const queued = lockedFileSystem.withLock(serialized(tempDir.path, "P.LOCK"), async () => "queued result");
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
				exhaustBudget();
				await headFailure;
				await failingFailure;
				await expect(queued).resolves.toBe("queued result");
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(3);
				expect(heldLockfiles.size).toBe(0);
			} finally {
				tempDir.cleanup();
			}
		});

		it("takes a serialized member's turn in sorted multi-lock order and releases in reverse", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-multi-");
			try {
				const lockedFileSystem = new LockedFileSystem();
				const released: string[] = [];
				lockfileMocks.lock.mockImplementation(async (_path: string, options: { lockfilePath: string }) => {
					return async () => {
						released.push(basename(options.lockfilePath));
					};
				});
				let finish = () => {};
				const blocker = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const multi = lockedFileSystem.withLocks(
					[
						serialized(tempDir.path, "b.lock"),
						{ path: join(tempDir.path, "a.json"), lockfilePath: join(tempDir.path, "a.lock") },
					],
					() => blocker,
				);
				await vi.waitFor(() => expect(lockfileMocks.lock).toHaveBeenCalledTimes(2));
				expect(lockfileNames()).toEqual(["a.lock", "b.lock"]);
				const single = lockedFileSystem.withLock(serialized(tempDir.path, "b.lock"), async () => "single result");
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(2);
				finish();
				await multi;
				await expect(single).resolves.toBe("single result");
				expect(released).toEqual(["b.lock", "a.lock", "b.lock"]);
			} finally {
				tempDir.cleanup();
			}
		});

		it("rejects re-entry of a held serialized lock while allowing sequential, detached, and lock-free nested work", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-reentry-");
			try {
				const lockedFileSystem = new LockedFileSystem("win32");
				let detached: Promise<string> | null = null;
				await lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => {
					await expect(
						lockedFileSystem.withLock(serialized(tempDir.path, "P.LOCK"), async () => "nested"),
					).rejects.toBeInstanceOf(InProcessLockReentryError);
					await expect(
						lockedFileSystem.withLocks(
							[{ path: join(tempDir.path, "other.json") }, serialized(tempDir.path, "p.lock")],
							async () => "nested multi",
						),
					).rejects.toBeInstanceOf(InProcessLockReentryError);
					await lockedFileSystem.writeTextFileAtomic(join(tempDir.path, "state.json"), "{}", { lock: null });
					await lockedFileSystem.withLock(serialized(tempDir.path, "other.lock"), async () => {});
					detached = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() =>
						lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => "detached result"),
					);
				});
				await expect(detached).resolves.toBe("detached result");
				await expect(
					lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => "sequential result"),
				).resolves.toBe("sequential result");
				expect(heldLockfiles.size).toBe(0);
			} finally {
				tempDir.cleanup();
			}
		});

		it("reports one content-free warning for a slow queued wait without failing it", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-slow-wait-");
			const records: Array<{ level: string; tag: string; message: string; data?: unknown }> = [];
			setRuntimeDiagnosticLogSink({ recordLog: (record) => records.push(record) });
			try {
				const lockedFileSystem = new LockedFileSystem();
				let release = () => {};
				const blocker = new Promise<void>((resolve) => {
					release = resolve;
				});
				const owner = lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), () => blocker);
				await vi.waitFor(() => expect(lockfileMocks.lock).toHaveBeenCalledTimes(1));
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
				const queued = lockedFileSystem.withLock(serialized(tempDir.path, "p.lock"), async () => "queued result");
				await vi.advanceTimersByTimeAsync(IN_PROCESS_LOCK_SLOW_WAIT_MS - 1);
				expect(records).toEqual([]);
				await vi.advanceTimersByTimeAsync(IN_PROCESS_LOCK_SLOW_WAIT_MS * 3);
				expect(records).toEqual([
					{
						level: "warn",
						tag: "locked-file-system",
						message: "in-process lock wait is slow",
						data: { lock: "p.lock", waitMs: IN_PROCESS_LOCK_SLOW_WAIT_MS, queueDepth: 2 },
					},
				]);
				vi.useRealTimers();
				release();
				await owner;
				await expect(queued).resolves.toBe("queued result");
				expect(records).toHaveLength(1);
			} finally {
				vi.useRealTimers();
				setRuntimeDiagnosticLogSink(null);
				tempDir.cleanup();
			}
		});

		it("leaves unserialized locks to the filesystem retry budget", async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-unserialized-");
			try {
				const { owner, queued, release } = await holdThenRequest(
					new LockedFileSystem("win32"),
					tempDir.path,
					false,
				);
				await expect(queued).rejects.toThrow("Lock file is already being held");
				release();
				await owner;
			} finally {
				tempDir.cleanup();
			}
		});
	});

	it.skipIf(process.platform === "win32")(
		"applies the requested mode when creating the atomic temporary file",
		async () => {
			const tempDir = createTempDir("quarterdeck-locked-fs-mode-");
			try {
				const filePath = join(tempDir.path, "private-state.json");
				const lockedFileSystem = new LockedFileSystem();

				await lockedFileSystem.writeTextFileAtomic(filePath, "private", { mode: 0o600 });

				const tempWrite = fileSystemMocks.writeFile.mock.calls.find(
					([path]) => typeof path === "string" && path.startsWith(`${filePath}.tmp.`),
				);
				expect(tempWrite?.[2]).toEqual({ encoding: "utf8", mode: 0o600 });
			} finally {
				tempDir.cleanup();
			}
		},
	);

	it("omits unsupported POSIX modes when creating the atomic temporary file on Windows", async () => {
		const tempDir = createTempDir("quarterdeck-locked-fs-windows-mode-");
		try {
			const filePath = join(tempDir.path, "private-state.json");
			const lockedFileSystem = new LockedFileSystem("win32");

			await lockedFileSystem.writeTextFileAtomic(filePath, "private", { mode: 0o600 });

			const tempWrite = fileSystemMocks.writeFile.mock.calls.find(
				([path]) => typeof path === "string" && path.startsWith(`${filePath}.tmp.`),
			);
			expect(tempWrite?.[2]).toEqual({ encoding: "utf8" });
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
