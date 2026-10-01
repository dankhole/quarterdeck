import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { updateRuntimeConfig } from "../../src/config/runtime-config";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { getRuntimeHomePath, loadProjectContext } from "../../src/state/project-state";
import {
	archiveTaskWorktreeForTrash,
	ensureTaskWorktreeIfDoesntExist,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir";
import * as gitUtils from "../../src/workdir/git-utils";
import { finishTaskWorktreeSetup } from "../../src/workdir/task-worktree-setup";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { captureTaskPatch } from "../utilities/legacy-task-worktree-patch";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

async function withFixture(run: (repoPath: string) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-trash-recovery-");
		try {
			initGitRepository(repoPath);
			writeFileSync(join(repoPath, ".gitignore"), ".gradle/\n");
			writeFileSync(join(repoPath, "tracked.txt"), "initial\n");
			commitAll(repoPath, "initial");
			await run(repoPath);
		} finally {
			cleanup();
		}
	});
}

async function createTask(repoPath: string, branch?: string): Promise<string> {
	const result = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task", baseRef: "main", branch });
	if (!result.ok) throw new Error(result.error);
	return result.path;
}

function recoveredFiles(): string[] {
	const root = join(getRuntimeHomePath(), "recovered-task-files");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

describe("Trash workspace recovery", { concurrent: false }, () => {
	it("retains detached commits, the index, untracked and ignored work until permanent deletion", async () => {
		await withFixture(async (repoPath) => {
			const path = await createTask(repoPath);
			writeFileSync(join(path, "detached.txt"), "detached work\n");
			const commit = commitAll(path, "detached task commit");
			writeFileSync(join(path, "tracked.txt"), "staged version\n");
			runGit(path, ["add", "tracked.txt"]);
			writeFileSync(join(path, "tracked.txt"), "unstaged version\n");
			writeFileSync(join(path, "notes.txt"), "untracked work\n");
			mkdirSync(join(path, ".gradle"));
			writeFileSync(join(path, ".gradle", "local-state"), "ignored work\n");
			const status = runGit(path, ["status", "--porcelain"]);
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({
					ok: true,
					removed: false,
				});
			}
			writeFileSync(join(repoPath, "advance.txt"), "base advances\n");
			commitAll(repoPath, "advance main");
			runGit(repoPath, ["reflog", "expire", "--expire=now", "--all"]);
			runGit(repoPath, ["gc", "--prune=now"]);
			const restored = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task",
				baseRef: "main",
				existingPath: path,
			});
			expect(restored).toMatchObject({ ok: true, path, baseCommit: commit });
			expect(runGit(path, ["show", ":tracked.txt"])).toBe("staged version");
			expect(runGit(path, ["status", "--porcelain"])).toBe(status);
			expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("unstaged version\n");
			expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("untracked work\n");
			expect(readFileSync(join(path, ".gradle", "local-state"), "utf8")).toBe("ignored work\n");
			expect(await purgeTaskWorkspaceForDelete({ repoPath, taskId: "task" })).toMatchObject({
				ok: true,
				removed: true,
			});
			expect(existsSync(path)).toBe(false);
		});
	});

	it("preserves a legacy Gradle residue before explicitly restoring the task branch", async () => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			writeFileSync(join(path, "task.txt"), "committed work\n");
			const commit = commitAll(path, "task work");
			runGit(repoPath, ["worktree", "remove", path]);
			mkdirSync(join(path, ".gradle", "daemon"), { recursive: true });
			writeFileSync(join(path, ".gradle", "daemon", "registry.bin"), "daemon registry\n");
			writeFileSync(join(path, "late-work.txt"), "preserve late writes\n");
			const input = { cwd: repoPath, taskId: "task", baseRef: "main", branch };
			expect(await ensureTaskWorktreeIfDoesntExist(input)).toMatchObject({ ok: false });
			expect(recoveredFiles()).toEqual([]);
			const restored = await ensureTaskWorktreeIfDoesntExist({ ...input, restoreFromTrash: true });
			expect(restored).toMatchObject({ ok: true, path, branch, baseCommit: commit });
			if (!restored.ok) throw new Error(restored.error);
			expect(restored.warning).toContain("recovered-task-files");
			expect(readFileSync(join(path, "task.txt"), "utf8")).toBe("committed work\n");
			const preserved = recoveredFiles();
			expect(preserved).toHaveLength(2);
			expect(preserved.map((file) => readFileSync(file, "utf8")).sort()).toEqual([
				"daemon registry\n",
				"preserve late writes\n",
			]);
		});
	});

	it.each(["registered without gitfile", "broken gitfile", "no saved identity"] as const)(
		"preserves ambiguous directories during legacy restore: %s",
		async (failure) => {
			await withFixture(async (repoPath) => {
				const path = await createTask(repoPath, "task-branch");
				if (failure === "registered without gitfile") unlinkSync(join(path, ".git"));
				else {
					runGit(repoPath, ["worktree", "remove", path]);
					mkdirSync(path, { recursive: true });
					if (failure === "broken gitfile") writeFileSync(join(path, ".git"), "gitdir: missing-admin\n");
				}
				writeFileSync(join(path, "keep.txt"), "original workspace\n");
				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task",
					baseRef: "main",
					branch: failure === "no saved identity" ? undefined : "task-branch",
					restoreFromTrash: true,
				});
				expect(restored.ok).toBe(false);
				expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("original workspace\n");
				expect(recoveredFiles()).toEqual([]);
			});
		},
	);

	it.each(["missing recovery source", "missing saved commit"] as const)(
		"does not substitute the latest base branch for a legacy task with %s",
		async (failure) => {
			await withFixture(async (repoPath) => {
				const path = await createTask(repoPath);
				let savedPatch: string | undefined;
				if (failure === "missing saved commit") {
					writeFileSync(join(path, "tracked.txt"), "saved task changes\n");
					await captureTaskPatch({ repoPath, taskId: "task", worktreePath: path });
					const patchesRoot = join(getRuntimeHomePath(), "trashed-task-patches");
					const originalPatch = readdirSync(patchesRoot)[0];
					savedPatch = join(patchesRoot, `task.${"0".repeat(40)}.patch`);
					renameSync(join(patchesRoot, originalPatch), savedPatch);
				}
				runGit(repoPath, ["worktree", "remove", "--force", path]);
				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task",
					baseRef: "main",
					restoreFromTrash: true,
				});
				expect(restored).toMatchObject({ ok: false });
				expect(existsSync(path)).toBe(false);
				if (savedPatch) expect(existsSync(savedPatch)).toBe(true);
			});
		},
	);

	it("restores a saved patch at its original commit without rewinding an advanced branch", async () => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			const originalCommit = runGit(path, ["rev-parse", "HEAD"]);
			writeFileSync(join(path, "tracked.txt"), "saved task changes\n");
			await captureTaskPatch({ repoPath, taskId: "task", worktreePath: path });
			runGit(repoPath, ["worktree", "remove", "--force", path]);
			runGit(repoPath, ["checkout", branch]);
			writeFileSync(join(repoPath, "tracked.txt"), "branch has advanced\n");
			const advancedCommit = commitAll(repoPath, "advance task branch");
			runGit(repoPath, ["checkout", "main"]);
			const restored = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task",
				baseRef: "main",
				branch,
				restoreFromTrash: true,
			});
			expect(restored).toMatchObject({ ok: true, baseCommit: originalCommit, branch: null });
			expect(runGit(repoPath, ["rev-parse", branch])).toBe(advancedCommit);
			expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("saved task changes\n");
		});
	});

	it("resumes a patch restore interrupted after apply without losing the saved changes", async () => {
		await withFixture(async (repoPath) => {
			const path = await createTask(repoPath);
			writeFileSync(join(path, "tracked.txt"), "saved task changes\n");
			await captureTaskPatch({ repoPath, taskId: "task", worktreePath: path });
			runGit(repoPath, ["worktree", "remove", "--force", path]);
			const originalWrite = lockedFileSystem.writeJsonFileAtomic;
			const spy = vi
				.spyOn(lockedFileSystem, "writeJsonFileAtomic")
				.mockImplementation(async (file, value, options) => {
					if (
						file.includes("quarterdeck-task-restores") &&
						typeof value === "object" &&
						value !== null &&
						"status" in value &&
						value.status === "applied"
					) {
						throw new Error("simulated interruption after apply");
					}
					return originalWrite.call(lockedFileSystem, file, value, options);
				});
			const input = { cwd: repoPath, taskId: "task", baseRef: "main", restoreFromTrash: true };
			try {
				expect(await ensureTaskWorktreeIfDoesntExist(input)).toMatchObject({
					ok: false,
					error: "simulated interruption after apply",
				});
				expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("saved task changes\n");
			} finally {
				spy.mockRestore();
			}
			expect(await ensureTaskWorktreeIfDoesntExist(input)).toMatchObject({ ok: true, path });
			expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("saved task changes\n");
			expect(readdirSync(join(getRuntimeHomePath(), "trashed-task-patches"))).toEqual([]);
		});
	});

	it.each([false, true])("blocks reuse of a failed registered checkout, with saved patch: %s", async (withPatch) => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			if (withPatch) {
				writeFileSync(join(path, "tracked.txt"), "saved task changes\n");
				await captureTaskPatch({ repoPath, taskId: "task", worktreePath: path });
			}
			runGit(repoPath, ["worktree", "remove", "--force", path]);
			const { projectId } = await loadProjectContext(repoPath);
			const script = "echo ran > setup-ran";
			await updateRuntimeConfig(projectId, { worktreeSetupScript: script });
			const hook = join(repoPath, ".git", "hooks", "post-checkout");
			writeFileSync(hook, "#!/bin/sh\nif git symbolic-ref -q HEAD >/dev/null; then exit 1; fi\nexit 0\n", {
				mode: 0o755,
			});
			const input = { cwd: repoPath, taskId: "task", baseRef: "main", branch, restoreFromTrash: true };
			expect(await ensureTaskWorktreeIfDoesntExist(input)).toMatchObject({ ok: false });
			expect(runGit(path, ["branch", "--show-current"])).toBe(branch);
			writeFileSync(join(path, "late.txt"), "preserve late writes\n");
			unlinkSync(hook);
			for (const retrySetup of [false, true]) {
				expect(await ensureTaskWorktreeIfDoesntExist({ ...input, retrySetup })).toMatchObject({
					ok: false,
					error: expect.stringContaining("Git worktree creation did not complete"),
				});
			}
			await expect(
				finishTaskWorktreeSetup({ repoPath, worktreePath: path, script, retrySetup: true }),
			).rejects.toThrow("Git worktree creation did not complete");
			expect(existsSync(join(path, "setup-ran"))).toBe(false);
			expect(readFileSync(join(path, "late.txt"), "utf8")).toBe("preserve late writes\n");
			expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("initial\n");
			if (withPatch) expect(readdirSync(join(getRuntimeHomePath(), "trashed-task-patches"))).toHaveLength(1);
		});
	});

	it("does not erase late files when a branch checkout fails", async () => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			runGit(repoPath, ["worktree", "remove", path]);
			const originalRunGit = gitUtils.runGit;
			const spy = vi.spyOn(gitUtils, "runGit").mockImplementation(async (cwd, args, options) => {
				if (args[0] === "worktree" && args[1] === "add") {
					mkdirSync(path, { recursive: true });
					writeFileSync(join(path, "late.txt"), "late daemon writes\n");
					return {
						ok: false,
						stdout: "",
						stderr: "checkout failed",
						output: "checkout failed",
						error: "checkout failed",
						exitCode: 1,
						timedOut: false,
					};
				}
				return originalRunGit(cwd, args, options);
			});
			try {
				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task",
					baseRef: "main",
					branch,
					restoreFromTrash: true,
				});
				expect(restored.ok).toBe(false);
				expect(readFileSync(join(path, "late.txt"), "utf8")).toBe("late daemon writes\n");
			} finally {
				spy.mockRestore();
			}
		});
	});
});
