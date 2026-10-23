import { type Dir, Dirent } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitUtils from "../../src/workdir/git-utils";

const mocks = vi.hoisted(() => ({ opendir: vi.fn(), runGit: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof FsPromises>()),
	opendir: mocks.opendir,
}));
vi.mock("../../src/workdir/git-utils", async (importOriginal) => ({
	...(await importOriginal<typeof GitUtils>()),
	runGit: mocks.runGit,
}));

import { BULK_FS_CONCURRENCY, limitBulkFsCall } from "../../src/fs/bulk-fs-limit";
import { invalidateWorkdirFileListCache, listAllWorkdirFiles } from "../../src/workdir/search-workdir-files";
import { WorkdirFileTreeLimitError, walkWorkdirFileTree } from "../../src/workdir/workdir-file-tree";

const root = resolve("synthetic-tree");
let active = 0;
let peak = 0;
let openHandles = 0;
let operations: string[] = [];
let graph = new Map<string, Dirent[]>();
let failRead = false;

async function track<Result>(operation: string, call: () => Result): Promise<Result> {
	operations.push(operation);
	active += 1;
	peak = Math.max(peak, active);
	try {
		await setImmediate();
		return call();
	} finally {
		active -= 1;
	}
}

function entry(name: string, directory = false): Dirent {
	return Object.assign(new Dirent(), { name, isDirectory: () => directory });
}

beforeEach(() => {
	mocks.runGit.mockReset().mockResolvedValue({ ok: true, stdout: "" });
	active = 0;
	peak = 0;
	openHandles = 0;
	operations = [];
	graph = new Map();
	failRead = false;
	mocks.opendir.mockReset().mockImplementation((path: string) =>
		track(`open:${path}`, () => {
			const entries = graph.get(path);
			if (!entries) throw new Error("ENOENT");
			openHandles += 1;
			let index = 0;
			return {
				read: () =>
					track(`read:${path}`, () => {
						if (failRead) throw new Error("read failed");
						return entries[index++] ?? null;
					}),
				close: () =>
					track(`close:${path}`, () => {
						openHandles -= 1;
					}),
			} as unknown as Dir;
		}),
	);
});

afterEach(() => {
	invalidateWorkdirFileListCache(root);
	vi.useRealTimers();
});

describe("walkWorkdirFileTree", () => {
	it("shares the bulk filesystem operation cap across roots and other bulk callers", async () => {
		const roots = [0, 1, 2, 3].map((index) => join(root, String(index)));
		for (const cwd of roots) {
			graph.set(cwd, [entry("empty", true), entry("file.txt")]);
			graph.set(join(cwd, "empty"), []);
		}
		const trees = await Promise.all([
			...roots.map((cwd) => walkWorkdirFileTree(cwd)),
			limitBulkFsCall(() => track("other-bulk-call", () => undefined)),
		]);
		expect(trees.slice(0, roots.length)).toEqual(roots.map(() => ({ files: ["file.txt"], directories: ["empty"] })));
		expect(peak).toBe(BULK_FS_CONCURRENCY);
		expect(active).toBe(0);
		expect(openHandles).toBe(0);
		expect(operations.filter((operation) => operation.startsWith("open:"))).toHaveLength(8);
		expect(operations.filter((operation) => operation.startsWith("close:"))).toHaveLength(8);
		expect(mocks.opendir).toHaveBeenCalledWith(roots[0], { bufferSize: 32 });
	});

	it("prunes only safe ignored directories and keeps ignored individual files and symlink leaves", async () => {
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "./\0dist/\0nested/cache/\0.env\0../outside/\0/absolute/\0" });
		graph.set(root, [
			entry("dist", true),
			entry("nested", true),
			entry(".env"),
			entry("link"),
			entry("node_modules", true),
		]);
		graph.set(join(root, "nested"), [entry("cache", true), entry("visible.txt")]);
		expect(await walkWorkdirFileTree(root)).toEqual({
			files: [".env", "link", "nested/visible.txt"],
			directories: ["nested"],
		});
		expect(mocks.opendir.mock.calls.map(([path]) => path)).toEqual([root, join(root, "nested")]);
		expect(mocks.runGit).toHaveBeenCalledWith(
			root,
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
			{ trimStdout: false, timeoutClass: "default" },
		);
	});

	it("uses bounded filesystem fallback only for a definite non-repository answer", async () => {
		mocks.runGit.mockResolvedValue({
			ok: false,
			stdout: "visible/\0",
			stderr: "fatal: not a git repository",
			failureKind: "command_failed",
			exitCode: 128,
		});
		graph.set(root, [entry("visible", true)]);
		graph.set(join(root, "visible"), [entry("file.txt")]);
		expect(await walkWorkdirFileTree(root)).toEqual({ files: ["visible/file.txt"], directories: ["visible"] });
	});

	it.each([
		{ failureKind: "timed_out", timedOut: true, exitCode: -1 },
		{ failureKind: "queue_timed_out", exitCode: -1 },
		{ failureKind: "spawn_unavailable", errorCode: "ENOENT", exitCode: -1 },
		{ failureKind: "command_failed", errorCode: "ENOMEM", exitCode: -1 },
		{ failureKind: "command_failed", stderr: "fatal: invalid configuration", exitCode: 128 },
	])("rejects failed ignore discovery without an unpruned walk: $failureKind $errorCode", async (failure) => {
		mocks.runGit.mockResolvedValue({ ok: false, stdout: "visible/\0", ...failure });
		await expect(walkWorkdirFileTree(root)).rejects.toThrow("retry");
		expect(mocks.opendir).not.toHaveBeenCalled();
	});

	it.each(["discovery", "verification"])(
		"caches %s output-limit failures until expiry or invalidation",
		async (phase) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(0);
			const queueFailure = () => {
				if (phase === "verification") mocks.runGit.mockResolvedValueOnce({ ok: true, stdout: "dist/\0" });
				mocks.runGit.mockResolvedValueOnce({
					ok: false,
					failureKind: "command_failed",
					errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					exitCode: -1,
				});
			};
			const commandsPerLoad = phase === "verification" ? 2 : 1;
			queueFailure();
			await expect(listAllWorkdirFiles(root)).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
			vi.setSystemTime(5_001);
			await expect(listAllWorkdirFiles(root)).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
			expect(mocks.runGit).toHaveBeenCalledTimes(commandsPerLoad);
			expect(mocks.opendir).not.toHaveBeenCalled();

			invalidateWorkdirFileListCache(root);
			queueFailure();
			await expect(listAllWorkdirFiles(root)).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
			expect(mocks.runGit).toHaveBeenCalledTimes(commandsPerLoad * 2);
			vi.setSystemTime(35_001);
			graph.set(root, [entry("a.txt")]);
			expect(await listAllWorkdirFiles(root)).toEqual(["a.txt"]);
			expect(mocks.runGit).toHaveBeenCalledTimes(commandsPerLoad * 2 + 1);
		},
	);

	it("allows an immediate listing retry after transient ignore discovery failure", async () => {
		mocks.runGit
			.mockResolvedValueOnce({ ok: false, timedOut: true, failureKind: "timed_out", exitCode: -1 })
			.mockResolvedValue({ ok: true, stdout: "" });
		graph.set(root, [entry("a.txt")]);
		await expect(listAllWorkdirFiles(root)).rejects.toThrow("retry");
		expect(mocks.opendir).not.toHaveBeenCalled();
		expect(await listAllWorkdirFiles(root)).toEqual(["a.txt"]);
		expect(mocks.runGit).toHaveBeenCalledTimes(2);
	});

	it("bypasses Git entirely in folder mode", async () => {
		mocks.runGit.mockRejectedValue(new Error("Git must not run"));
		graph.set(root, [entry("dist", true)]);
		graph.set(join(root, "dist"), [entry("file.txt")]);
		expect(await walkWorkdirFileTree(root, { useGitIgnores: false })).toEqual({
			files: ["dist/file.txt"],
			directories: ["dist"],
		});
		expect(mocks.runGit).not.toHaveBeenCalled();
	});

	it("keeps directories containing only individually ignored files when check-ignore returns no matches", async () => {
		mocks.runGit
			.mockResolvedValueOnce({ ok: true, stdout: "logs/\0logs/a.log\0" })
			.mockResolvedValueOnce({ ok: false, exitCode: 1, failureKind: "command_failed", stdout: "" });
		graph.set(root, [entry("logs", true)]);
		graph.set(join(root, "logs"), [entry("a.log")]);
		expect(await walkWorkdirFileTree(root)).toEqual({ files: ["logs/a.log"], directories: ["logs"] });
		expect(mocks.runGit).toHaveBeenLastCalledWith(root, ["check-ignore", "-z", "--stdin"], {
			trimStdout: false,
			timeoutClass: "default",
			stdin: "./logs/\0",
		});
	});

	it("rejects failed directory verification rather than trusting candidate directories", async () => {
		mocks.runGit.mockResolvedValueOnce({ ok: true, stdout: "dist/\0" }).mockResolvedValueOnce({
			ok: false,
			failureKind: "timed_out",
			timedOut: true,
			exitCode: -1,
			stdout: "dist/\0",
		});
		await expect(walkWorkdirFileTree(root)).rejects.toThrow("verification did not complete; retry");
		expect(mocks.opendir).not.toHaveBeenCalled();
	});

	it("fails at the combined file/directory ceiling, closes handles and stops pending work", async () => {
		graph.set(root, [entry("pending", true), entry("a"), entry("b"), entry("never-read")]);
		graph.set(join(root, "pending"), [entry("never-opened")]);
		const listing = walkWorkdirFileTree(root, { maxEntries: 2 });
		await expect(listing).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
		await expect(listing).rejects.toThrow("2 file and directory entry limit");
		expect(openHandles).toBe(0);
		expect(operations).toEqual([`open:${root}`, `read:${root}`, `read:${root}`, `read:${root}`, `close:${root}`]);
		await Promise.resolve();
		expect(active).toBe(0);
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
	});

	it("accepts an exactly full tree and counts empty directories toward the ceiling", async () => {
		graph.set(root, [entry("empty", true), entry("a")]);
		graph.set(join(root, "empty"), []);
		expect(await walkWorkdirFileTree(root, { maxEntries: 2 })).toEqual({ files: ["a"], directories: ["empty"] });
	});

	it("bounds visited skipped entries separately from visible output", async () => {
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "ignored/\0" });
		graph.set(
			root,
			[".git", ".hg", ".svn", "node_modules", "ignored"].map((name) => entry(name, true)),
		);
		const listing = walkWorkdirFileTree(root, { maxEntries: 2 });
		await expect(listing).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
		await expect(listing).rejects.toThrow("4 visited entry limit");
		expect(openHandles).toBe(0);
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
	});

	it("bounds all ignore records, not just directory output, before opening the filesystem", async () => {
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "a\0b\0c\0" });
		const listing = walkWorkdirFileTree(root, { maxEntries: 2 });
		await expect(listing).rejects.toBeInstanceOf(WorkdirFileTreeLimitError);
		await expect(listing).rejects.toThrow("ignore discovery exceeds the 2 path limit");
		expect(mocks.opendir).not.toHaveBeenCalled();
	});

	it("rejects incomplete successful Git output instead of pruning from a partial snapshot", async () => {
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "dist/" });
		await expect(walkWorkdirFileTree(root)).rejects.toThrow("incomplete Git output");
		expect(mocks.opendir).not.toHaveBeenCalled();
	});

	it("closes the current handle on a read error", async () => {
		graph.set(root, [entry("a")]);
		failRead = true;
		await expect(walkWorkdirFileTree(root)).rejects.toThrow("read failed");
		expect(openHandles).toBe(0);
		expect(active).toBe(0);
	});
});
