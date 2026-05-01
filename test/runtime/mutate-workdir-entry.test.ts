import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createWorkdirEntry,
	deleteWorkdirEntry,
	listAllWorkdirFileEntries,
	renameWorkdirEntry,
} from "../../src/workdir";
import { createTempDir } from "../utilities/temp-dir";

describe("workdir entry mutations", () => {
	it("creates files and empty folders and refreshes the file list cache", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-create-");
		try {
			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({ files: [], directories: [] });

			const directoryResult = await createWorkdirEntry(repoPath, "src/", "directory");
			const nestedDirectoryResult = await createWorkdirEntry(repoPath, "src/foo/", "directory");
			await createWorkdirEntry(repoPath, "src/app.ts", "file");

			expect(directoryResult.path).toBe("src");
			expect(nestedDirectoryResult.path).toBe("src/foo");
			expect(readFileSync(join(repoPath, "src", "app.ts"), "utf8")).toBe("");
			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
				files: ["src/app.ts"],
				directories: ["src", "src/foo"],
			});
		} finally {
			cleanup();
		}
	});

	it("renames files and folders within the worktree", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-rename-");
		try {
			mkdirSync(join(repoPath, "src", "components"), { recursive: true });
			mkdirSync(join(repoPath, "docs"), { recursive: true });
			writeFileSync(join(repoPath, "src", "components", "button.ts"), "export const button = true;\n", "utf8");
			writeFileSync(join(repoPath, "README.md"), "# Before\n", "utf8");

			await renameWorkdirEntry(repoPath, "README.md", "docs/README.md", "file");
			const directoryResult = await renameWorkdirEntry(repoPath, "src/", "lib/", "directory");

			expect(directoryResult.path).toBe("lib");
			expect(readFileSync(join(repoPath, "docs", "README.md"), "utf8")).toBe("# Before\n");
			expect(readFileSync(join(repoPath, "lib", "components", "button.ts"), "utf8")).toBe(
				"export const button = true;\n",
			);
			expect(existsSync(join(repoPath, "src"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("treats trailing slashes as the same path when renaming", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-same-trailing-");
		try {
			mkdirSync(join(repoPath, "src"), { recursive: true });

			const result = await renameWorkdirEntry(repoPath, "src", "src/", "directory");

			expect(result.path).toBe("src");
			expect(existsSync(join(repoPath, "src"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("deletes files and folders with the requested kind", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-delete-");
		try {
			mkdirSync(join(repoPath, "assets", "icons"), { recursive: true });
			writeFileSync(join(repoPath, "assets", "icons", "add.svg"), "<svg />\n", "utf8");
			writeFileSync(join(repoPath, "scratch.txt"), "scratch\n", "utf8");

			await deleteWorkdirEntry(repoPath, "scratch.txt", "file");
			await deleteWorkdirEntry(repoPath, "assets", "directory");

			expect(existsSync(join(repoPath, "scratch.txt"))).toBe(false);
			expect(existsSync(join(repoPath, "assets"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("rejects paths outside the worktree", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-outside-");
		try {
			await expect(createWorkdirEntry(repoPath, "../outside.txt", "file")).rejects.toThrow(
				"Path resolves outside the worktree.",
			);
		} finally {
			cleanup();
		}
	});

	it("rejects paths whose parent folder does not exist", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-missing-parent-");
		try {
			await expect(createWorkdirEntry(repoPath, "missing/app.ts", "file")).rejects.toThrow(
				"Parent folder does not exist.",
			);
		} finally {
			cleanup();
		}
	});

	it("rejects skipped file-browser path components", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-skipped-");
		try {
			for (const path of [".git/config", ".hg/store", ".svn/wc.db", "node_modules/package/index.js"]) {
				await expect(createWorkdirEntry(repoPath, path, "file")).rejects.toThrow(
					"Cannot modify skipped workdir paths.",
				);
			}
			mkdirSync(join(repoPath, "src"), { recursive: true });
			await expect(renameWorkdirEntry(repoPath, "src", "node_modules/src", "directory")).rejects.toThrow(
				"Cannot modify skipped workdir paths.",
			);
		} finally {
			cleanup();
		}
	});

	it("rejects moving a folder inside itself", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-entry-nested-");
		try {
			mkdirSync(join(repoPath, "src"), { recursive: true });

			await expect(renameWorkdirEntry(repoPath, "src", "src/nested", "directory")).rejects.toThrow(
				"Cannot move a directory inside itself.",
			);
		} finally {
			cleanup();
		}
	});
});
