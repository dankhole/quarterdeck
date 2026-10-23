import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createWorkdirEntry,
	deleteWorkdirEntry,
	listAllWorkdirFileEntries,
	listAllWorkdirFiles,
	searchFilePaths,
	searchWorkdirFiles,
} from "../../src/workdir";
import { stageAndCommitAll as commitAll, initGitRepository as initRepository, runGit } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("search workdir files runtime", { concurrent: false }, () => {
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

	it.each(["files", "entries"] as const)(
		"prunes Git-ignored directories in the %s listing without losing existing tracked or individually ignored files",
		async (api) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-files-ignored-");
			try {
				initRepository(repoPath);
				writeFileSync(join(repoPath, ".gitignore"), ".venv/\ntarget/\ndist/\n.env.local\n", "utf8");
				for (const directory of [".venv", "target", "dist", "dist/generated", "empty"]) {
					mkdirSync(join(repoPath, directory), { recursive: true });
				}
				writeFileSync(join(repoPath, "dist/tracked.js"), "tracked\n", "utf8");
				writeFileSync(join(repoPath, "dist/deleted.js"), "removed\n", "utf8");
				runGit(repoPath, ["add", "--force", "dist/tracked.js", "dist/deleted.js"]);
				commitAll(repoPath, "track files inside ignored dist");
				unlinkSync(join(repoPath, "dist/deleted.js"));
				for (const path of [".venv/installed.py", "target/binary", "dist/generated/bundle.js", ".env.local"]) {
					writeFileSync(join(repoPath, path), "local\n", "utf8");
				}

				const files = [".env.local", ".gitignore", "dist/tracked.js"];
				if (api === "files") {
					expect(await listAllWorkdirFiles(repoPath)).toEqual(files);
				} else {
					expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
						files,
						directories: ["dist", "empty"],
					});
				}
			} finally {
				cleanup();
			}
		},
	);

	it.each([false, true])(
		"preserves directories containing only individually ignored files (directory rule=%s)",
		async (directoryRule) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-ignored-only-files-");
			try {
				initRepository(repoPath);
				writeFileSync(join(repoPath, ".gitignore"), `*.log\n.env\n${directoryRule ? "cache 資料/\n" : ""}`, "utf8");
				for (const directory of ["logs", "config"]) mkdirSync(join(repoPath, directory));
				writeFileSync(join(repoPath, "logs/a.log"), "log\n", "utf8");
				writeFileSync(join(repoPath, "config/.env"), "synthetic\n", "utf8");
				if (directoryRule) {
					mkdirSync(join(repoPath, "cache 資料"));
					writeFileSync(join(repoPath, "cache 資料/output.txt"), "hidden\n", "utf8");
				}
				expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
					files: [".gitignore", "config/.env", "logs/a.log"],
					directories: ["config", "logs"],
				});
			} finally {
				cleanup();
			}
		},
	);

	it.each(["parent repository", "retained repository"])(
		"bypasses ignore rules for folder-mode listings in a %s",
		async (kind) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-folder-mode-");
			try {
				initRepository(repoPath);
				writeFileSync(join(repoPath, ".gitignore"), "dist/\n", "utf8");
				const cwd = kind === "parent repository" ? join(repoPath, "folder") : repoPath;
				mkdirSync(join(cwd, "dist"), { recursive: true });
				writeFileSync(join(cwd, "dist/output.txt"), "visible\n", "utf8");
				expect(await listAllWorkdirFiles(cwd)).not.toContain("dist/output.txt");
				expect(await listAllWorkdirFiles(cwd, { useGitIgnores: false })).toContain("dist/output.txt");
			} finally {
				cleanup();
			}
		},
	);

	it.runIf(process.platform === "darwin")(
		"matches Git NFC ignored directories against filesystem NFD names without rewriting visible paths",
		async () => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-unicode-normalization-");
			try {
				initRepository(repoPath);
				runGit(repoPath, ["config", "core.precomposeUnicode", "true"]);
				writeFileSync(join(repoPath, ".gitignore"), "é-cache/\n", "utf8");
				mkdirSync(join(repoPath, "e\u0301-cache"));
				writeFileSync(join(repoPath, "e\u0301-cache/output.txt"), "hidden\n", "utf8");
				mkdirSync(join(repoPath, "re\u0301sume"));
				writeFileSync(join(repoPath, "re\u0301sume/note.txt"), "visible\n", "utf8");
				expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
					files: [".gitignore", "re\u0301sume/note.txt"],
					directories: ["re\u0301sume"],
				});
			} finally {
				cleanup();
			}
		},
	);

	it("honors nested Git ignores and reinclusions while preserving visible empty directories", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-files-nested-ignore-");
		try {
			initRepository(repoPath);
			for (const directory of ["src/cache", "src/output/generated", "src/output/keep", "src/empty", "empty"]) {
				mkdirSync(join(repoPath, directory), { recursive: true });
			}
			writeFileSync(join(repoPath, "src/.gitignore"), "cache/\noutput/*\n!output/keep/\n*.log\n", "utf8");
			for (const path of [
				"src/cache/item",
				"src/output/generated/item",
				"src/output/keep/note.md",
				"src/debug.log",
			]) {
				writeFileSync(join(repoPath, path), "local\n", "utf8");
			}

			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
				files: ["src/.gitignore", "src/debug.log", "src/output/keep/note.md"],
				directories: ["empty", "src", "src/empty", "src/output", "src/output/keep"],
			});
		} finally {
			cleanup();
		}
	});

	it("honors info excludes and a configured Git excludes file without hiding individually ignored files", async () => {
		const { path: fixturePath, cleanup } = createTempDir("quarterdeck-list-files-excludes-");
		try {
			const repoPath = join(fixturePath, "repo");
			mkdirSync(repoPath);
			initRepository(repoPath);
			const excludesPath = join(fixturePath, "git excludes");
			writeFileSync(excludesPath, "global-cache/\nglobal.secret\n", "utf8");
			runGit(repoPath, ["config", "core.excludesFile", excludesPath]);
			writeFileSync(join(repoPath, ".git/info/exclude"), "info-cache/\ninfo.secret\n", "utf8");
			for (const directory of ["global-cache", "info-cache", "visible"]) {
				mkdirSync(join(repoPath, directory));
				writeFileSync(join(repoPath, directory, "item.txt"), "local\n", "utf8");
			}
			writeFileSync(join(repoPath, "global.secret"), "synthetic\n", "utf8");
			writeFileSync(join(repoPath, "info.secret"), "synthetic\n", "utf8");

			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
				files: ["global.secret", "info.secret", "visible/item.txt"],
				directories: ["visible"],
			});
		} finally {
			cleanup();
		}
	});

	it("resolves ignored directories relative to a subdirectory listing root with spaced and non-ASCII paths", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-files-subdirectory-");
		try {
			initRepository(repoPath);
			const root = join(repoPath, "project space");
			for (const directory of ["資料 cache", "visible space", " leading-cache", "empty"]) {
				mkdirSync(join(root, directory), { recursive: true });
			}
			writeFileSync(join(repoPath, ".gitignore"), "/project space/資料 cache/\n", "utf8");
			writeFileSync(join(root, ".gitignore"), "/ leading-cache/\n", "utf8");
			for (const path of ["資料 cache/hidden.md", " leading-cache/hidden.md", "visible space/設計.md"]) {
				writeFileSync(join(root, path), "local\n", "utf8");
			}

			expect(await listAllWorkdirFileEntries(root)).toEqual({
				files: [".gitignore", "visible space/設計.md"],
				directories: ["empty", "visible space"],
			});
		} finally {
			cleanup();
		}
	});

	it("prunes ignored directories in a linked Git worktree", async () => {
		const { path: fixturePath, cleanup } = createTempDir("quarterdeck-list-files-linked-worktree-");
		try {
			const repoPath = join(fixturePath, "repo");
			const worktreePath = join(fixturePath, "linked worktree");
			mkdirSync(repoPath);
			initRepository(repoPath);
			writeFileSync(join(repoPath, ".gitignore"), "build cache/\n", "utf8");
			writeFileSync(join(repoPath, "tracked.md"), "tracked\n", "utf8");
			commitAll(repoPath, "add worktree files");
			runGit(repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
			mkdirSync(join(worktreePath, "build cache"));
			writeFileSync(join(worktreePath, "build cache/generated.js"), "local\n", "utf8");
			mkdirSync(join(worktreePath, "empty"));

			const entries = await listAllWorkdirFileEntries(worktreePath);
			expect(entries.files).toEqual(expect.arrayContaining([".gitignore", "tracked.md"]));
			expect(entries.files).not.toContain("build cache/generated.js");
			expect(entries.directories).toEqual(["empty"]);
		} finally {
			cleanup();
		}
	});

	it.skipIf(process.platform === "win32")("treats leading-colon directory names as literal ignore paths", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-files-literal-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, ":(x)"));
			mkdirSync(join(repoPath, ":logs"));
			writeFileSync(join(repoPath, ".gitignore"), ":(x)/\n*.log\n", "utf8");
			writeFileSync(join(repoPath, ":(x)/generated.txt"), "ignored\n", "utf8");
			writeFileSync(join(repoPath, ":logs/a.log"), "visible\n", "utf8");
			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
				files: [".gitignore", ":logs/a.log"],
				directories: [":logs"],
			});
		} finally {
			cleanup();
		}
	});

	it("lists directory symlinks as files without following outside targets or loops", async () => {
		const { path: fixturePath, cleanup } = createTempDir("quarterdeck-list-files-symlinks-");
		try {
			const repoPath = join(fixturePath, "repo");
			const outsidePath = join(fixturePath, "outside");
			mkdirSync(repoPath);
			mkdirSync(outsidePath);
			initRepository(repoPath);
			writeFileSync(join(outsidePath, "outside.txt"), "outside\n", "utf8");
			const type = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(outsidePath, join(repoPath, "linked"), type);
			symlinkSync(repoPath, join(repoPath, "loop"), type);
			mkdirSync(join(repoPath, "empty"));

			expect(await listAllWorkdirFileEntries(repoPath)).toEqual({
				files: ["linked", "loop"],
				directories: ["empty"],
			});
		} finally {
			cleanup();
		}
	});

	it("skips dependency and VCS directories outside git repositories without blanket build-directory skips", async () => {
		const { path: directoryPath, cleanup } = createTempDir("quarterdeck-list-files-fs-");
		try {
			mkdirSync(join(directoryPath, "src"), { recursive: true });
			mkdirSync(join(directoryPath, ".git"), { recursive: true });
			mkdirSync(join(directoryPath, "node_modules", "package"), { recursive: true });
			for (const directory of [".venv", "dist", "target"]) {
				mkdirSync(join(directoryPath, directory));
				writeFileSync(join(directoryPath, directory, "local.txt"), "visible\n", "utf8");
			}
			writeFileSync(join(directoryPath, "src", "app.ts"), "export const app = true;\n", "utf8");
			writeFileSync(join(directoryPath, ".git", "config"), "[core]\n", "utf8");
			writeFileSync(join(directoryPath, "node_modules", "package", "index.js"), "ignored\n", "utf8");

			const files = await listAllWorkdirFiles(directoryPath);

			expect(files).toEqual([".venv/local.txt", "dist/local.txt", "src/app.ts", "target/local.txt"]);
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
