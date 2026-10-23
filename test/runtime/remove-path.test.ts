import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ active: 0, peak: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const tracked =
		<Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
		async (...args: Args): Promise<Result> => {
			fsCalls.active += 1;
			fsCalls.peak = Math.max(fsCalls.peak, fsCalls.active);
			try {
				return await call(...args);
			} finally {
				fsCalls.active -= 1;
			}
		};
	return {
		...actual,
		lstat: tracked(actual.lstat),
		readdir: tracked(actual.readdir),
		rm: tracked(actual.rm),
	};
});

import { RECURSIVE_REMOVE_FS_CONCURRENCY, removeDirectoryWithRetries } from "../../src/fs/remove-path";
import { createTempDir } from "../utilities/temp-dir";

let temp: ReturnType<typeof createTempDir>;

beforeEach(() => {
	temp = createTempDir("quarterdeck-remove-path-");
});

afterEach(() => {
	temp.cleanup();
});

function writeTree(root: string, directories: number, filesPerDirectory: number): void {
	for (let directory = 0; directory < directories; directory += 1) {
		const directoryPath = join(root, `d${directory}`, "nested");
		mkdirSync(directoryPath, { recursive: true });
		for (let file = 0; file < filesPerDirectory; file += 1) {
			writeFileSync(join(directoryPath, `f${file}`), "x");
		}
	}
}

describe("removeDirectoryWithRetries", () => {
	it("removes a nested tree, files, and missing paths", async () => {
		const tree = join(temp.path, "tree");
		writeTree(tree, 5, 5);
		await removeDirectoryWithRetries(tree);
		expect(existsSync(tree)).toBe(false);

		const file = join(temp.path, "file.txt");
		writeFileSync(file, "x");
		await removeDirectoryWithRetries(file);
		expect(existsSync(file)).toBe(false);

		await expect(removeDirectoryWithRetries(join(temp.path, "missing"))).resolves.toBeUndefined();
		await expect(removeDirectoryWithRetries(join(temp.path, "missing"), { force: false })).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("removes symlinks without following them", async () => {
		const outside = join(temp.path, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "keep.txt"), "keep");
		const tree = join(temp.path, "tree");
		mkdirSync(tree);
		symlinkSync(outside, join(tree, "linked-dir"), "dir");
		const rootLink = join(temp.path, "root-link");
		symlinkSync(outside, rootLink, "dir");

		await removeDirectoryWithRetries(tree);
		await removeDirectoryWithRetries(rootLink);

		expect(existsSync(tree)).toBe(false);
		expect(existsSync(rootLink)).toBe(false);
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	it("caps in-flight filesystem calls so large trees cannot monopolize the shared thread pool", async () => {
		const tree = join(temp.path, "tree");
		writeTree(tree, 20, 20);
		fsCalls.active = 0;
		fsCalls.peak = 0;

		await Promise.all([removeDirectoryWithRetries(tree), removeDirectoryWithRetries(join(temp.path, "missing"))]);

		expect(existsSync(tree)).toBe(false);
		expect(fsCalls.peak).toBeGreaterThan(0);
		expect(fsCalls.peak).toBeLessThanOrEqual(RECURSIVE_REMOVE_FS_CONCURRENCY);
	});

	it("stops issuing filesystem calls once aborted and leaves the remaining tree", async () => {
		const tree = join(temp.path, "tree");
		writeTree(tree, 5, 5);
		const controller = new AbortController();
		controller.abort();

		await expect(
			removeDirectoryWithRetries(tree, { lane: "background", signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(existsSync(tree)).toBe(true);
	});
});
