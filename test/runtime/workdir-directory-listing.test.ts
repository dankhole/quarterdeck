import { type Dir, Dirent } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitUtils from "../../src/workdir/git-utils";

const mocks = vi.hoisted(() => ({ opendir: vi.fn(), realpath: vi.fn(), runGit: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof FsPromises>()),
	opendir: mocks.opendir,
	realpath: mocks.realpath,
}));
vi.mock("../../src/workdir/git-utils", async (importOriginal) => ({
	...(await importOriginal<typeof GitUtils>()),
	runGit: mocks.runGit,
}));

import { BULK_FS_CONCURRENCY, limitBulkFsCall } from "../../src/fs/bulk-fs-limit";
import { invalidateWorkdirFileListCache } from "../../src/workdir/search-workdir-files";
import {
	getWorkdirDirectoryListingSnapshot,
	listWorkdirDirectoryPage,
	WORKDIR_DIRECTORY_FIRST_PAGE_REUSE_MS,
	WORKDIR_DIRECTORY_MAX_OPEN_HANDLES,
	WORKDIR_DIRECTORY_PAGE_LIMITS,
	WORKDIR_DIRECTORY_SESSION_IDLE_MS,
	type WorkdirDirectoryListingRequest,
} from "../../src/workdir/workdir-directory-listing";
import { readWorkdirDirectoryPage } from "../../src/workdir/workdir-directory-page";
import type { WorkdirDirectoryChildSource } from "../../src/workdir/workdir-directory-source";

const root = resolve("synthetic-listing-root");
let active = 0;
let peak = 0;
let openHandles = 0;
let peakOpenHandles = 0;
let operations: string[] = [];
let graph = new Map<string, Dirent[]>();
let failRead = false;
let readGate: Promise<void> | null = null;

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

function files(count: number, prefix = "file"): Dirent[] {
	return Array.from({ length: count }, (_, index) => entry(`${prefix}-${String(index).padStart(5, "0")}`));
}

function request(
	directory = "",
	options: Partial<WorkdirDirectoryListingRequest> = {},
): WorkdirDirectoryListingRequest {
	return { cwd: root, directory, showExcluded: false, useGitIgnores: false, ref: null, ...options };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await setImmediate();
}

beforeEach(() => {
	mocks.runGit.mockReset().mockResolvedValue({ ok: false, exitCode: 1, failureKind: "command_failed", stdout: "" });
	mocks.realpath.mockReset().mockImplementation(async (path: string) => path);
	active = 0;
	peak = 0;
	openHandles = 0;
	peakOpenHandles = 0;
	operations = [];
	graph = new Map();
	failRead = false;
	readGate = null;
	mocks.opendir.mockReset().mockImplementation((path: string) =>
		track(`open:${path}`, () => {
			const entries = graph.get(path);
			if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			openHandles += 1;
			peakOpenHandles = Math.max(peakOpenHandles, openHandles);
			let index = 0;
			let closed = false;
			return {
				read: async () => {
					if (readGate) await readGate;
					return track(`read:${path}`, () => {
						if (closed) throw new Error("read after close");
						if (failRead) throw new Error("read failed");
						return entries[index++] ?? null;
					});
				},
				close: () =>
					track(`close:${path}`, () => {
						if (closed) throw new Error("double close");
						closed = true;
						openHandles -= 1;
					}),
			} as unknown as Dir;
		}),
	);
});

afterEach(async () => {
	readGate = null;
	invalidateWorkdirFileListCache(root);
	for (let index = 0; index < 64; index += 1) invalidateWorkdirFileListCache(join(root, String(index)));
	await settle();
	vi.useRealTimers();
	expect(openHandles).toBe(0);
	expect(getWorkdirDirectoryListingSnapshot().openHandleSlots).toBe(0);
});

async function readAllPages(listingRequest: WorkdirDirectoryListingRequest) {
	const pages = [await listWorkdirDirectoryPage(listingRequest)];
	while (pages.at(-1)?.nextCursor) {
		pages.push(await listWorkdirDirectoryPage({ ...listingRequest, cursor: pages.at(-1)?.nextCursor ?? undefined }));
	}
	return pages;
}

describe("listWorkdirDirectoryPage", () => {
	it("opens only the requested directory of a tree far larger than the old 20k ceiling", async () => {
		graph = new Proxy(new Map<string, Dirent[]>(), {
			get(target, property) {
				if (property === "get") {
					// Every directory has 30 subdirectories and 30 files: millions of descendants.
					return () => [...Array.from({ length: 30 }, (_, index) => entry(`dir-${index}`, true)), ...files(30)];
				}
				return Reflect.get(target, property);
			},
		});
		const page = await listWorkdirDirectoryPage(request());
		expect(page.directories).toHaveLength(30);
		expect(page.files).toHaveLength(30);
		expect(page.nextCursor).toBeNull();
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
		expect(mocks.opendir).toHaveBeenCalledWith(root, { bufferSize: 32 });

		const child = await listWorkdirDirectoryPage(request("dir-3/dir-7"));
		expect(child.files[0]).toBe("dir-3/dir-7/file-00000");
		expect(mocks.opendir).toHaveBeenCalledTimes(2);
		expect(mocks.realpath).toHaveBeenCalledWith(join(root, "dir-3/dir-7"));
	});

	it("paginates a wide directory completely without duplicates and closes the handle on exhaustion", async () => {
		graph.set(root, files(1_234));
		const pages = await readAllPages(request());
		expect(pages.map((page) => page.files.length)).toEqual([500, 500, 234]);
		const all = pages.flatMap((page) => page.files);
		expect(new Set(all).size).toBe(1_234);
		expect(new Set(pages.map((page) => page.snapshotId)).size).toBe(1);
		expect(pages.at(-1)?.nextCursor).toBeNull();
		expect(openHandles).toBe(0);
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
	});

	it("bounds examined entries per page and returns empty continuation pages when filters hide a chunk", async () => {
		graph.set(root, [
			...Array.from({ length: 1_100 }, (_, index) => entry(`ignored-${index}`, true)),
			entry("visible.txt"),
		]);
		const stdinSizes: number[] = [];
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[], options: { stdin: string }) => {
			expect(args).toEqual(["check-ignore", "-z", "--stdin"]);
			stdinSizes.push(options.stdin.split("\0").length - 1);
			return { ok: true, stdout: options.stdin };
		});
		const pages = await readAllPages(request("", { useGitIgnores: true }));
		expect(pages.map((page) => [page.files, page.directories, page.hiddenCount])).toEqual([
			[[], [], 500],
			[[], [], 500],
			[["visible.txt"], [], 100],
		]);
		expect(pages[0]?.nextCursor).not.toBeNull();
		expect(stdinSizes).toEqual([500, 500, 100]);
	});

	it("checks ignore status only for the page's own child directories, never a recursive Git discovery", async () => {
		graph.set(root, [entry("dist", true), entry("src", true), entry(".git", true), entry("node_modules", true)]);
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "./dist\0" });
		const page = await listWorkdirDirectoryPage(request("", { useGitIgnores: true }));
		expect(page).toMatchObject({ directories: ["src"], hiddenCount: 3 });
		expect(mocks.runGit).toHaveBeenCalledTimes(1);
		expect(mocks.runGit).toHaveBeenCalledWith(
			root,
			["check-ignore", "-z", "--stdin"],
			expect.objectContaining({ trimStdout: false, timeoutClass: "default", stdin: "./dist\0./src\0" }),
		);
		// Untranslated so definite answers are recognized in every locale.
		expect(mocks.runGit.mock.calls[0]?.[2].env).toMatchObject({ LC_ALL: "C" });
	});

	it("admits ref preflight before Git work and shares identical in-flight ref resolutions", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "rev-parse") {
				await gate;
				return { ok: true, stdout: "a".repeat(40) };
			}
			return { ok: true, stdout: "100644 blob abc\tREADME.md\0" };
		});
		const results = Array.from({ length: 70 }, () =>
			listWorkdirDirectoryPage(request("", { ref: "HEAD" })).catch((error) => error),
		);
		await settle();
		expect(getWorkdirDirectoryListingSnapshot().pendingPageOperations).toBe(64);
		expect(mocks.runGit.mock.calls.filter(([, args]) => args[0] === "rev-parse")).toHaveLength(1);
		release();
		const settled = await Promise.all(results);
		expect(settled.filter((result) => (result as { code?: string }).code === "busy")).toHaveLength(6);
		expect(
			settled.filter((result) => !(result instanceof Error)).every((page) => page.files[0] === "README.md"),
		).toBe(true);
		expect(getWorkdirDirectoryListingSnapshot().pendingPageOperations).toBe(0);
	});

	it("re-resolves a moving ref when invalidation retires the pending first page", async () => {
		const treeA = "a".repeat(40);
		const treeB = "b".repeat(40);
		let currentTree = treeA;
		let releaseListing: () => void = () => undefined;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "rev-parse") return { ok: true, stdout: currentTree };
			const tree = args.at(-1);
			if (tree === treeA) await listingGate;
			return { ok: true, stdout: `100644 blob abc\t${tree === treeA ? "from-a" : "from-b"}\0` };
		});
		const pending = listWorkdirDirectoryPage(request("", { ref: "HEAD" }));
		await settle();
		currentTree = treeB;
		invalidateWorkdirFileListCache(root);
		releaseListing();
		expect((await pending).files).toEqual(["from-b"]);
		expect(mocks.runGit.mock.calls.filter(([, args]) => args[0] === "rev-parse")).toHaveLength(2);
	});

	it("re-resolves a ref whose resolution was in flight during invalidation", async () => {
		let currentTree = "a".repeat(40);
		let releaseResolution: () => void = () => undefined;
		const resolutionGate = new Promise<void>((resolve) => {
			releaseResolution = resolve;
		});
		let resolutions = 0;
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "rev-parse") {
				const tree = currentTree;
				if (++resolutions === 1) await resolutionGate;
				return { ok: true, stdout: tree };
			}
			return { ok: true, stdout: `100644 blob abc\t${args.at(-1)?.[0] === "a" ? "from-a" : "from-b"}\0` };
		});
		const pending = listWorkdirDirectoryPage(request("", { ref: "HEAD" }));
		await settle();
		currentTree = "b".repeat(40);
		invalidateWorkdirFileListCache(root);
		releaseResolution();
		expect((await pending).files).toEqual(["from-b"]);
		expect(resolutions).toBe(2);
	});

	it.each([
		[33_000, 0],
		[31_800, 0],
		[31_000, 1],
	])(
		"rejects %i long names after %i pages rather than returning an invalid cursor",
		async (count, successfulPages) => {
			const names = Array.from(
				{ length: count },
				(_, index) => `${String(index).padStart(6, "0")}${"n".repeat(249)}`,
			);
			mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) =>
				args[0] === "rev-parse"
					? { ok: true, stdout: "a".repeat(40) }
					: { ok: true, stdout: names.map((name) => `100644 blob abc\t${name}\0`).join("") },
			);
			let cursor: string | undefined;
			for (let index = 0; index < successfulPages; index += 1) {
				const page = await listWorkdirDirectoryPage(request("", { ref: "HEAD", cursor }));
				expect(page.nextCursor).not.toBeNull();
				cursor = page.nextCursor ?? undefined;
			}
			await expect(listWorkdirDirectoryPage(request("", { ref: "HEAD", cursor }))).rejects.toThrow("too large");
			await settle();
			expect(getWorkdirDirectoryListingSnapshot()).toMatchObject({ sessions: 0, retainedBytes: 0 });
		},
	);

	it("evicts idle buffered snapshots to admit a new one under the retained-byte ceiling", async () => {
		// Each ~10.2 MB estimate fits alone; two together exceed 16 MiB.
		const names = Array.from({ length: 19_500 }, (_, index) => `${String(index).padStart(6, "0")}${"n".repeat(249)}`);
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) =>
			args[0] === "rev-parse"
				? { ok: true, stdout: (args.at(-1) === "one:./" ? "a" : "b").repeat(40) }
				: { ok: true, stdout: names.map((name) => `100644 blob abc\t${name}\0`).join("") },
		);
		const first = await listWorkdirDirectoryPage(request("", { ref: "one" }));
		const second = await listWorkdirDirectoryPage(request("", { ref: "two" }));
		await settle();
		const snapshot = getWorkdirDirectoryListingSnapshot();
		expect(snapshot.sessions).toBe(1);
		expect(snapshot.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
		const restarted = await listWorkdirDirectoryPage(
			request("", { ref: "one", cursor: first.nextCursor ?? undefined }),
		);
		expect(restarted.snapshotId).not.toBe(first.snapshotId);
		expect(second.nextCursor).not.toBeNull();
	});

	it.each(["rev-parse", "ls-tree"])("releases ref listing work after %s queue admission expires", async (stage) => {
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[], options: GitUtils.RunGitOptions) => {
			expect(options.priority).toBe("foreground");
			if (args[0] === stage) return { ok: false, exitCode: -1, failureKind: "queue_timed_out", stdout: "" };
			return { ok: true, stdout: "a".repeat(40) };
		});
		await expect(listWorkdirDirectoryPage(request("", { ref: "HEAD" }))).rejects.toThrow("retry");
		await settle();
		expect(getWorkdirDirectoryListingSnapshot()).toMatchObject({ openHandleSlots: 0, pendingPageOperations: 0 });
		expect(mocks.opendir).not.toHaveBeenCalled();
	});

	it("bypasses Git entirely in folder mode", async () => {
		mocks.runGit.mockRejectedValue(new Error("Git must not run"));
		graph.set(root, [entry("dist", true), entry("file.txt")]);
		expect(await listWorkdirDirectoryPage(request())).toMatchObject({ files: ["file.txt"], directories: ["dist"] });
		expect(mocks.runGit).not.toHaveBeenCalled();
	});

	it.each([
		{ failureKind: "timed_out", timedOut: true, exitCode: -1 },
		{ failureKind: "command_failed", stderr: "fatal: invalid configuration", exitCode: 128 },
	])("fails the page rather than showing an unpruned listing when Git fails: $failureKind", async (failure) => {
		graph.set(root, [entry("dist", true)]);
		mocks.runGit.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "", ...failure });
		await expect(listWorkdirDirectoryPage(request("", { useGitIgnores: true }))).rejects.toThrow("retry");
		await settle();
		expect(openHandles).toBe(0);
		mocks.runGit.mockResolvedValue({ ok: true, stdout: "./dist\0" });
		expect(await listWorkdirDirectoryPage(request("", { useGitIgnores: true }))).toMatchObject({
			directories: [],
			hiddenCount: 1,
		});
	});

	it("retains candidates inside a registered submodule but still rejects other definite Git failures", async () => {
		graph.set(join(root, "sub/src"), [entry("cache", true)]);
		mocks.runGit.mockResolvedValueOnce({
			ok: false,
			stdout: "",
			stderr: "fatal: Pathspec './sub/src/cache' is in submodule 'sub'",
			failureKind: "command_failed",
			exitCode: 128,
		});
		expect(await listWorkdirDirectoryPage(request("sub/src", { useGitIgnores: true }))).toMatchObject({
			directories: ["sub/src/cache"],
			hiddenCount: 0,
		});
	});

	it("treats a definite non-repository answer as no ignore rules", async () => {
		graph.set(root, [entry("dist", true)]);
		mocks.runGit.mockResolvedValue({
			ok: false,
			stdout: "",
			stderr: "fatal: not a git repository",
			failureKind: "command_failed",
			exitCode: 128,
		});
		expect(await listWorkdirDirectoryPage(request("", { useGitIgnores: true }))).toMatchObject({
			directories: ["dist"],
		});
	});

	it("shares one enumeration between concurrent duplicate first-page and cursor requests and replays pages", async () => {
		graph.set(root, files(1_200));
		const [first, duplicate] = await Promise.all([
			listWorkdirDirectoryPage(request()),
			listWorkdirDirectoryPage(request()),
		]);
		expect(duplicate).toBe(first);
		const cursor = first.nextCursor ?? undefined;
		const [second, secondDuplicate] = await Promise.all([
			listWorkdirDirectoryPage(request("", { cursor })),
			listWorkdirDirectoryPage(request("", { cursor })),
		]);
		expect(secondDuplicate).toBe(second);
		expect(second.files[0]).toBe("file-00500");
		expect(await listWorkdirDirectoryPage(request("", { cursor }))).toBe(second);
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
		expect(operations.filter((operation) => operation.startsWith("read:"))).toHaveLength(1_000);
	});

	it("rejects malformed and cross-scope cursors without crossing directories, modes, or roots", async () => {
		graph.set(root, files(600));
		graph.set(join(root, "other"), files(600));
		graph.set(join(root, "0"), files(600));
		const { nextCursor } = await listWorkdirDirectoryPage(request());
		const cursor = nextCursor ?? undefined;
		for (const mismatched of [
			request("other", { cursor }),
			request("", { cursor, showExcluded: true }),
			request("", { cursor, useGitIgnores: true }),
			request("", { cursor, cwd: join(root, "0") }),
		]) {
			await expect(listWorkdirDirectoryPage(mismatched)).rejects.toMatchObject({ code: "invalid_cursor" });
		}
		for (const malformed of ["not-a-cursor", `${cursor?.split(".")[0]}.0`, `${cursor}x`, "a".repeat(22)]) {
			await expect(listWorkdirDirectoryPage(request("", { cursor: malformed }))).rejects.toMatchObject({
				code: "invalid_cursor",
			});
		}
		// The original cursor still continues its own snapshot.
		expect((await listWorkdirDirectoryPage(request("", { cursor }))).files[0]).toBe("file-00500");
	});

	it("restarts unknown, skipped-ahead, and evicted cursors with a new snapshot instead of appending", async () => {
		graph.set(root, files(1_600));
		const first = await listWorkdirDirectoryPage(request());
		const unknown = await listWorkdirDirectoryPage(request("", { cursor: `${"A".repeat(22)}.1` }));
		expect(unknown).toBe(first);

		const token = first.nextCursor?.split(".")[0];
		const skipped = await listWorkdirDirectoryPage(request("", { cursor: `${token}.3` }));
		expect(skipped.snapshotId).not.toBe(first.snapshotId);
		expect(skipped.files[0]).toBe("file-00000");
		// The skipped-ahead snapshot was retired and its handle closed.
		await expect(listWorkdirDirectoryPage(request("", { cursor: first.nextCursor ?? undefined }))).resolves.toBe(
			skipped,
		);
	});

	it("reuses an unchanged first page for polling within the reuse window, then starts a new snapshot", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(0);
		graph.set(root, files(700));
		const first = await listWorkdirDirectoryPage(request());
		vi.setSystemTime(WORKDIR_DIRECTORY_FIRST_PAGE_REUSE_MS - 1);
		expect(await listWorkdirDirectoryPage(request())).toBe(first);
		vi.setSystemTime(WORKDIR_DIRECTORY_FIRST_PAGE_REUSE_MS);
		const replacement = await listWorkdirDirectoryPage(request());
		expect(replacement.snapshotId).not.toBe(first.snapshotId);
		// The older snapshot still continues for an in-flight "load more".
		const continued = await listWorkdirDirectoryPage(request("", { cursor: first.nextCursor ?? undefined }));
		expect(continued).toMatchObject({ snapshotId: first.snapshotId, nextCursor: null });
		expect(continued.files).toHaveLength(200);
	});

	it("closes idle sessions and restarts their cursors with a new snapshot", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(0);
		graph.set(root, files(700));
		const first = await listWorkdirDirectoryPage(request());
		expect(openHandles).toBe(1);
		vi.advanceTimersByTime(WORKDIR_DIRECTORY_SESSION_IDLE_MS + 5_000);
		await settle();
		expect(openHandles).toBe(0);
		expect(getWorkdirDirectoryListingSnapshot().sessions).toBe(0);
		const restarted = await listWorkdirDirectoryPage(request("", { cursor: first.nextCursor ?? undefined }));
		expect(restarted.snapshotId).not.toBe(first.snapshotId);
		expect(restarted.files[0]).toBe("file-00000");
	});

	it("invalidation closes handles and keeps late reads from an old snapshot out of the replacement", async () => {
		graph.set(root, files(700));
		const first = await listWorkdirDirectoryPage(request());
		let release: () => void = () => undefined;
		readGate = new Promise((resolve) => {
			release = resolve;
		});
		const inFlight = listWorkdirDirectoryPage(request("", { cursor: first.nextCursor ?? undefined }));
		await settle();
		invalidateWorkdirFileListCache(root);
		graph.set(root, files(3, "after"));
		readGate = null;
		release();
		// The invalidated continuation restarts from the current directory contents.
		const restarted = await inFlight;
		expect(restarted.files).toEqual(["after-00000", "after-00001", "after-00002"]);
		expect(restarted.snapshotId).not.toBe(first.snapshotId);
		expect(await listWorkdirDirectoryPage(request())).toBe(restarted);
		await settle();
		expect(openHandles).toBe(0);
		expect(operations.filter((operation) => operation === `close:${root}`)).toHaveLength(2);
	});

	it("bounds open directory handles across many continued listings and the shared filesystem gate", async () => {
		const directories = Array.from({ length: WORKDIR_DIRECTORY_MAX_OPEN_HANDLES + 8 }, (_, index) => `d${index}`);
		for (const directory of directories) graph.set(join(root, directory), files(600));
		const pages = await Promise.all([
			...directories.map((directory) => listWorkdirDirectoryPage(request(directory))),
			limitBulkFsCall(() => track("other-bulk-call", () => undefined)),
		]);
		expect(peakOpenHandles).toBeLessThanOrEqual(WORKDIR_DIRECTORY_MAX_OPEN_HANDLES);
		expect(peak).toBe(BULK_FS_CONCURRENCY);
		expect(getWorkdirDirectoryListingSnapshot().openHandleSlots).toBeLessThanOrEqual(
			WORKDIR_DIRECTORY_MAX_OPEN_HANDLES,
		);
		// Evicted snapshots restart; the most recent continue.
		const firstPage = pages[0] as Awaited<ReturnType<typeof listWorkdirDirectoryPage>>;
		const restarted = await listWorkdirDirectoryPage(request("d0", { cursor: firstPage.nextCursor ?? undefined }));
		expect(restarted.snapshotId).not.toBe(firstPage.snapshotId);
		invalidateWorkdirFileListCache(root);
		await settle();
		expect(openHandles).toBe(0);
	});

	it("rejects excess concurrent page work as retryable instead of queueing without bound", async () => {
		const directories = Array.from({ length: 70 }, (_, index) => `busy${index}`);
		for (const directory of directories) graph.set(join(root, directory), [entry("a")]);
		let release: () => void = () => undefined;
		readGate = new Promise((resolve) => {
			release = resolve;
		});
		const results = directories.map((directory) =>
			listWorkdirDirectoryPage(request(directory)).catch((error) => error),
		);
		await settle();
		readGate = null;
		release();
		const settled = await Promise.all(results);
		const busy = settled.filter((result) => result instanceof Error);
		expect(busy.length).toBeGreaterThan(0);
		expect(busy.every((error) => (error as { code?: string }).code === "busy")).toBe(true);
		expect(getWorkdirDirectoryListingSnapshot().pendingPageOperations).toBe(0);
	});

	it("closes the handle and retires the snapshot on a read error", async () => {
		graph.set(root, files(3));
		failRead = true;
		await expect(listWorkdirDirectoryPage(request())).rejects.toThrow("read failed");
		await settle();
		expect(openHandles).toBe(0);
		failRead = false;
		expect((await listWorkdirDirectoryPage(request())).files).toHaveLength(3);
	});

	it("maps missing directories to not_found and validates directories before opening", async () => {
		await expect(listWorkdirDirectoryPage(request("missing"))).rejects.toMatchObject({ code: "not_found" });
		await expect(listWorkdirDirectoryPage(request("../x"))).rejects.toMatchObject({ code: "invalid_directory" });
		await expect(listWorkdirDirectoryPage(request("a/node_modules"))).rejects.toMatchObject({
			code: "blocked_directory",
		});
		await expect(listWorkdirDirectoryPage(request("x/.claude/worktrees"))).rejects.toMatchObject({
			code: "excluded_directory",
		});
		expect(mocks.opendir).toHaveBeenCalledTimes(1);
	});
});

describe("readWorkdirDirectoryPage", () => {
	function sourceOf(children: Array<{ name: string; isDirectory: boolean }>): WorkdirDirectoryChildSource {
		let index = 0;
		return {
			retainedBytes: 0,
			next: async () => children[index++] ?? null,
			close: async () => undefined,
		};
	}

	it("stops at the examined-entry budget even when every entry is hidden", async () => {
		const children = Array.from({ length: 10 }, () => ({ name: "node_modules", isDirectory: true }));
		const page = await readWorkdirDirectoryPage(
			sourceOf(children),
			"",
			{ maxVisibleEntries: 5, maxExaminedEntries: 4 },
			{ isExcludedDirectory: (name) => name === "node_modules" },
		);
		expect(page).toEqual({ files: [], directories: [], hiddenCount: 4, exhausted: false });
	});

	it("uses the production page limits", () => {
		expect(WORKDIR_DIRECTORY_PAGE_LIMITS).toEqual({ maxVisibleEntries: 500, maxExaminedEntries: 4_096 });
	});
});
