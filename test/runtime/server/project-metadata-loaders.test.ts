import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core";
import { collectTrackedTasks, loadTaskWorktreeMetadata } from "../../../src/server/project-metadata-loaders";
import { commitAll, initGitRepository } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function createBoard(useWorktree: boolean): RuntimeBoardData {
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
						useWorktree,
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

describe("project metadata loaders", () => {
	it("tracks whether active tasks use an isolated worktree", () => {
		expect(collectTrackedTasks(createBoard(false))).toEqual([
			{
				taskId: "task-1",
				baseRef: "main",
				workingDirectory: null,
				useWorktree: false,
			},
		]);
	});

	it("loads metadata for non-isolated tasks from the project checkout", async () => {
		const { path: projectPath, cleanup } = createTempDir("quarterdeck-shared-task-metadata-");
		try {
			mkdirSync(projectPath, { recursive: true });
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
			commitAll(projectPath, "seed");

			const metadata = await loadTaskWorktreeMetadata(
				projectPath,
				{
					taskId: "task-1",
					baseRef: "main",
					workingDirectory: null,
					useWorktree: false,
				},
				null,
			);

			expect(metadata?.data).toMatchObject({
				taskId: "task-1",
				path: projectPath,
				exists: true,
				baseRef: "main",
				branch: "main",
			});
		} finally {
			cleanup();
		}
	});
});
