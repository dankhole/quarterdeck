import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FOLDER_FILE_SEARCH_BUDGET, searchFolderWorkdirFiles } from "../../src/workdir/search-workdir-folder-files";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function writeTree(root: string, paths: string[]): void {
	for (const path of paths) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), "synthetic\n", "utf8");
	}
}

describe("searchFolderWorkdirFiles", () => {
	it("finds files in directories the browser never opened, without Git and outside excluded trees", async () => {
		const { path: root, cleanup } = createTempDir("quarterdeck-folder-search-");
		try {
			initGitRepository(root);
			writeFileSync(join(root, ".gitignore"), "dist/\n", "utf8");
			writeTree(root, [
				"a/b/c/d/target-deep.ts",
				"dist/target-ignored-by-git.ts",
				"node_modules/pkg/target.js",
				".claude/worktrees/agent-1/target-copy.ts",
				".claude/target-settings.json",
				"other.txt",
			]);
			const result = await searchFolderWorkdirFiles(root, "target", 20);
			expect(result.truncated).toBe(false);
			expect(result.files.map((file) => file.path).sort()).toEqual([
				".claude/target-settings.json",
				"a/b/c/d/target-deep.ts",
				"dist/target-ignored-by-git.ts",
			]);
			expect(result.files.every((file) => !file.changed)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it.each([
		["examined entries", { ...FOLDER_FILE_SEARCH_BUDGET, maxExaminedEntries: 3 }],
		["candidates", { ...FOLDER_FILE_SEARCH_BUDGET, maxCandidates: 2 }],
		["duration", { ...FOLDER_FILE_SEARCH_BUDGET, maxDurationMs: 0 }],
	])("reports partial results when the %s budget stops the scan", async (_label, budget) => {
		const { path: root, cleanup } = createTempDir("quarterdeck-folder-search-budget-");
		try {
			writeTree(
				root,
				Array.from({ length: 6 }, (_, index) => `dir-${index}/match-${index}.txt`),
			);
			const result = await searchFolderWorkdirFiles(root, "match", 20, budget);
			expect(result.truncated).toBe(true);
			expect(result.files.length).toBeLessThan(6);
		} finally {
			cleanup();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"checks the deadline before opening each directory, even when opens keep failing",
		async () => {
			const { path: root, cleanup } = createTempDir("quarterdeck-folder-search-unreadable-");
			const unreadable = ["a", "b", "c"].map((name) => join(root, name));
			try {
				for (const directory of unreadable) {
					mkdirSync(directory);
					chmodSync(directory, 0o000);
				}
				// Calls: deadline, root admission, and four root reads stay in budget; later checks are late.
				let calls = 0;
				const now = vi.spyOn(Date, "now").mockImplementation(() => (++calls <= 6 ? 0 : 10_000));
				try {
					expect(await searchFolderWorkdirFiles(root, "x", 20)).toEqual({ files: [], truncated: true });
				} finally {
					now.mockRestore();
				}
			} finally {
				for (const directory of unreadable) chmodSync(directory, 0o700);
				cleanup();
			}
		},
	);

	it("ranks and limits retained matches like quick-open", async () => {
		const { path: root, cleanup } = createTempDir("quarterdeck-folder-search-rank-");
		try {
			writeTree(root, ["docs/app-notes.md", "src/app.ts", "README.md"]);
			expect(await searchFolderWorkdirFiles(root, "app", 1)).toEqual({
				files: [{ path: "src/app.ts", name: "app.ts", changed: false }],
				truncated: false,
			});
		} finally {
			cleanup();
		}
	});
});
