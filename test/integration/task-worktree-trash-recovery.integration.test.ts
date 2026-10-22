import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { updateRuntimeConfig } from "../../src/config/runtime-config";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { ProjectTaskLifecycleService } from "../../src/server/project-task-lifecycle-service";
import { ProjectBoardCommandService } from "../../src/state/project-board-command-service";
import { getRuntimeHomePath, loadProjectContext } from "../../src/state/project-state";
import {
	archiveTaskWorktreeForTrash,
	ensureTaskWorktreeIfDoesntExist,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir";
import * as gitUtils from "../../src/workdir/git-utils";
import { finishTaskWorktreeSetup } from "../../src/workdir/task-worktree-setup";
import {
	completeTaskWorktreeTrashRestore,
	restoreTaskWorktreeBranchFromTrash,
} from "../../src/workdir/task-worktree-trash-branch";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { captureTaskPatch } from "../utilities/legacy-task-worktree-patch";
import { useProcessTestBudget } from "../utilities/process-test-budget";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

useProcessTestBudget();

async function withFixture(run: (repoPath: string) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const { path: repoPath, cleanupAsync } = createTempDir("quarterdeck-trash-recovery-");
		try {
			initGitRepository(repoPath);
			writeFileSync(join(repoPath, ".gitignore"), ".gradle/\n");
			writeFileSync(join(repoPath, "tracked.txt"), "initial\n");
			commitAll(repoPath, "initial");
			await run(repoPath);
		} finally {
			// This fixture runs many real `git worktree`/registration operations
			// (including deliberately corrupting a worktree's `.git` file). On
			// Windows a just-exited git process can hold file handles open for a
			// moment after Node observes it as closed; synchronous `cleanup()`
			// retries block the event loop and can't let that handle close land,
			// which surfaces as EPERM deleting `.git`. The async variant lets
			// pending native handle closes actually run between retries.
			await cleanupAsync();
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

function branchMarkerPath(path: string): string {
	return join(runGit(path, ["rev-parse", "--absolute-git-dir"]), "quarterdeck-trash-branch.json");
}

async function restoreRetained(repoPath: string, path: string, branch = "stale-card-branch") {
	return await ensureTaskWorktreeIfDoesntExist({
		cwd: repoPath,
		taskId: "task",
		baseRef: "main",
		existingPath: path,
		branch,
		reattachFromTrash: true,
	});
}

describe("Trash workspace recovery", { concurrent: false }, () => {
	it("distinguishes an uncreated workspace from a missing registered workspace", async () => {
		await withFixture(async (repoPath) => {
			const uncreated = { repoPath, taskId: "uncreated" };
			expect(await archiveTaskWorktreeForTrash(uncreated)).toMatchObject({ ok: true });
			expect(await restoreTaskWorktreeBranchFromTrash(uncreated)).toBeUndefined();
			await expect(completeTaskWorktreeTrashRestore(uncreated)).resolves.toBeUndefined();
			const path = await createTask(repoPath, "retained-branch");
			rmSync(path, { recursive: true });
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({
				ok: false,
				error: expect.stringContaining("registered task worktree is unavailable"),
			});
			expect(await restoreTaskWorktreeBranchFromTrash({ repoPath, taskId: "task" })).toContain("registration");
			expect(runGit(repoPath, ["worktree", "list", "--porcelain", "-z"])).toContain(
				"branch refs/heads/retained-branch\0",
			);
		});
	});

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
				branch: "main",
				reattachFromTrash: true,
			});
			expect(restored).toMatchObject({ ok: true, path, baseCommit: commit, branch: null });
			expect(existsSync(branchMarkerPath(path))).toBe(false);
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

	it("releases the actual branch and restores its attachment without changing index bytes, files, or running hooks", async () => {
		await withFixture(async (repoPath) => {
			const branch = "actual-task-branch";
			const path = await createTask(repoPath, branch);
			writeFileSync(join(path, "committed.txt"), "task commit\n");
			const commit = commitAll(path, "task work");
			writeFileSync(join(path, "tracked.txt"), "staged work\n");
			runGit(path, ["add", "tracked.txt"]);
			writeFileSync(join(path, "tracked.txt"), "unstaged work\n");
			writeFileSync(join(path, "untracked.txt"), "untracked work\n");
			mkdirSync(join(path, ".gradle"));
			writeFileSync(join(path, ".gradle", "ignored"), "ignored work\n");
			const gitDir = runGit(path, ["rev-parse", "--absolute-git-dir"]);
			const index = readFileSync(join(gitDir, "index"));
			const status = runGit(path, ["--no-optional-locks", "status", "--porcelain"]);
			const hooks = join(repoPath, ".git", "hooks");
			for (const hook of ["post-checkout", "reference-transaction"]) {
				writeFileSync(join(hooks, hook), "#!/bin/sh\necho hook > tracked.txt\ngit add tracked.txt\nexit 1\n", {
					mode: 0o755,
				});
			}
			const input = { repoPath, taskId: "task", existingPath: path };
			expect(await archiveTaskWorktreeForTrash(input)).toEqual({ ok: true, removed: false });
			const marker = readFileSync(branchMarkerPath(path), "utf8");
			expect(JSON.parse(marker)).toMatchObject({ branchRef: `refs/heads/${branch}`, commit });
			expect(runGit(path, ["branch", "--show-current"])).toBe("");
			expect(runGit(repoPath, ["rev-parse", branch])).toBe(commit);
			expect(await archiveTaskWorktreeForTrash(input)).toEqual({ ok: true, removed: false });
			expect(readFileSync(branchMarkerPath(path), "utf8")).toBe(marker);
			for (const hook of ["post-checkout", "reference-transaction"]) unlinkSync(join(hooks, hook));
			// Git itself now admits the formerly reserved branch in another checkout.
			runGit(repoPath, ["checkout", branch]);
			runGit(repoPath, ["checkout", "main"]);
			for (const hook of ["post-checkout", "reference-transaction"]) {
				writeFileSync(join(hooks, hook), "#!/bin/sh\necho hook > tracked.txt\ngit add tracked.txt\nexit 1\n", {
					mode: 0o755,
				});
			}
			// Ordinary Start cannot consume the origin or attach HEAD.
			expect(
				await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task",
					baseRef: "main",
					branch,
					existingPath: path,
				}),
			).toMatchObject({ branch: null });
			expect(await restoreRetained(repoPath, path)).toMatchObject({
				ok: true,
				path,
				branch,
				baseCommit: commit,
				warning: undefined,
			});
			expect(readFileSync(join(gitDir, "index"))).toEqual(index);
			expect(runGit(path, ["--no-optional-locks", "status", "--porcelain"])).toBe(status);
			expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("unstaged work\n");
			expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("untracked work\n");
			expect(readFileSync(join(path, ".gradle", "ignored"), "utf8")).toBe("ignored work\n");
			// Lost restore response reuses an attachment, then completion consumes origin.
			expect(await restoreRetained(repoPath, path)).toMatchObject({ ok: true, branch, warning: undefined });
			await completeTaskWorktreeTrashRestore({ repoPath, taskId: "task", existingPath: path });
			expect(existsSync(branchMarkerPath(path))).toBe(false);
		});
	});

	it.each(["occupied", "moved", "deleted", "checkout changed"] as const)(
		"keeps the checkout detached when its original branch cannot be restored: %s",
		async (reason) => {
			await withFixture(async (repoPath) => {
				const branch = "task-branch";
				const path = await createTask(repoPath, branch);
				const saved = runGit(path, ["rev-parse", "HEAD"]);
				expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: true });
				if (reason === "occupied") runGit(repoPath, ["checkout", branch]);
				if (reason === "deleted") runGit(repoPath, ["branch", "-D", branch]);
				if (reason === "moved" || reason === "checkout changed") {
					writeFileSync(join(repoPath, "advance.txt"), "advanced\n");
					const advanced = commitAll(repoPath, "advance main");
					runGit(reason === "moved" ? repoPath : path, [
						"update-ref",
						"--no-deref",
						reason === "moved" ? `refs/heads/${branch}` : "HEAD",
						advanced,
					]);
				}
				const head = runGit(path, ["rev-parse", "HEAD"]);
				const restored = await restoreRetained(repoPath, path, branch);
				expect(restored).toMatchObject({
					ok: true,
					branch: null,
					baseCommit: head,
					warning: expect.stringContaining("could not be reattached"),
				});
				expect(runGit(path, ["rev-parse", "HEAD"])).toBe(head);
				if (reason !== "moved" && reason !== "deleted") expect(runGit(repoPath, ["rev-parse", branch])).toBe(saved);
				await completeTaskWorktreeTrashRestore({ repoPath, taskId: "task", existingPath: path });
				expect(existsSync(branchMarkerPath(path))).toBe(false);
			});
		},
	);

	it.each([
		"rebase-merge",
		"rebase-apply",
		"MERGE_HEAD",
		"sequencer",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"BISECT_START",
		"index.lock",
	])("preserves Git operation state during Trash and Restore: %s", async (operation) => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			const operationPath = join(runGit(path, ["rev-parse", "--absolute-git-dir"]), operation);
			writeFileSync(operationPath, "operation state\n");
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({
				ok: false,
				error: expect.stringContaining("Git operation is in progress"),
			});
			expect(runGit(path, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${branch}`);
			expect(existsSync(branchMarkerPath(path))).toBe(false);
			expect(readFileSync(operationPath, "utf8")).toBe("operation state\n");
			unlinkSync(operationPath);
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: true });
			writeFileSync(operationPath, "operation state\n");
			expect(await restoreRetained(repoPath, path)).toMatchObject({
				ok: true,
				branch: null,
				warning: expect.stringContaining("Git operation is in progress"),
			});
			expect(readFileSync(operationPath, "utf8")).toBe("operation state\n");
		});
	});

	it("replays detach intent after interruption and rejects missing or mismatched workspace ownership", async () => {
		await withFixture(async (repoPath) => {
			const branch = "task-branch";
			const path = await createTask(repoPath, branch);
			const original = gitUtils.runGit;
			const spy = vi.spyOn(gitUtils, "runGit").mockImplementation(async (cwd, args, options) => {
				if (args.includes("update-ref")) throw new Error("interrupted before detach");
				return original(cwd, args, options);
			});
			try {
				expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: false });
			} finally {
				spy.mockRestore();
			}
			const marker = readFileSync(branchMarkerPath(path), "utf8");
			expect(runGit(path, ["branch", "--show-current"])).toBe(branch);
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: true });
			expect(readFileSync(branchMarkerPath(path), "utf8")).toBe(marker);
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task", existingPath: repoPath })).toMatchObject({
				ok: false,
				error: expect.stringContaining("outside its managed folder"),
			});
			const other = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "other",
				branch: "other-branch",
				baseRef: "main",
			});
			if (!other.ok) throw new Error(other.error);
			writeFileSync(join(path, ".git"), readFileSync(join(other.path, ".git")));
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({
				ok: false,
				error: expect.stringContaining("registration"),
			});
			expect(runGit(other.path, ["branch", "--show-current"])).toBe("other-branch");
		});
	});

	it.each(["rebase", "bisect"] as const)(
		"honors another detached worktree's native %s branch reservation",
		async (operation) => {
			await withFixture(async (repoPath) => {
				const branch = "task-branch";
				const path = await createTask(repoPath, branch);
				const initial = runGit(path, ["rev-parse", "HEAD"]);
				writeFileSync(join(path, "tracked.txt"), "task change\n");
				commitAll(path, "task change");
				writeFileSync(join(path, "task.txt"), "another commit\n");
				const saved = commitAll(path, "second task change");
				expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: true });
				writeFileSync(join(repoPath, "tracked.txt"), "conflicting main change\n");
				commitAll(repoPath, "main change");
				const other = join(repoPath, "other-checkout");
				runGit(repoPath, ["worktree", "add", other, branch]);
				if (operation === "rebase") {
					expect((await gitUtils.runGit(other, ["rebase", "main"])).ok).toBe(false);
				} else runGit(other, ["bisect", "start", saved, initial]);
				expect(runGit(other, ["branch", "--show-current"])).toBe("");
				// Native display alone misses this branch reservation on Git 2.52.
				expect(runGit(repoPath, ["for-each-ref", "--format=%(worktreepath)", `refs/heads/${branch}`])).toBe("");
				expect(await restoreRetained(repoPath, path)).toMatchObject({
					ok: true,
					branch: null,
					warning: expect.stringContaining("reserved by another worktree"),
				});
				expect(runGit(path, ["rev-parse", "HEAD"])).toBe(saved);
			});
		},
	);

	it("keeps the checkout detached if Git does not support safe symbolic-ref transactions", async () => {
		await withFixture(async (repoPath) => {
			const path = await createTask(repoPath, "task-branch");
			expect(await archiveTaskWorktreeForTrash({ repoPath, taskId: "task" })).toMatchObject({ ok: true });
			const original = gitUtils.runGit;
			const spy = vi.spyOn(gitUtils, "runGit").mockImplementation(async (cwd, args, options) => {
				if (options?.stdin?.includes("symref-update"))
					return original(cwd, args, { ...options, stdin: "unsupported-symref-update\n" });
				return original(cwd, args, options);
			});
			try {
				expect(await restoreRetained(repoPath, path)).toMatchObject({
					ok: true,
					branch: null,
					warning: expect.stringContaining("Git could not safely reattach"),
				});
			} finally {
				spy.mockRestore();
			}
		});
	});

	it("consumes branch origin after lifecycle Restore when the card has no persisted workspace path", async () => {
		await withFixture(async (repoPath) => {
			const branch = "actual-branch";
			const path = await createTask(repoPath, branch);
			const { projectId } = await loadProjectContext(repoPath);
			const scope = { projectId, projectPath: repoPath };
			const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
			const seeded = await boardCommands.execute(scope, {
				commandId: "seed-pathless-card",
				expectedRevision: 0,
				command: {
					kind: "create_task",
					taskId: "task",
					createdAt: 100,
					title: null,
					prompt: "Retained workspace",
					agentId: "codex",
					baseRef: "main",
					useWorktree: true,
					branch: "stale-card-branch",
					columnId: "in_progress",
				},
			});
			const lifecycle = new ProjectTaskLifecycleService({
				boardCommands,
				startTaskSession: async (_scope, request) => ({
					ok: true,
					summary: createTestTaskSessionSummary({
						taskId: "task",
						state: "awaiting_review",
						startedAt: 300,
						launchOperationId: request.launchOperationId,
					}),
				}),
			});
			const trashed = await lifecycle.execute(scope, {
				kind: "trash",
				operationId: "trash-pathless",
				taskId: "task",
				taskCreatedAt: 100,
				sourceColumnId: "in_progress",
				expectedRevision: seeded.state.revision,
			});
			expect(trashed.ok).toBe(true);
			expect(existsSync(branchMarkerPath(path))).toBe(true);
			const restored = await lifecycle.execute(scope, {
				kind: "restore",
				operationId: "restore-pathless",
				taskId: "task",
				taskCreatedAt: 100,
				expectedRevision: trashed.state.revision,
			});
			expect(restored.ok).toBe(true);
			expect(restored.warning).toBeUndefined();
			expect(runGit(path, ["branch", "--show-current"])).toBe(branch);
			expect(existsSync(branchMarkerPath(path))).toBe(false);
			writeFileSync(join(path, "new-work.txt"), "new work after restore\n");
			const commit = commitAll(path, "new work");
			const trashedAgain = await lifecycle.execute(scope, {
				kind: "trash",
				operationId: "trash-again-pathless",
				taskId: "task",
				taskCreatedAt: 100,
				sourceColumnId: "review",
				expectedRevision: restored.state.revision,
			});
			expect(trashedAgain.ok).toBe(true);
			expect(trashedAgain.warning).toBeUndefined();
			expect(runGit(path, ["branch", "--show-current"])).toBe("");
			expect(JSON.parse(readFileSync(branchMarkerPath(path), "utf8"))).toMatchObject({
				branchRef: `refs/heads/${branch}`,
				commit,
			});
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
