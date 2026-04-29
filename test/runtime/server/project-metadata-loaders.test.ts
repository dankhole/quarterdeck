import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core";
import {
	collectTrackedTasks,
	loadTaskWorktreeMetadata,
	loadTaskWorktreeMetadataBatch,
	resolveTaskWorktreeMetadataInput,
} from "../../../src/server/project-metadata-loaders";
import { commitAll, initGitRepository, runGit } from "../../utilities/git-env";
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

	it("loads non-base git metadata when a task base ref is unresolved", async () => {
		const { path: projectPath, cleanup } = createTempDir("quarterdeck-unresolved-base-metadata-");
		try {
			mkdirSync(projectPath, { recursive: true });
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
			commitAll(projectPath, "seed");
			writeFileSync(join(projectPath, "README.md"), "changed\n", "utf8");

			const metadata = await loadTaskWorktreeMetadata(
				projectPath,
				{
					taskId: "task-1",
					baseRef: "",
					workingDirectory: null,
					useWorktree: false,
				},
				null,
			);

			expect(metadata?.data).toMatchObject({
				taskId: "task-1",
				path: projectPath,
				exists: true,
				baseRef: "",
				branch: "main",
				changedFiles: 1,
				hasUnmergedChanges: null,
				behindBaseCount: null,
			});
			expect(metadata?.baseRefCommit).toBeNull();
			expect(metadata?.originBaseRefCommit).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("projects different base refs independently for tasks sharing the project checkout", async () => {
		const { path: projectPath, cleanup } = createTempDir("quarterdeck-shared-base-ref-metadata-");
		try {
			mkdirSync(projectPath, { recursive: true });
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
			commitAll(projectPath, "seed");
			runGit(projectPath, ["checkout", "-qb", "develop"]);
			writeFileSync(join(projectPath, "develop.txt"), "develop\n", "utf8");
			commitAll(projectPath, "develop commit");
			runGit(projectPath, ["checkout", "main"]);
			writeFileSync(join(projectPath, "main.txt"), "main\n", "utf8");
			commitAll(projectPath, "main commit");

			const tasks = [
				{
					taskId: "task-main",
					baseRef: "main",
					workingDirectory: null,
					useWorktree: false,
				},
				{
					taskId: "task-develop",
					baseRef: "develop",
					workingDirectory: null,
					useWorktree: false,
				},
			];
			const inputs = await Promise.all(
				tasks.map((task) => resolveTaskWorktreeMetadataInput(projectPath, task, null)),
			);
			const loaded = await loadTaskWorktreeMetadataBatch(inputs);
			const byTaskId = new Map(loaded.map((entry) => [entry.taskId, entry.metadata?.data] as const));

			expect(byTaskId.get("task-main")).toMatchObject({
				taskId: "task-main",
				path: projectPath,
				exists: true,
				baseRef: "main",
				behindBaseCount: 0,
			});
			expect(byTaskId.get("task-develop")).toMatchObject({
				taskId: "task-develop",
				path: projectPath,
				exists: true,
				baseRef: "develop",
				behindBaseCount: 1,
			});
		} finally {
			cleanup();
		}
	});

	it("keeps the not-created metadata shape for missing isolated worktrees", async () => {
		const { path: projectPath, cleanup } = createTempDir("quarterdeck-missing-worktree-metadata-");
		try {
			const missingWorktreePath = join(projectPath, "missing-worktree");
			const metadata = await loadTaskWorktreeMetadata(
				projectPath,
				{
					taskId: "task-1",
					baseRef: "main",
					workingDirectory: missingWorktreePath,
					useWorktree: true,
				},
				null,
			);

			expect(metadata?.data).toMatchObject({
				taskId: "task-1",
				path: missingWorktreePath,
				exists: false,
				baseRef: "main",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				behindBaseCount: null,
				conflictState: null,
			});
			expect(metadata?.stateToken).toBeNull();
			expect(metadata?.baseRefCommit).toBeNull();
			expect(metadata?.originBaseRefCommit).toBeNull();
			expect(metadata?.lastKnownBranch).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("preserves cached task metadata when an existing path fails git probing", async () => {
		const { path: projectPath, cleanup } = createTempDir("quarterdeck-task-metadata-probe-failure-");
		try {
			mkdirSync(projectPath, { recursive: true });
			const current = {
				data: {
					taskId: "task-1",
					path: projectPath,
					exists: true,
					baseRef: "main",
					branch: "cached-branch",
					isDetached: false,
					headCommit: "cached-head",
					changedFiles: 2,
					additions: 3,
					deletions: 1,
					hasUnmergedChanges: true,
					behindBaseCount: 4,
					conflictState: null,
					stateVersion: 123,
				},
				stateToken: "cached-state",
				baseRefCommit: "cached-base",
				originBaseRefCommit: "cached-origin-base",
				lastKnownBranch: "cached-branch",
			};

			const metadata = await loadTaskWorktreeMetadata(
				projectPath,
				{
					taskId: "task-1",
					baseRef: "main",
					workingDirectory: null,
					useWorktree: false,
				},
				current,
			);

			expect(metadata).toBe(current);
		} finally {
			cleanup();
		}
	});
});
