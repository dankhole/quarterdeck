import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { invalidateWorkdirFileListCache } from "../../src/workdir/search-workdir-files";
import {
	listWorkdirDirectoryPage,
	type WorkdirDirectoryListingRequest,
} from "../../src/workdir/workdir-directory-listing";
import { stageAndCommitAll as commitAll, initGitRepository as initRepository, runGit } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";
import { listPagedWorkdirFiles, listPagedWorkdirTree } from "../utilities/workdir-listing";

function listPage(cwd: string, directory: string, options: Partial<WorkdirDirectoryListingRequest> = {}) {
	return listWorkdirDirectoryPage({ cwd, directory, showExcluded: false, useGitIgnores: true, ref: null, ...options });
}

describe("paged workdir directory listing against real Git and filesystems", { concurrent: false }, () => {
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

			const files = await listPagedWorkdirFiles(repoPath);

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
					expect(await listPagedWorkdirFiles(repoPath)).toEqual(files);
				} else {
					expect(await listPagedWorkdirTree(repoPath)).toEqual({
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
				expect(await listPagedWorkdirTree(repoPath)).toEqual({
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
				expect(await listPagedWorkdirFiles(cwd)).not.toContain("dist/output.txt");
				expect(await listPagedWorkdirFiles(cwd, { useGitIgnores: false })).toContain("dist/output.txt");
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
				expect(await listPagedWorkdirTree(repoPath)).toEqual({
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

			expect(await listPagedWorkdirTree(repoPath)).toEqual({
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

			expect(await listPagedWorkdirTree(repoPath)).toEqual({
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

			expect(await listPagedWorkdirTree(root)).toEqual({
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

			const entries = await listPagedWorkdirTree(worktreePath);
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
			expect(await listPagedWorkdirTree(repoPath)).toEqual({
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

			expect(await listPagedWorkdirTree(repoPath)).toEqual({
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

			const files = await listPagedWorkdirFiles(directoryPath);

			expect(files).toEqual([".venv/local.txt", "dist/local.txt", "src/app.ts", "target/local.txt"]);
		} finally {
			cleanup();
		}
	});

	it.each([true, false])(
		"hides only .claude/worktrees by default and reveals it on request (Git mode=%s)",
		async (useGitIgnores) => {
			const { path: root, cleanup } = createTempDir("quarterdeck-list-generated-worktrees-");
			try {
				if (useGitIgnores) initRepository(root);
				mkdirSync(join(root, ".claude/worktrees/agent-1/src"), { recursive: true });
				mkdirSync(join(root, ".claude/commands"), { recursive: true });
				mkdirSync(join(root, "child-repo/.claude/worktrees/agent-2"), { recursive: true });
				writeFileSync(join(root, ".claude/settings.json"), "{}\n", "utf8");
				writeFileSync(join(root, ".claude/worktrees/agent-1/src/app.ts"), "app\n", "utf8");
				writeFileSync(join(root, "child-repo/.claude/worktrees/agent-2/file.txt"), "nested\n", "utf8");
				writeFileSync(join(root, "worktrees.txt"), "not generated\n", "utf8");
				mkdirSync(join(root, "worktrees"));

				const hidden = await listPagedWorkdirTree(root, { useGitIgnores });
				expect(hidden.files).toEqual([".claude/settings.json", "worktrees.txt"]);
				expect(hidden.directories).toEqual([
					".claude",
					".claude/commands",
					"child-repo",
					"child-repo/.claude",
					"worktrees",
				]);
				const claudePage = await listPage(root, ".claude", { useGitIgnores });
				expect(claudePage.hiddenCount).toBe(1);
				await expect(listPage(root, ".claude/worktrees/agent-1", { useGitIgnores })).rejects.toMatchObject({
					code: "excluded_directory",
				});

				const revealed = await listPagedWorkdirTree(root, { useGitIgnores, showExcluded: true });
				expect(revealed.files).toEqual([
					".claude/settings.json",
					".claude/worktrees/agent-1/src/app.ts",
					"child-repo/.claude/worktrees/agent-2/file.txt",
					"worktrees.txt",
				]);
				expect(revealed.directories).toContain(".claude/worktrees/agent-1/src");
			} finally {
				invalidateWorkdirFileListCache(root);
				cleanup();
			}
		},
	);

	it("never reveals VCS or dependency directories, even with showExcluded", async () => {
		const { path: root, cleanup } = createTempDir("quarterdeck-list-skipped-reveal-");
		try {
			mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
			mkdirSync(join(root, ".git"));
			const page = await listPage(root, "", { useGitIgnores: false, showExcluded: true });
			expect(page.directories).toEqual([]);
			expect(page.hiddenCount).toBe(2);
			for (const directory of ["node_modules", "node_modules/pkg", ".git"]) {
				await expect(listPage(root, directory, { useGitIgnores: false, showExcluded: true })).rejects.toMatchObject(
					{
						code: "blocked_directory",
					},
				);
			}
		} finally {
			invalidateWorkdirFileListCache(root);
			cleanup();
		}
	});

	it("rejects traversal, missing directories, and directory symlinks inside or outside the root", async () => {
		const { path: fixturePath, cleanup } = createTempDir("quarterdeck-list-directory-escape-");
		try {
			const root = join(fixturePath, "root");
			mkdirSync(join(root, "real"), { recursive: true });
			mkdirSync(join(fixturePath, "outside"));
			writeFileSync(join(fixturePath, "outside/secret.txt"), "outside\n", "utf8");
			writeFileSync(join(root, "real/file.txt"), "inside\n", "utf8");
			const type = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(join(fixturePath, "outside"), join(root, "escape"), type);
			symlinkSync(join(root, "real"), join(root, "alias"), type);

			expect((await listPage(root, "real", { useGitIgnores: false })).files).toEqual(["real/file.txt"]);
			for (const directory of ["escape", "alias"]) {
				await expect(listPage(root, directory, { useGitIgnores: false })).rejects.toMatchObject({
					code: "blocked_directory",
				});
			}
			await expect(listPage(root, "../outside", { useGitIgnores: false })).rejects.toMatchObject({
				code: "invalid_directory",
			});
			await expect(listPage(root, "missing", { useGitIgnores: false })).rejects.toMatchObject({ code: "not_found" });
			await expect(listPage(root, "real/file.txt", { useGitIgnores: false })).rejects.toMatchObject({
				code: "not_found",
			});
		} finally {
			cleanup();
		}
	});

	it("lists immediate children of a ref's tree read-only, bound to the tree resolved for the snapshot", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-ref-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src/nested"), { recursive: true });
			mkdirSync(join(repoPath, "docs space"));
			writeFileSync(join(repoPath, "src/nested/deep.ts"), "deep\n", "utf8");
			writeFileSync(join(repoPath, "src/app.ts"), "app\n", "utf8");
			writeFileSync(join(repoPath, "docs space/file.txt"), "docs\n", "utf8");
			writeFileSync(join(repoPath, "README.md"), "readme\n", "utf8");
			commitAll(repoPath, "initial");
			runGit(repoPath, ["branch", "snapshot"]);
			writeFileSync(join(repoPath, "worktree-only.txt"), "untracked\n", "utf8");

			const root = await listPage(repoPath, "", { ref: "snapshot" });
			expect(root.files).toEqual(["README.md"]);
			expect(root.directories.sort()).toEqual(["docs space", "src"]);
			expect(root.nextCursor).toBeNull();
			const src = await listPage(repoPath, "src", { ref: "snapshot" });
			expect(src).toMatchObject({ directory: "src", files: ["src/app.ts"], directories: ["src/nested"] });
			expect((await listPage(repoPath, "docs space", { ref: "snapshot" })).files).toEqual(["docs space/file.txt"]);
			expect(await listPagedWorkdirFiles(repoPath, { ref: "snapshot" })).toEqual([
				"README.md",
				"docs space/file.txt",
				"src/app.ts",
				"src/nested/deep.ts",
			]);
			await expect(listPage(repoPath, "missing", { ref: "snapshot" })).rejects.toMatchObject({ code: "not_found" });
			await expect(listPage(repoPath, "", { ref: "no-such-ref" })).rejects.toMatchObject({ code: "not_found" });

			writeFileSync(join(repoPath, "added.txt"), "added\n", "utf8");
			commitAll(repoPath, "move main");
			runGit(repoPath, ["branch", "-f", "snapshot", "HEAD"]);
			const moved = await listPage(repoPath, "", { ref: "snapshot" });
			expect(moved.files).toContain("added.txt");
			expect(moved.snapshotId).not.toBe(root.snapshotId);
		} finally {
			cleanup();
		}
	});

	// Windows rejects `:` in path components, including through workdir path validation.
	it.skipIf(process.platform === "win32")("lists leading-colon tree names at a ref as literal paths", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-ref-colon-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, ":colon"));
			writeFileSync(join(repoPath, ":colon/file.txt"), "colon\n", "utf8");
			commitAll(repoPath, "initial");
			expect((await listPage(repoPath, "", { ref: "HEAD" })).directories).toEqual([":colon"]);
			expect((await listPage(repoPath, ":colon", { ref: "HEAD" })).files).toEqual([":colon/file.txt"]);
		} finally {
			cleanup();
		}
	});

	it("retains registered submodule content when the outer repository cannot check its ignores", async () => {
		const { path: fixturePath, cleanup } = createTempDir("quarterdeck-list-submodule-");
		try {
			const outer = join(fixturePath, "outer");
			const inner = join(fixturePath, "inner");
			for (const path of [outer, inner]) {
				mkdirSync(path);
				initRepository(path);
			}
			mkdirSync(join(inner, "src/cache"), { recursive: true });
			writeFileSync(join(inner, "src/a.ts"), "a\n", "utf8");
			writeFileSync(join(inner, "src/cache/keep.txt"), "cache\n", "utf8");
			commitAll(inner, "inner");
			runGit(outer, ["-c", "protocol.file.allow=always", "submodule", "add", inner, "sub"]);
			commitAll(outer, "add submodule");
			writeFileSync(join(outer, "sub/.gitignore"), "cache/\n", "utf8");

			expect((await listPage(outer, "")).directories).toEqual(["sub"]);
			const sub = await listPage(outer, "sub");
			expect(sub.directories).toEqual(["sub/src"]);
			// Conservatively retained: no nested ignore discovery inside the submodule.
			expect(await listPage(outer, "sub/src")).toMatchObject({ directories: ["sub/src/cache"], hiddenCount: 0 });
		} finally {
			invalidateWorkdirFileListCache(join(fixturePath, "outer"));
			cleanup();
		}
	});

	it("lists a ref subtree relative to a project rooted in a repository subdirectory", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-ref-subdirectory-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "project/src"), { recursive: true });
			writeFileSync(join(repoPath, "outside.txt"), "outside\n", "utf8");
			writeFileSync(join(repoPath, "project/src/app.ts"), "app\n", "utf8");
			commitAll(repoPath, "initial");
			expect(await listPagedWorkdirTree(join(repoPath, "project"), { ref: "HEAD" })).toEqual({
				files: ["src/app.ts"],
				directories: ["src"],
			});
		} finally {
			cleanup();
		}
	});

	it("lists inside nested repositories without failing the outer Git ignore check", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-list-nested-repository-");
		try {
			initRepository(repoPath);
			const nested = join(repoPath, "packages/nested");
			mkdirSync(join(nested, "src/cache"), { recursive: true });
			initRepository(nested);
			writeFileSync(join(nested, ".gitignore"), "cache/\n", "utf8");
			writeFileSync(join(nested, "src/cache/out.txt"), "cache\n", "utf8");
			writeFileSync(join(nested, "src/app.ts"), "app\n", "utf8");
			const page = await listPage(repoPath, "packages/nested/src");
			expect(page.files).toEqual(["packages/nested/src/app.ts"]);
			expect(page.directories).toEqual([]);
			expect(page.hiddenCount).toBe(1);
		} finally {
			invalidateWorkdirFileListCache(repoPath);
			cleanup();
		}
	});
});
