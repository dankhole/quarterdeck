import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkdirEntry, deleteWorkdirEntry, searchFilePaths, searchWorkdirFiles } from "../../src/workdir";
import { stageAndCommitAll as commitAll, initGitRepository as initRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("search workdir files runtime", { concurrent: false }, () => {
	it("searches precomputed ref file paths without working-tree change metadata", () => {
		const results = searchFilePaths(["src/app.ts", "docs/app-notes.md", "README.md"], "app", 20);

		expect(results).toEqual([
			{ path: "src/app.ts", name: "app.ts", changed: false },
			{ path: "docs/app-notes.md", name: "app-notes.md", changed: false },
		]);
	});

	it("omits deleted tracked files from search results", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-files-deleted-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "removed.ts"), "export const removed = true;\n", "utf8");
			writeFileSync(join(repoPath, "src", "kept.ts"), "export const kept = true;\n", "utf8");
			commitAll(repoPath, "add tracked files");
			unlinkSync(join(repoPath, "src", "removed.ts"));

			const results = await searchWorkdirFiles(repoPath, "removed", 20);

			expect(results).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("refreshes quick-open cache after file browser mutations", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-files-mutation-cache-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "removed.ts"), "export const removed = true;\n", "utf8");
			commitAll(repoPath, "add tracked files");

			expect(await searchWorkdirFiles(repoPath, "created", 20)).toEqual([]);

			await createWorkdirEntry(repoPath, "src/created.ts", "file");
			expect(await searchWorkdirFiles(repoPath, "created", 20)).toEqual([
				{ path: "src/created.ts", name: "created.ts", changed: true },
			]);

			expect(await searchWorkdirFiles(repoPath, "removed", 20)).toEqual([
				{ path: "src/removed.ts", name: "removed.ts", changed: false },
			]);

			await deleteWorkdirEntry(repoPath, "src/removed.ts", "file");
			expect(await searchWorkdirFiles(repoPath, "removed", 20)).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("finds modified tracked files with non-ASCII paths using UTF-8 query text", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-files-nonascii-tracked-");
		try {
			initRepository(repoPath);
			const directory = "提出書類";
			const fileName = "設計書.md";
			const relativePath = `${directory}/${fileName}`;
			mkdirSync(join(repoPath, directory), { recursive: true });
			writeFileSync(join(repoPath, relativePath), "first\n", "utf8");
			commitAll(repoPath, "add non-ascii tracked file");
			writeFileSync(join(repoPath, relativePath), "updated\n", "utf8");

			const results = await searchWorkdirFiles(repoPath, "提出", 20);

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				path: relativePath,
				name: fileName,
				changed: true,
			});
		} finally {
			cleanup();
		}
	});

	it("finds untracked files with non-ASCII paths using UTF-8 query text", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-files-nonascii-untracked-");
		try {
			initRepository(repoPath);
			const directory = "新規資料";
			const fileName = "メモ.txt";
			const relativePath = `${directory}/${fileName}`;
			mkdirSync(join(repoPath, directory), { recursive: true });
			writeFileSync(join(repoPath, relativePath), "draft\n", "utf8");

			const results = await searchWorkdirFiles(repoPath, "新規", 20);

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				path: relativePath,
				name: fileName,
				changed: true,
			});
		} finally {
			cleanup();
		}
	});

	it("preserves valid leading spaces in Windows-compatible file names", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-files-leading-space-");
		try {
			initRepository(repoPath);
			const relativePath = " leading-note.txt";
			writeFileSync(join(repoPath, relativePath), "draft\n", "utf8");

			const results = await searchWorkdirFiles(repoPath, "leading", 20);

			expect(results).toEqual([{ path: relativePath, name: relativePath, changed: true }]);
		} finally {
			cleanup();
		}
	});
});
