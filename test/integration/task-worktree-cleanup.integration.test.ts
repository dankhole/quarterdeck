import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as gitUtils from "../../src/workdir/git-utils";
import { getTaskWorktreePath, purgeTaskWorkspaceForDelete } from "../../src/workdir/task-worktree-lifecycle";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

describe("task worktree cleanup", { concurrent: false }, () => {
	it.each(["remove fails", "directory already missing", "prune fails"] as const)(
		"permanent delete releases the branch when %s",
		async (failure) => {
			await withTemporaryHome(async () => {
				const { path: repoPath, cleanup } = createTempDir("quarterdeck-worktree-cleanup-");
				const originalRunGit = gitUtils.runGit;
				const gitSpy = vi.spyOn(gitUtils, "runGit");
				try {
					initGitRepository(repoPath);
					writeFileSync(join(repoPath, "tracked.txt"), "initial\n");
					commitAll(repoPath, "initial");
					const taskId = "cleanup-task";
					const branch = "task-branch";
					const worktreePath = getTaskWorktreePath(repoPath, taskId);
					mkdirSync(worktreePath, { recursive: true });
					runGit(repoPath, ["worktree", "add", "-b", branch, worktreePath]);
					if (failure === "directory already missing") {
						rmSync(worktreePath, { recursive: true, force: true });
					}
					expect(() => runGit(repoPath, ["checkout", branch])).toThrow();

					gitSpy.mockImplementation(async (cwd, args, options) => {
						if (
							args[0] === "worktree" &&
							(args[1] === "remove" || (failure === "prune fails" && args[1] === "prune"))
						) {
							return {
								ok: false,
								stdout: "",
								stderr: "Injected Git cleanup failure",
								output: "Injected Git cleanup failure",
								error: "Injected Git cleanup failure",
								exitCode: 1,
								timedOut: false,
							};
						}
						return await originalRunGit(cwd, args, options);
					});

					const result = await purgeTaskWorkspaceForDelete({ repoPath, taskId });
					if (failure === "prune fails") {
						expect(result).toMatchObject({ ok: false, error: expect.stringContaining("cleanup failure") });
						expect(existsSync(worktreePath)).toBe(false);
						gitSpy.mockImplementation(originalRunGit);
						expect(await purgeTaskWorkspaceForDelete({ repoPath, taskId })).toMatchObject({
							ok: true,
							removed: false,
						});
					} else {
						expect(result).toMatchObject({ ok: true, removed: failure !== "directory already missing" });
					}
					expect(existsSync(worktreePath)).toBe(false);
					expect(runGit(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(
						`branch refs/heads/${branch}`,
					);
					runGit(repoPath, ["checkout", branch]);
					expect(runGit(repoPath, ["branch", "--show-current"])).toBe(branch);
				} finally {
					gitSpy.mockRestore();
					cleanup();
				}
			});
		},
	);
});
