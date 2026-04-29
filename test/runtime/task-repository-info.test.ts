import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core";
import { loadProjectState, saveProjectState } from "../../src/state";
import { ensureTaskWorktreeIfDoesntExist, getTaskRepositoryInfo, resolveTaskWorkingDirectory } from "../../src/workdir";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function createSharedCheckoutBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: "Shared task",
						baseRef: "main",
						useWorktree: false,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe.sequential("task repository info", () => {
	it("uses the project checkout for shared tasks even when an old task worktree still exists", async () => {
		await withTemporaryHome(async () => {
			const { path: projectPath, cleanup } = createTempDir("quarterdeck-shared-task-info-");
			try {
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
				commitAll(projectPath, "seed");

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: projectPath,
					taskId: "task-1",
					baseRef: "main",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok) {
					throw new Error(ensured.error ?? "Expected stale task worktree to be created.");
				}
				expect(ensured.path).not.toBe(resolve(projectPath));

				const initial = await loadProjectState(projectPath);
				await saveProjectState(projectPath, {
					board: createSharedCheckoutBoard(),
					sessions: {},
					expectedRevision: initial.revision,
				});

				await expect(
					resolveTaskWorkingDirectory({
						projectPath,
						taskId: "task-1",
						baseRef: "main",
					}),
				).resolves.toBe(resolve(projectPath));

				const info = await getTaskRepositoryInfo({
					cwd: projectPath,
					taskId: "task-1",
					baseRef: "main",
				});

				expect(info).toMatchObject({
					taskId: "task-1",
					path: resolve(projectPath),
					exists: true,
					baseRef: "main",
					branch: "main",
				});
			} finally {
				cleanup();
			}
		});
	});
});
