import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	cleanupLegacyDependencySymlinks,
	copyIncludedIgnoredPathsIntoWorktree,
} from "../../src/workdir/task-worktree-symlinks";
import { runGit } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function write(root: string, path: string, text = `${path}\n`): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

function fixture() {
	const { path: root, cleanup } = createTempDir("quarterdeck-worktree-include-");
	const repo = join(root, "repo");
	const worktree = join(root, "task");
	mkdirSync(repo);
	runGit(repo, ["init"]);
	runGit(repo, ["config", "user.name", "Quarterdeck Test"]);
	runGit(repo, ["config", "user.email", "quarterdeck-test@example.com"]);
	write(repo, "README.md", "tracked\n");
	runGit(repo, ["add", "README.md"]);
	runGit(repo, ["commit", "-m", "fixture"]);
	runGit(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
	return { root, repo, worktree, cleanup };
}

describe(".worktreeinclude copies", () => {
	it("copies nothing without an explicit include file", async () => {
		const { repo, worktree, cleanup } = fixture();
		try {
			write(repo, ".gitignore", "*.env\n");
			write(repo, "local.env");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(existsSync(join(worktree, "local.env"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("uses gitignore wildcards, negation, anchors and escapes, and copies only ignored files", async () => {
		const { repo, worktree, cleanup } = fixture();
		try {
			write(repo, ".gitignore", "*.env\nlocal/\n# comment\n\\#secret\n\\!secret\n");
			write(
				repo,
				".worktreeinclude",
				"# comment\n/*.env\n!secret.env\nlocal/**\n!local/private/\n!local/private/**\n\\#secret\n\\!secret\nREADME.md\nuntracked.txt\n",
			);
			for (const path of [
				"app.env",
				"secret.env",
				"nested/app.env",
				"local/config.json",
				"local/private/key",
				"#secret",
				"!secret",
				"untracked.txt",
			])
				write(repo, path);
			write(repo, "README.md", "uncommitted source edit\n");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			for (const path of ["app.env", "local/config.json", "#secret", "!secret"]) {
				expect(lstatSync(join(worktree, path)).isFile()).toBe(true);
				expect(readFileSync(join(worktree, path), "utf8")).toBe(`${path}\n`);
			}
			for (const path of ["secret.env", "nested/app.env", "local/private/key", "untracked.txt"])
				expect(existsSync(join(worktree, path)), path).toBe(false);
			expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("tracked\n");
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
			write(worktree, "app.env", "task-owned\n");
			expect(readFileSync(join(repo, "app.env"), "utf8")).toBe("app.env\n");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(readFileSync(join(worktree, "app.env"), "utf8")).toBe("task-owned\n");
		} finally {
			cleanup();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps partial copies ignored when a later selected file fails",
		async () => {
			const { repo, worktree, cleanup } = fixture();
			try {
				write(repo, "nested/.gitignore", "*\n");
				write(repo, "nested/a.env", "synthetic");
				write(repo, "nested/z.env", "synthetic");
				chmodSync(join(repo, "nested/z.env"), 0);
				write(repo, ".worktreeinclude", "nested/**\n!nested/.gitignore\n");
				await expect(copyIncludedIgnoredPathsIntoWorktree(repo, worktree)).rejects.toThrow(
					"Could not copy included file",
				);
				expect(readFileSync(join(worktree, "nested/a.env"), "utf8")).toBe("synthetic");
				expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
			} finally {
				cleanup();
			}
		},
	);

	it("preserves ignore status from nested rules even when the ignore file is not included", async () => {
		const { repo, worktree, cleanup } = fixture();
		try {
			write(repo, "nested/.gitignore", "*.env\n");
			write(repo, "nested/local.env");
			write(repo, ".worktreeinclude", "nested/*.env\n");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(existsSync(join(worktree, "nested/.gitignore"))).toBe(false);
			expect(readFileSync(join(worktree, "nested/local.env"), "utf8")).toBe("nested/local.env\n");
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
			// A previous copy may have completed before ignore metadata failed.
			write(repo, ".git/info/exclude", "");
			write(worktree, "nested/local.env", "task-owned\n");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(readFileSync(join(worktree, "nested/local.env"), "utf8")).toBe("task-owned\n");
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
			write(repo, "nested/second.env");
			write(repo, ".worktreeinclude", "nested/second.env\n");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("does not copy tracked children from an ignored parent, even when absent from the destination base", async () => {
		const { repo, worktree, cleanup } = fixture();
		try {
			write(repo, ".gitignore", "local/\n");
			write(repo, ".worktreeinclude", "local/\n");
			write(repo, "local/tracked.txt");
			write(repo, "local/ignored.env");
			runGit(repo, ["add", "--force", "local/tracked.txt"]);
			runGit(repo, ["commit", "-m", "tracked child"]);
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(existsSync(join(worktree, "local/tracked.txt"))).toBe(false);
			expect(existsSync(join(worktree, "local/ignored.env"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("preserves both sets of exclusions when two worktrees copy concurrently", async () => {
		const { root, repo, worktree, cleanup } = fixture();
		try {
			const secondSource = join(root, "second-source");
			const secondTarget = join(root, "second-target");
			runGit(repo, ["worktree", "add", "--detach", secondSource, "HEAD"]);
			runGit(repo, ["worktree", "add", "--detach", secondTarget, "HEAD"]);
			for (const source of [repo, secondSource]) {
				write(source, ".gitignore", "*.env\n");
				write(source, ".worktreeinclude", "*.env\n");
			}
			write(repo, "first.env");
			write(secondSource, "second.env");
			await Promise.all([
				copyIncludedIgnoredPathsIntoWorktree(repo, worktree),
				copyIncludedIgnoredPathsIntoWorktree(secondSource, secondTarget),
			]);
			expect(readFileSync(join(worktree, "first.env"), "utf8")).toBe("first.env\n");
			expect(readFileSync(join(secondTarget, "second.env"), "utf8")).toBe("second.env\n");
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");
			expect(runGit(secondTarget, ["status", "--porcelain"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("prunes dependencies, mutable outputs and metadata inside an included parent", async () => {
		const { repo, worktree, cleanup } = fixture();
		try {
			write(repo, ".gitignore", "local/\n");
			write(repo, ".worktreeinclude", "local/\n");
			const blocked = [
				"node_modules",
				"NODE_MODULES",
				"bin",
				"obj",
				"TestResults",
				"test-results",
				"playwright-report",
				".agent-lab-results",
				".git",
			];
			for (const name of blocked) write(repo, `local/nested/${name}/sentinel`);
			write(repo, "local/nested/.DS_Store");
			write(repo, "local/nested/settings.env");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			for (const name of blocked) expect(existsSync(join(worktree, `local/nested/${name}`))).toBe(false);
			expect(existsSync(join(worktree, "local/nested/.DS_Store"))).toBe(false);
			expect(existsSync(join(worktree, "local/nested/settings.env"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("does not follow source or destination directory links or overwrite existing files", async () => {
		const { root, repo, worktree, cleanup } = fixture();
		try {
			const outside = join(root, "outside");
			write(outside, "source.env", "outside\n");
			write(repo, ".gitignore", "local/\n");
			write(repo, ".worktreeinclude", "local/\n");
			write(repo, "local/existing.env", "source\n");
			write(repo, "local/destination/source.env", "source\n");
			write(worktree, "local/existing.env", "task\n");
			symlinkSync(outside, join(repo, "local/source"), process.platform === "win32" ? "junction" : "dir");
			symlinkSync(outside, join(worktree, "local/destination"), process.platform === "win32" ? "junction" : "dir");
			await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
			expect(existsSync(join(worktree, "local/source"))).toBe(false);
			expect(readFileSync(join(worktree, "local/existing.env"), "utf8")).toBe("task\n");
			expect(readFileSync(join(outside, "source.env"), "utf8")).toBe("outside\n");
		} finally {
			cleanup();
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not follow file symlinks, including dangling destination links",
		async () => {
			const { repo, worktree, cleanup } = fixture();
			try {
				write(repo, ".gitignore", "*.env\n");
				write(repo, ".worktreeinclude", "*.env\n");
				symlinkSync(join(repo, "README.md"), join(repo, "source.env"));
				write(repo, "destination.env");
				symlinkSync(join(worktree, "missing"), join(worktree, "destination.env"));
				await copyIncludedIgnoredPathsIntoWorktree(repo, worktree);
				expect(existsSync(join(worktree, "source.env"))).toBe(false);
				expect(lstatSync(join(worktree, "destination.env")).isSymbolicLink()).toBe(true);
				expect(existsSync(join(worktree, "missing"))).toBe(false);
			} finally {
				cleanup();
			}
		},
	);

	it("removes legacy dependency links without traversing symlink ancestors or local installs", async () => {
		const { root, repo, worktree, cleanup } = fixture();
		try {
			const outside = join(root, "outside");
			write(outside, "sentinel", "outside\n");
			mkdirSync(join(repo, "legacy"), { recursive: true });
			const linkType = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(outside, join(repo, "legacy/node_modules"), linkType);
			symlinkSync(join(repo, "legacy"), join(worktree, "legacy"), linkType);
			mkdirSync(join(worktree, "nested"));
			symlinkSync(outside, join(worktree, "nested/node_modules"), linkType);
			write(worktree, "node_modules/local", "local install\n");
			await cleanupLegacyDependencySymlinks(worktree);
			expect(existsSync(join(worktree, "nested/node_modules"))).toBe(false);
			expect(lstatSync(join(repo, "legacy/node_modules")).isSymbolicLink()).toBe(true);
			expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside\n");
			expect(readFileSync(join(worktree, "node_modules/local"), "utf8")).toBe("local install\n");
		} finally {
			cleanup();
		}
	});
});
