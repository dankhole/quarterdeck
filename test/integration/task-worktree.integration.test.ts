import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	archiveTaskWorktreeForTrash,
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir";
import { runGit } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function expectMirroredPathBehavior(path: string): void {
	const exists = existsSync(path);
	if (process.platform === "win32") {
		if (exists) {
			expect(lstatSync(path).isSymbolicLink()).toBe(true);
		}
		return;
	}
	expect(exists).toBe(true);
	expect(lstatSync(path).isSymbolicLink()).toBe(true);
}

describe.sequential("task-worktree integration", () => {
	it("returns a friendly error when the repository has no initial commit", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-unborn-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				const currentBranch = runGit(repoPath, ["symbolic-ref", "--short", "HEAD"]);
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-no-initial-commit",
					baseRef: currentBranch,
				});

				expect(ensured.ok).toBe(false);
				expect(ensured.error).toContain("does not have an initial commit yet");
				expect(ensured.error).toContain(`base ref "${currentBranch}"`);
			} finally {
				cleanup();
			}
		});
	});

	it("keeps symlinked ignored paths ignored in task worktrees", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				mkdirSync(join(repoPath, ".husky", "_"), { recursive: true });
				writeFileSync(join(repoPath, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
				writeFileSync(join(repoPath, ".husky", "_", ".gitignore"), "*\n", "utf8");
				writeFileSync(join(repoPath, ".husky", "_", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");

				runGit(repoPath, ["add", "README.md", ".husky/pre-commit"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const ignoredPaths = runGit(repoPath, [
					"ls-files",
					"--others",
					"--ignored",
					"--exclude-per-directory=.gitignore",
					"--directory",
				]);
				expect(ignoredPaths).toContain(".husky/_/");

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const huskyIgnoredPath = join(ensured.path, ".husky", "_");
				expectMirroredPathBehavior(huskyIgnoredPath);
				expect(runGit(ensured.path, ["status", "--porcelain", "--", ".husky/_"])).toBe("");
				if (existsSync(huskyIgnoredPath)) {
					expect(runGit(ensured.path, ["check-ignore", "-v", ".husky/_"])).toContain("info/exclude");
				}

				const ensuredAgain = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: "HEAD",
				});
				expect(ensuredAgain.ok).toBe(true);
				expect(runGit(ensured.path, ["status", "--porcelain", "--", ".husky/_"])).toBe("");
				expectMirroredPathBehavior(huskyIgnoredPath);
			} finally {
				cleanup();
			}
		});
	});

	it("mirrors safe ignored paths without sharing mutable dependencies or Agent Lab evidence", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-root-ignore-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				writeFileSync(
					join(repoPath, ".gitignore"),
					"/.next/\n/node_modules/\n/test-results/\n/.agent-lab-results/\n",
					"utf8",
				);
				mkdirSync(join(repoPath, ".next"), { recursive: true });
				mkdirSync(join(repoPath, "node_modules"), { recursive: true });
				mkdirSync(join(repoPath, "test-results", "agent-lab"), { recursive: true });
				mkdirSync(join(repoPath, ".agent-lab-results"), { recursive: true });
				writeFileSync(join(repoPath, ".next", "BUILD_ID"), "build\n", "utf8");
				writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "fixture"\n}\n', "utf8");
				writeFileSync(join(repoPath, "test-results", "agent-lab", "manifest.json"), "{}\n", "utf8");
				writeFileSync(join(repoPath, ".agent-lab-results", "manifest.json"), "{}\n", "utf8");

				runGit(repoPath, ["add", "README.md", ".gitignore"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-2",
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const nextPath = join(ensured.path, ".next");
				const nodeModulesPath = join(ensured.path, "node_modules");
				expectMirroredPathBehavior(nextPath);
				expect(existsSync(nodeModulesPath)).toBe(false);
				expect(existsSync(join(ensured.path, "test-results"))).toBe(false);
				expect(existsSync(join(ensured.path, ".agent-lab-results"))).toBe(false);
				expect(runGit(ensured.path, ["status", "--porcelain", "--", ".next"])).toBe("");
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "node_modules"])).toBe("");
				if (existsSync(nextPath)) {
					expect(runGit(ensured.path, ["check-ignore", "-v", ".next"])).toContain("info/exclude");
				}
			} finally {
				cleanup();
			}
		});
	});

	it("does not symlink mutable .NET build output paths into task worktrees", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-dotnet-output-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(join(repoPath, "src", "Service"), { recursive: true });
				mkdirSync(join(repoPath, "tests", "ServiceTests"), { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				writeFileSync(join(repoPath, "src", "Service", "Program.cs"), 'Console.WriteLine("hello");\n', "utf8");
				writeFileSync(
					join(repoPath, "tests", "ServiceTests", "ServiceTests.cs"),
					"namespace ServiceTests;\n",
					"utf8",
				);
				writeFileSync(
					join(repoPath, ".gitignore"),
					"/src/Service/bin/\n/src/Service/obj/\n/tests/ServiceTests/TestResults/\n/node_modules/\n",
					"utf8",
				);
				mkdirSync(join(repoPath, "src", "Service", "bin", "Debug"), { recursive: true });
				mkdirSync(join(repoPath, "src", "Service", "obj", "Debug"), { recursive: true });
				mkdirSync(join(repoPath, "tests", "ServiceTests", "TestResults"), { recursive: true });
				mkdirSync(join(repoPath, "node_modules"), { recursive: true });
				writeFileSync(join(repoPath, "src", "Service", "bin", "Debug", "Service.dll"), "binary\n", "utf8");
				writeFileSync(join(repoPath, "src", "Service", "obj", "Debug", "Service.assets.cache"), "cache\n", "utf8");
				writeFileSync(join(repoPath, "tests", "ServiceTests", "TestResults", "results.trx"), "results\n", "utf8");
				writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "fixture"\n}\n', "utf8");

				runGit(repoPath, [
					"add",
					"README.md",
					".gitignore",
					"src/Service/Program.cs",
					"tests/ServiceTests/ServiceTests.cs",
				]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-dotnet-output",
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				expect(existsSync(join(ensured.path, "src", "Service", "bin"))).toBe(false);
				expect(existsSync(join(ensured.path, "src", "Service", "obj"))).toBe(false);
				expect(existsSync(join(ensured.path, "tests", "ServiceTests", "TestResults"))).toBe(false);
				expect(existsSync(join(ensured.path, "node_modules"))).toBe(false);
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "src/Service/bin"])).toBe("");
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "src/Service/obj"])).toBe("");
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "tests/ServiceTests/TestResults"])).toBe("");
			} finally {
				cleanup();
			}
		});
	});

	it("removes an existing worktree node_modules symlink after its ignore rule changes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-root-turbopack-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
				writeFileSync(join(repoPath, ".gitignore"), "/node_modules/\n", "utf8");
				mkdirSync(join(repoPath, "node_modules"), { recursive: true });
				writeFileSync(join(repoPath, "node_modules", "sentinel.txt"), "primary dependencies intact\n", "utf8");

				runGit(repoPath, ["add", "README.md", "package.json", ".gitignore"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-root-turbopack",
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const nodeModulesPath = join(ensured.path, "node_modules");
				expect(existsSync(nodeModulesPath)).toBe(false);

				symlinkSync(
					join(repoPath, "node_modules"),
					nodeModulesPath,
					process.platform === "win32" ? "junction" : "dir",
				);
				expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(true);
				unlinkSync(join(repoPath, ".gitignore"));
				unlinkSync(join(ensured.path, ".gitignore"));

				const ensuredAgain = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-root-turbopack",
					baseRef: "HEAD",
				});
				expect(ensuredAgain.ok).toBe(true);
				expect(existsSync(nodeModulesPath)).toBe(false);
				expect(readFileSync(join(repoPath, "node_modules", "sentinel.txt"), "utf8")).toBe(
					"primary dependencies intact\n",
				);
			} finally {
				cleanup();
			}
		});
	});

	it("does not share node_modules at root or nested package roots", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-nested-turbopack-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				const appPath = join(repoPath, "apps", "web");
				mkdirSync(appPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
				writeFileSync(join(appPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
				writeFileSync(join(repoPath, ".gitignore"), "/node_modules/\n/apps/web/node_modules/\n", "utf8");
				mkdirSync(join(repoPath, "node_modules"), { recursive: true });
				mkdirSync(join(appPath, "node_modules"), { recursive: true });
				writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "root-fixture"\n}\n', "utf8");
				writeFileSync(join(appPath, "node_modules", "package.json"), '{\n  "name": "app-fixture"\n}\n', "utf8");

				runGit(repoPath, ["add", "README.md", "package.json", "apps/web/package.json", ".gitignore"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-nested-turbopack",
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const rootNodeModulesPath = join(ensured.path, "node_modules");
				const appNodeModulesPath = join(ensured.path, "apps", "web", "node_modules");
				expect(existsSync(rootNodeModulesPath)).toBe(false);
				expect(existsSync(appNodeModulesPath)).toBe(false);
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "node_modules"])).toBe("");
				expect(runGit(ensured.path, ["status", "--porcelain", "--", "apps/web/node_modules"])).toBe("");

				mkdirSync(appNodeModulesPath, { recursive: true });
				writeFileSync(join(appNodeModulesPath, "local-install.txt"), "task-owned\n", "utf8");
				const ensuredAgain = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-nested-turbopack",
					baseRef: "HEAD",
				});
				expect(ensuredAgain.ok).toBe(true);
				expect(readFileSync(join(appNodeModulesPath, "local-install.txt"), "utf8")).toBe("task-owned\n");
			} finally {
				cleanup();
			}
		});
	});

	it("restores a trashed task patch onto the saved commit", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-restore-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
				runGit(repoPath, ["add", "README.md", "tracked.txt"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const taskId = `task-restore-${Date.now()}`;
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const createdCommit = runGit(ensured.path, ["rev-parse", "HEAD"]);
				writeFileSync(join(ensured.path, "tracked.txt"), "base\nlocal change\n", "utf8");
				writeFileSync(join(ensured.path, "notes.txt"), "untracked\n", "utf8");

				const deleted = await deleteTaskWorktree({
					repoPath,
					taskId,
				});
				expect(deleted.ok).toBe(true);
				expect(deleted.removed).toBe(true);

				const patchPath = join(
					process.env.HOME ?? sandboxRoot,
					".quarterdeck",
					"trashed-task-patches",
					`${taskId}.${createdCommit}.patch`,
				);
				expect(existsSync(patchPath)).toBe(true);
				expect(readFileSync(patchPath, "utf8")).toContain("tracked.txt");
				expect(readFileSync(patchPath, "utf8")).toContain("notes.txt");

				writeFileSync(join(repoPath, "README.md"), "hello again\n", "utf8");
				runGit(repoPath, ["add", "README.md"]);
				runGit(repoPath, ["commit", "-m", "advance"]);
				const advancedCommit = runGit(repoPath, ["rev-parse", "HEAD"]);
				expect(advancedCommit).not.toBe(createdCommit);

				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(restored.ok).toBe(true);
				if (!restored.ok || !restored.path) {
					throw new Error("Task worktree was not restored");
				}

				expect(restored.baseCommit).toBe(createdCommit);
				expect(runGit(restored.path, ["rev-parse", "HEAD"])).toBe(createdCommit);
				expect(readFileSync(join(restored.path, "tracked.txt"), "utf8")).toBe("base\nlocal change\n");
				expect(readFileSync(join(restored.path, "notes.txt"), "utf8")).toBe("untracked\n");
				expect(existsSync(patchPath)).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("preserves an archived restore patch on replay and purges it idempotently on permanent delete", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-replay-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);
				writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
				runGit(repoPath, ["add", "tracked.txt"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const taskId = `task-archive-replay-${Date.now()}`;
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const createdCommit = runGit(ensured.path, ["rev-parse", "HEAD"]);
				writeFileSync(join(ensured.path, "tracked.txt"), "base\nrecover me\n", "utf8");
				const patchPath = join(
					process.env.HOME ?? sandboxRoot,
					".quarterdeck",
					"trashed-task-patches",
					`${taskId}.${createdCommit}.patch`,
				);

				const archived = await archiveTaskWorktreeForTrash({
					repoPath,
					taskId,
					operationId: "trash-operation",
				});
				expect(archived).toMatchObject({ ok: true, removed: true });
				expect(existsSync(patchPath)).toBe(true);
				const patchBeforeReplay = readFileSync(patchPath, "utf8");

				const replayedArchive = await archiveTaskWorktreeForTrash({
					repoPath,
					taskId,
					operationId: "trash-operation",
				});
				expect(replayedArchive).toMatchObject({ ok: true, removed: false });
				expect(readFileSync(patchPath, "utf8")).toBe(patchBeforeReplay);

				const purged = await purgeTaskWorkspaceForDelete({
					repoPath,
					taskId,
					operationId: "delete-operation",
				});
				const replayedPurge = await purgeTaskWorkspaceForDelete({
					repoPath,
					taskId,
					operationId: "delete-operation",
				});
				expect(purged).toMatchObject({ ok: true, removed: false });
				expect(replayedPurge).toMatchObject({ ok: true, removed: false });
				expect(existsSync(patchPath)).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("resumes a trashed task even when the saved patch is invalid", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-invalid-patch-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });

				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);

				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				runGit(repoPath, ["add", "README.md"]);
				runGit(repoPath, ["commit", "-m", "init"]);

				const taskId = `task-invalid-patch-${Date.now()}`;
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}

				const createdCommit = runGit(ensured.path, ["rev-parse", "HEAD"]);
				const deleted = await deleteTaskWorktree({
					repoPath,
					taskId,
				});
				expect(deleted.ok).toBe(true);

				const patchesDir = join(process.env.HOME ?? sandboxRoot, ".quarterdeck", "trashed-task-patches");
				mkdirSync(patchesDir, { recursive: true });
				const patchPath = join(patchesDir, `${taskId}.${createdCommit}.patch`);
				writeFileSync(
					patchPath,
					[
						"diff --git a/README.md b/README.md",
						"new file mode 100644",
						"index 0000000..1111111",
						"--- /dev/null",
						"+++ b/README.md",
						"@@ -0,0 +1 @@",
						"+hello",
						"GIT binary patch",
						"this-is-not-valid-binary-patch-data",
						"",
					].join("\n"),
					"utf8",
				);

				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(restored.ok).toBe(true);
				if (!restored.ok || !restored.path) {
					throw new Error("Task worktree was not restored");
				}

				expect(restored.warning).toContain("Saved task changes could not be reapplied automatically.");
				expect(runGit(restored.path, ["rev-parse", "HEAD"])).toBe(createdCommit);
			} finally {
				cleanup();
			}
		});
	});
});
