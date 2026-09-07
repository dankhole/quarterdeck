import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProjectTaskLifecycleService } from "../../src/server/project-task-lifecycle-service";
import { loadProjectContext, loadProjectState, ProjectBoardCommandService } from "../../src/state";
import { getProjectLifecycleOperationsPath } from "../../src/state/project-state-utils";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

it("clears exact Trash identities, retains cleanup failures, and safely replays child receipts", async () => {
	await withTemporaryHome(async () => {
		const temp = createTempDir("clear-trash-");
		try {
			const projectPath = join(temp.path, "project");
			mkdirSync(projectPath);
			initGitRepository(projectPath);
			const { projectId } = await loadProjectContext(projectPath);
			const scope = { projectId, projectPath };
			const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
			let revision = (await loadProjectState(projectPath)).revision;
			for (const taskId of ["one", "two", "changed", "review"]) {
				const result = await boardCommands.execute(scope, {
					commandId: `seed-${taskId}`,
					expectedRevision: revision,
					command: {
						kind: "create_task",
						columnId: taskId === "review" ? "review" : "trash",
						taskId,
						createdAt: 100,
						title: "Synthetic",
						prompt: "Synthetic",
						agentId: "codex",
						baseRef: "main",
						useWorktree: true,
					},
				});
				revision = result.state.revision;
			}
			const purgeTaskWorkspace = vi.fn(async ({ taskId }: { taskId: string }) => ({
				ok: taskId !== "two",
				removed: taskId !== "two",
				error: taskId === "two" ? "Synthetic cleanup failure" : undefined,
			}));
			const lifecycle = new ProjectTaskLifecycleService({
				boardCommands,
				purgeTaskWorkspace,
				startTaskSession: async () => ({ ok: false, summary: null, error: "Unused" }),
			});
			const request = {
				operationId: "clear",
				expectedRevision: revision,
				tasks: [
					{ taskId: "one", taskCreatedAt: 100 },
					{ taskId: "two", taskCreatedAt: 100 },
					{ taskId: "changed", taskCreatedAt: 99 },
					{ taskId: "review", taskCreatedAt: 100 },
				],
			};
			const result = await lifecycle.clearTrash(scope, request);
			expect(result.projectId).toBe(projectId);
			expect(result.results.map(({ outcomeCode }) => outcomeCode)).toEqual([
				"completed",
				"worktree_failed",
				"stale_task",
				"invalid_transition",
			]);
			expect(result.state.board.columns.flatMap((column) => column.cards.map((card) => card.id)).sort()).toEqual([
				"changed",
				"review",
				"two",
			]);
			expect(purgeTaskWorkspace).toHaveBeenCalledTimes(2);
			const replay = await lifecycle.clearTrash(scope, request);
			expect(replay.results.map(({ ok }) => ok)).toEqual([true, false, false, false]);
			expect(purgeTaskWorkspace).toHaveBeenCalledTimes(2);
			// Simulate child receipt pruning after a larger bulk operation or long-lived runtime.
			await rm(getProjectLifecycleOperationsPath(projectId));
			const unconfirmed = await lifecycle.clearTrash(scope, {
				...request,
				tasks: [{ taskId: "one", taskCreatedAt: 100 }],
			});
			expect(unconfirmed.results[0]).toMatchObject({ ok: false, outcomeCode: "unconfirmed" });
			expect(purgeTaskWorkspace).toHaveBeenCalledTimes(2);
		} finally {
			temp.cleanup();
		}
	});
});
