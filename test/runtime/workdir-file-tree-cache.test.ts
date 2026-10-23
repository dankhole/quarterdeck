import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as WorkdirFileTreeModule from "../../src/workdir/workdir-file-tree";
import { type WorkdirFileTree, WorkdirFileTreeLimitError } from "../../src/workdir/workdir-file-tree";

const mocks = vi.hoisted(() => ({ walk: vi.fn() }));
vi.mock("../../src/workdir/workdir-file-tree", async (importOriginal) => ({
	...(await importOriginal<typeof WorkdirFileTreeModule>()),
	walkWorkdirFileTree: mocks.walk,
}));

import {
	invalidateWorkdirFileListCache,
	listAllWorkdirFileEntries,
	listAllWorkdirFiles,
} from "../../src/workdir/search-workdir-files";

function deferred<Result>() {
	let resolvePromise!: (result: Result) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<Result>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const tree = { files: ["file.txt"], directories: ["empty"] };
const roots = new Set<string>();
let sequence = 0;
function root(): string {
	const cwd = resolve(`synthetic-cache-root-${++sequence}`);
	roots.add(cwd);
	return cwd;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	mocks.walk
		.mockReset()
		.mockImplementation(async () => ({ files: [...tree.files], directories: [...tree.directories] }));
});

afterEach(() => {
	for (const cwd of roots) invalidateWorkdirFileListCache(cwd);
	roots.clear();
	vi.useRealTimers();
});

describe("workdir file tree listing cache", () => {
	it("shares one in-flight traversal between both APIs and normalized root spellings", async () => {
		const cwd = root();
		const load = deferred<WorkdirFileTree>();
		mocks.walk.mockReturnValue(load.promise);
		const files = listAllWorkdirFiles(cwd);
		const entries = listAllWorkdirFileEntries(`${cwd}/.`);
		expect(mocks.walk).toHaveBeenCalledTimes(1);
		load.resolve(tree);
		expect(await files).toEqual(tree.files);
		expect(await entries).toEqual(tree);
	});

	it("retains listing snapshots beyond the old 5s TTL and reloads at 30s", async () => {
		const cwd = root();
		await listAllWorkdirFiles(cwd);
		vi.setSystemTime(5_001);
		await listAllWorkdirFileEntries(cwd);
		vi.setSystemTime(29_999);
		await listAllWorkdirFiles(cwd);
		expect(mocks.walk).toHaveBeenCalledTimes(1);
		mocks.walk.mockResolvedValue({ files: ["external.txt"], directories: [] });
		vi.setSystemTime(30_000);
		expect(await listAllWorkdirFiles(cwd)).toEqual(["external.txt"]);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("separates folder/Git loads and snapshots, and invalidates both modes", async () => {
		const cwd = root();
		mocks.walk.mockImplementation(async (_cwd: string, options: { useGitIgnores: boolean }) => ({
			files: options.useGitIgnores ? ["source.txt"] : ["ignored/file.txt"],
			directories: [],
		}));
		const [git, folder] = await Promise.all([
			listAllWorkdirFiles(cwd),
			listAllWorkdirFiles(cwd, { useGitIgnores: false }),
		]);
		expect(git).toEqual(["source.txt"]);
		expect(folder).toEqual(["ignored/file.txt"]);
		await listAllWorkdirFileEntries(cwd, { useGitIgnores: true });
		await listAllWorkdirFileEntries(cwd, { useGitIgnores: false });
		expect(mocks.walk).toHaveBeenCalledTimes(2);
		invalidateWorkdirFileListCache(cwd);
		await listAllWorkdirFiles(cwd);
		await listAllWorkdirFiles(cwd, { useGitIgnores: false });
		expect(mocks.walk).toHaveBeenCalledTimes(4);
	});

	it("returns defensive copies to concurrent and cached callers", async () => {
		const cwd = root();
		const [files, entries] = await Promise.all([listAllWorkdirFiles(cwd), listAllWorkdirFileEntries(cwd)]);
		files.push("not-real");
		entries.files.length = 0;
		entries.directories.push("not-real");
		expect(await listAllWorkdirFileEntries(cwd)).toEqual(tree);
	});

	it.each(["resolve", "reject"] as const)(
		"does not let an invalidated load %s erase a pending replacement",
		async (outcome) => {
			const cwd = root();
			const oldLoad = deferred<WorkdirFileTree>();
			const newLoad = deferred<WorkdirFileTree>();
			mocks.walk.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);
			const oldRequest = listAllWorkdirFiles(cwd).catch(() => []);
			invalidateWorkdirFileListCache(`${cwd}/.`);
			const replacement = listAllWorkdirFileEntries(cwd);
			if (outcome === "resolve") oldLoad.resolve({ files: ["old"], directories: [] });
			else oldLoad.reject(new Error("old failure"));
			await oldRequest;
			const sharedReplacement = listAllWorkdirFiles(cwd);
			expect(mocks.walk).toHaveBeenCalledTimes(2);
			newLoad.resolve(tree);
			expect(await replacement).toEqual(tree);
			expect(await sharedReplacement).toEqual(tree.files);
		},
	);

	it("does not let an invalidated load overwrite a completed replacement", async () => {
		const cwd = root();
		const oldLoad = deferred<WorkdirFileTree>();
		mocks.walk.mockReturnValueOnce(oldLoad.promise);
		const oldRequest = listAllWorkdirFiles(cwd);
		invalidateWorkdirFileListCache(cwd);
		expect(await listAllWorkdirFileEntries(cwd)).toEqual(tree);
		oldLoad.resolve({ files: ["old"], directories: [] });
		expect(await oldRequest).toEqual(["old"]);
		expect(await listAllWorkdirFiles(cwd)).toEqual(tree.files);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("clears rejected in-flight loads so a later request can retry", async () => {
		const cwd = root();
		mocks.walk.mockRejectedValueOnce(new Error("entry limit"));
		const requests = [listAllWorkdirFiles(cwd), listAllWorkdirFileEntries(cwd)];
		await Promise.all(requests.map((request) => expect(request).rejects.toThrow("entry limit")));
		expect(mocks.walk).toHaveBeenCalledTimes(1);
		expect(await listAllWorkdirFiles(cwd)).toEqual(tree.files);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("reuses limit failures across 5s polls and retries at the 30s expiry", async () => {
		const cwd = root();
		const error = new WorkdirFileTreeLimitError("entry limit");
		mocks.walk.mockRejectedValueOnce(error);
		await expect(listAllWorkdirFiles(cwd)).rejects.toBe(error);
		vi.setSystemTime(5_001);
		await expect(listAllWorkdirFileEntries(cwd)).rejects.toBe(error);
		vi.setSystemTime(29_999);
		await expect(listAllWorkdirFiles(cwd)).rejects.toBe(error);
		expect(mocks.walk).toHaveBeenCalledTimes(1);
		vi.setSystemTime(30_000);
		expect(await listAllWorkdirFiles(cwd)).toEqual(tree.files);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("invalidates a cached limit failure immediately", async () => {
		const cwd = root();
		mocks.walk.mockRejectedValueOnce(new WorkdirFileTreeLimitError("entry limit"));
		await expect(listAllWorkdirFiles(cwd)).rejects.toThrow("entry limit");
		invalidateWorkdirFileListCache(cwd);
		expect(await listAllWorkdirFileEntries(cwd)).toEqual(tree);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("does not cache an invalidated load's limit failure", async () => {
		const cwd = root();
		const oldLoad = deferred<WorkdirFileTree>();
		mocks.walk.mockReturnValueOnce(oldLoad.promise);
		const oldRequest = listAllWorkdirFiles(cwd);
		const failed = expect(oldRequest).rejects.toThrow("old limit");
		invalidateWorkdirFileListCache(cwd);
		await listAllWorkdirFileEntries(cwd);
		oldLoad.reject(new WorkdirFileTreeLimitError("old limit"));
		await failed;
		expect(await listAllWorkdirFiles(cwd)).toEqual(tree.files);
		expect(mocks.walk).toHaveBeenCalledTimes(2);
	});

	it("invalidates settled snapshots immediately", async () => {
		const cwd = root();
		await listAllWorkdirFileEntries(cwd);
		mocks.walk.mockResolvedValue({ files: ["created.txt"], directories: [] });
		invalidateWorkdirFileListCache(cwd);
		expect(await listAllWorkdirFiles(cwd)).toEqual(["created.txt"]);
	});

	it.each(["success", "limit failure"])("retains at most 100 settled roots including a %s", async (outcome) => {
		const first = root();
		if (outcome === "limit failure") {
			mocks.walk.mockRejectedValueOnce(new WorkdirFileTreeLimitError("entry limit"));
			await expect(listAllWorkdirFiles(first)).rejects.toThrow("entry limit");
		} else {
			await listAllWorkdirFiles(first);
		}
		for (let index = 0; index < 100; index += 1) await listAllWorkdirFiles(root());
		expect(mocks.walk).toHaveBeenCalledTimes(101);
		expect(await listAllWorkdirFiles(first)).toEqual(tree.files);
		expect(mocks.walk).toHaveBeenCalledTimes(102);
	});
});
