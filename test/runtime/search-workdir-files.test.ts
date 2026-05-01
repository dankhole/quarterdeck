import { spawnSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createWorkdirEntry,
	deleteWorkdirEntry,
	listAllWorkdirFiles,
	searchFilePaths,
	searchWorkdirFiles,
} from "../../src/workdir";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

describe.sequential("search workdir files runtime", () => {
	it("searches precomputed ref file paths without working-tree change metadata", () => {
		const results = searchFilePaths(["src/app.ts", "docs/app-notes.md", "README.md"], "app", 20);

		expect(results).toEqual([
			{ path: "src/app.ts", name: "app.ts", changed: false },
			{ path: "docs/app-notes.md", name: "app-notes.md", changed: false },
		]);
	});

	it("lists workdir files with bounded filesystem skips in git repositories", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-files-git-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			mkdirSync(join(repoPath, "docs"), { recursive: true });
			mkdirSync(join(repoPath, "node_modules", "package"), { recursive: true });
			writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n.env.local\n", "utf8");
			writeFileSync(join(repoPath, "src", "app.ts"), "export const app = true;\n", "utf8");
			commitAll(repoPath, "add tracked source");
			writeFileSync(join(repoPath, ".env.local"), "TOKEN=local\n", "utf8");
			writeFileSync(join(repoPath, "docs", "note.md"), "draft\n", "utf8");
			writeFileSync(join(repoPath, "node_modules", "package", "index.js"), "ignored\n", "utf8");

			const files = await listAllWorkdirFiles(repoPath);

			expect(files).toEqual([".env.local", ".gitignore", "docs/note.md", "src/app.ts"]);
		} finally {
			cleanup();
		}
	});

	it("skips dependency and VCS directories outside git repositories", async () => {
		const { path: directoryPath, cleanup } = createTempDir("quarterdeck-list-files-fs-");
		try {
			mkdirSync(join(directoryPath, "src"), { recursive: true });
			mkdirSync(join(directoryPath, ".git"), { recursive: true });
			mkdirSync(join(directoryPath, "node_modules", "package"), { recursive: true });
			writeFileSync(join(directoryPath, "src", "app.ts"), "export const app = true;\n", "utf8");
			writeFileSync(join(directoryPath, ".git", "config"), "[core]\n", "utf8");
			writeFileSync(join(directoryPath, "node_modules", "package", "index.js"), "ignored\n", "utf8");

			const files = await listAllWorkdirFiles(directoryPath);

			expect(files).toEqual(["src/app.ts"]);
		} finally {
			cleanup();
		}
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
});
