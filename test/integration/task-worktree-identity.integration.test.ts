import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadProjectState, saveProjectState } from "../../src/state";
import {
	archiveTaskWorktreeForTrash,
	ensureTaskWorktreeIfDoesntExist,
	getTaskRepositoryInfo,
	purgeTaskWorkspaceForDelete,
	resolveTaskCwd,
	resolveTaskWorkingDirectory,
} from "../../src/workdir";
import { runGit } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

describe("task worktree registration identity", { concurrent: false }, () => {
	it.each([false, true])("preserves a broken task directory when registration is reused: %s", async (reused) => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-worktree-identity-");
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath);
				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Quarterdeck Test"]);
				runGit(repoPath, ["config", "user.email", "quarterdeck-test@example.com"]);
				writeFileSync(join(repoPath, "README.md"), "initial\n");
				runGit(repoPath, ["add", "."]);
				runGit(repoPath, ["commit", "-m", "initial"]);
				const options = { cwd: repoPath, taskId: "original", baseRef: "HEAD" };
				const original = await ensureTaskWorktreeIfDoesntExist(options);
				if (!original.ok || !original.path) throw new Error(JSON.stringify(original));
				const gitFile = readFileSync(join(original.path, ".git"), "utf8");
				const adminPath = gitFile.trim().replace(/^gitdir: /, "");
				writeFileSync(join(original.path, "README.md"), "task progress\n");
				writeFileSync(join(original.path, "untracked.txt"), "uncommitted work\n");
				rmSync(adminPath, { recursive: true, force: true });

				let replacementPath: string | null = null;
				let replacementHead: string | null = null;
				let replacementIndex: Buffer | null = null;
				if (reused) {
					const replacement = await ensureTaskWorktreeIfDoesntExist({ ...options, taskId: "replacement" });
					if (!replacement.ok || !replacement.path) throw new Error(JSON.stringify(replacement));
					replacementPath = replacement.path;
					replacementHead = runGit(replacementPath, ["rev-parse", "HEAD"]);
					replacementIndex = readFileSync(join(adminPath, "index"));
					expect(readFileSync(join(replacementPath, ".git"), "utf8")).toBe(gitFile);
					// Git accepts the stale pointer, even though its backlink belongs to another task.
					expect(runGit(original.path, ["rev-parse", "HEAD"])).toBe(
						runGit(replacementPath, ["rev-parse", "HEAD"]),
					);
				}

				const ensured = await ensureTaskWorktreeIfDoesntExist(options);
				expect(ensured).toMatchObject({ ok: false });
				expect(ensured.error).toContain("Git worktree registration");
				await expect(resolveTaskCwd(options)).rejects.toThrow("Git worktree registration");
				const state = await loadProjectState(repoPath);
				state.board.columns[0]?.cards.push({
					id: options.taskId,
					title: "Original task",
					prompt: "Synthetic task",
					baseRef: options.baseRef,
					useWorktree: true,
					workingDirectory: original.path,
					createdAt: 1,
					updatedAt: 1,
				});
				await saveProjectState(repoPath, { board: state.board, sessions: {}, expectedRevision: state.revision });
				await expect(
					resolveTaskWorkingDirectory({ projectPath: repoPath, taskId: options.taskId, baseRef: options.baseRef }),
				).rejects.toThrow("Git worktree registration");
				await expect(getTaskRepositoryInfo(options)).rejects.toThrow("Git worktree registration");
				for (const remove of [archiveTaskWorktreeForTrash, purgeTaskWorkspaceForDelete]) {
					const result = await remove({ repoPath, taskId: options.taskId });
					expect(result).toMatchObject({ ok: false, removed: false });
				}
				expect(readFileSync(join(original.path, "README.md"), "utf8")).toBe("task progress\n");
				expect(readFileSync(join(original.path, "untracked.txt"), "utf8")).toBe("uncommitted work\n");
				expect(readFileSync(join(original.path, ".git"), "utf8")).toBe(gitFile);
				if (replacementPath) {
					expect(runGit(replacementPath, ["rev-parse", "HEAD"])).toBe(replacementHead);
					expect(readFileSync(join(adminPath, "index"))).toEqual(replacementIndex);
					expect(runGit(replacementPath, ["status", "--porcelain"])).toBe("");
					expect(realpathSync(readFileSync(join(adminPath, "gitdir"), "utf8").trim())).toBe(
						realpathSync(join(replacementPath, ".git")),
					);
				}
			} finally {
				cleanup();
			}
		});
	});
});
