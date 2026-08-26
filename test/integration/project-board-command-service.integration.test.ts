import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	loadProjectContext,
	loadProjectState,
	ProjectBoardCommandIdentityConflictError,
	ProjectBoardCommandService,
	ProjectBoardLifecycleCommandRequiredError,
	ProjectStateConflictError,
	saveProjectState,
} from "../../src/state";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

describe.sequential("ProjectBoardCommandService integration", () => {
	it("persists a prepared command with no browser client or UI writer", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-command-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const getAuthoritativeSessions = vi.fn(() => ({
					"task-a": createTestTaskSessionSummary({ taskId: "task-a", state: "idle" }),
					orphan: createTestTaskSessionSummary({ taskId: "orphan", state: "idle" }),
				}));
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions });

				const result = await service.execute(
					{ projectId: context.projectId, projectPath },
					{
						commandId: "create-task-a",
						expectedRevision: initial.revision,
						command: {
							createdAt: 100,
							agentId: "codex",
							baseRef: "main",
							prompt: "Create without a browser",
							taskId: "task-a",
							columnId: "backlog",
							kind: "create_task",
						},
					},
				);

				expect(result.changed).toBe(true);
				expect(result.acceptedChange).toBe(true);
				expect(result.replayed).toBe(false);
				expect(result.state.revision).toBe(1);
				expect(result.state.board.columns[0]?.cards[0]).toMatchObject({
					id: "task-a",
					prompt: "Create without a browser",
					createdAt: 100,
					updatedAt: 100,
				});
				expect(Object.keys(result.state.sessions)).toEqual(["task-a"]);
				expect(getAuthoritativeSessions).toHaveBeenCalledOnce();
				const persistedMeta = readFileSync(join(context.statePath, "meta.json"), "utf8");
				expect(persistedMeta).toContain("create-task-a");
				expect(persistedMeta).not.toContain("Create without a browser");

				const loaded = await loadProjectState(projectPath);
				expect(loaded.revision).toBe(1);
				expect(loaded.board).toEqual(result.state.board);
				expect(Object.keys(loaded.sessions)).toEqual(["task-a"]);

				const restartedService = new ProjectBoardCommandService({ getAuthoritativeSessions });
				const replayed = await restartedService.execute(
					{ projectId: context.projectId, projectPath },
					{
						commandId: "create-task-a",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-a",
							prompt: "Create without a browser",
							baseRef: "main",
							agentId: "codex",
							createdAt: 100,
						},
					},
				);
				expect(replayed).toMatchObject({
					changed: false,
					acceptedChange: true,
					replayed: true,
					state: { revision: 1 },
				});

				const compatibilitySave = await saveProjectState(projectPath, {
					board: loaded.board,
					sessions: loaded.sessions,
					expectedRevision: loaded.revision,
				});
				const replayedAfterCompatibilitySave = await new ProjectBoardCommandService({
					getAuthoritativeSessions,
				}).execute(
					{ projectId: context.projectId, projectPath },
					{
						commandId: "create-task-a",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-a",
							prompt: "Create without a browser",
							baseRef: "main",
							agentId: "codex",
							createdAt: 100,
						},
					},
				);
				expect(replayedAfterCompatibilitySave).toMatchObject({
					changed: false,
					replayed: true,
					state: { revision: compatibilitySave.revision },
				});
			} finally {
				cleanup();
			}
		});
	});

	it("serializes competing commands and rejects the stale expected revision", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-command-race-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const initial = await loadProjectState(projectPath);
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const scope = { projectId: "project-a", projectPath };
				const results = await Promise.allSettled([
					service.execute(scope, {
						commandId: "create-task-a",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-a",
							prompt: "Task A",
							baseRef: "main",
							createdAt: 100,
						},
					}),
					service.execute(scope, {
						commandId: "create-task-b",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-b",
							prompt: "Task B",
							baseRef: "main",
							createdAt: 100,
						},
					}),
				]);

				const fulfilled = results.filter((result) => result.status === "fulfilled");
				const rejected = results.filter((result) => result.status === "rejected");
				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(1);
				expect(rejected[0]).toMatchObject({ reason: expect.any(ProjectStateConflictError) });

				const loaded = await loadProjectState(projectPath);
				expect(loaded.revision).toBe(1);
				expect(loaded.board.columns[0]?.cards).toHaveLength(1);
			} finally {
				cleanup();
			}
		});
	});

	it("durably records a no-op command once", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-command-noop-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const initial = await loadProjectState(projectPath);
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const result = await service.execute(
					{ projectId: "project-a", projectPath },
					{
						commandId: "move-missing-task",
						expectedRevision: initial.revision,
						command: {
							kind: "move_task",
							taskId: "missing",
							targetColumnId: "review",
							updatedAt: 100,
						},
					},
				);

				expect(result.changed).toBe(false);
				expect(result.acceptedChange).toBe(false);
				expect(result.replayed).toBe(false);
				expect(result.state.revision).toBe(initial.revision + 1);

				const replayed = await new ProjectBoardCommandService({
					getAuthoritativeSessions: () => ({}),
				}).execute(
					{ projectId: "project-a", projectPath },
					{
						commandId: "move-missing-task",
						expectedRevision: initial.revision,
						command: {
							kind: "move_task",
							taskId: "missing",
							targetColumnId: "review",
							updatedAt: 100,
						},
					},
				);
				expect(replayed.replayed).toBe(true);
				expect(replayed.acceptedChange).toBe(false);
				expect(replayed.state.revision).toBe(initial.revision + 1);
			} finally {
				cleanup();
			}
		});
	});

	it("replays an accepted command when authoritative publication fails after commit", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-command-publish-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const input = {
					commandId: "create-before-publish-failure",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task" as const,
						columnId: "backlog" as const,
						taskId: "task-a",
						prompt: "Persist before publish",
						baseRef: "main",
						createdAt: 100,
					},
				};
				const publishAuthoritativeState = vi
					.fn(async () => {})
					.mockRejectedValueOnce(new Error("publisher unavailable"))
					.mockResolvedValue(undefined);
				const service = new ProjectBoardCommandService({
					getAuthoritativeSessions: () => ({}),
					publishAuthoritativeState,
				});

				const first = await service.execute(scope, input);
				expect(first).toMatchObject({
					changed: true,
					acceptedChange: true,
					replayed: false,
					state: { revision: initial.revision + 1 },
				});
				const committed = await loadProjectState(projectPath);
				expect(committed.revision).toBe(initial.revision + 1);
				expect(
					committed.board.columns.flatMap((column) => column.cards).find((card) => card.id === "task-a")?.prompt,
				).toBe("Persist before publish");

				const replayed = await new ProjectBoardCommandService({
					getAuthoritativeSessions: () => ({}),
					publishAuthoritativeState,
				}).execute(scope, input);
				expect(replayed).toMatchObject({
					changed: false,
					acceptedChange: true,
					replayed: true,
					state: { revision: initial.revision + 1 },
				});
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(2);
			} finally {
				cleanup();
			}
		});
	});

	it("rejects reusing a command ID with different content", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-command-identity-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const initial = await loadProjectState(projectPath);
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const scope = { projectId: "project-a", projectPath };
				await service.execute(scope, {
					commandId: "create-task",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task",
						columnId: "backlog",
						taskId: "task-a",
						prompt: "Task A",
						baseRef: "main",
						createdAt: 100,
					},
				});

				await expect(
					new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) }).execute(scope, {
						commandId: "create-task",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-b",
							prompt: "Different task",
							baseRef: "main",
							createdAt: 101,
						},
					}),
				).rejects.toBeInstanceOf(ProjectBoardCommandIdentityConflictError);
			} finally {
				cleanup();
			}
		});
	});

	it("persists runtime session projection and later session-only updates without a browser", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-runtime-projection-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				let summary = createTestTaskSessionSummary({
					taskId: "task-a",
					state: "running",
					sessionLaunchPath: join(sandboxRoot, "task-a-worktree"),
					updatedAt: 200,
				});
				const publishAuthoritativeState = vi.fn(async () => {});
				const service = new ProjectBoardCommandService({
					getAuthoritativeSessions: () => ({ "task-a": summary }),
					publishAuthoritativeState,
				});
				const scope = { projectId: context.projectId, projectPath };
				const created = await service.executeBatch(scope, {
					commandId: "create-and-move",
					expectedRevision: initial.revision,
					commands: [
						{
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-a",
							prompt: "Run without a browser",
							baseRef: "main",
							createdAt: 100,
						},
						{
							kind: "move_task",
							taskId: "task-a",
							sourceColumnId: "backlog",
							targetColumnId: "in_progress",
							updatedAt: 200,
						},
					],
				});

				summary = { ...summary, state: "awaiting_review", reviewReason: "hook", updatedAt: 300 };
				const projected = await service.reconcileRuntimeSessions(scope);
				expect(projected.changed).toBe(true);
				expect(projected.state.revision).toBe(created.state.revision + 1);
				expect(projected.state.board.columns.find((column) => column.id === "review")?.cards[0]).toMatchObject({
					id: "task-a",
					workingDirectory: summary.sessionLaunchPath,
					useWorktree: true,
				});

				summary = { ...summary, warningMessage: "New warning", updatedAt: 400 };
				const sessionOnly = await service.reconcileRuntimeSessions(scope);
				expect(sessionOnly.changed).toBe(false);
				expect(sessionOnly.state.revision).toBe(projected.state.revision);
				const reloaded = await loadProjectState(projectPath);
				expect(reloaded.sessions["task-a"]?.warningMessage).toBe("New warning");
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(2);
			} finally {
				cleanup();
			}
		});
	});

	it("emits untitled-task effects only from accepted create commits and replays them for recovery", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-post-commit-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const listener = vi.fn();
				service.subscribeToPostCommitEffects(listener);
				const input = {
					commandId: "create-title-candidates",
					expectedRevision: initial.revision,
					commands: [
						{
							kind: "create_task" as const,
							columnId: "backlog" as const,
							taskId: "untitled",
							prompt: "Generate a title",
							baseRef: "main",
							createdAt: 100,
						},
						{
							kind: "create_task" as const,
							columnId: "backlog" as const,
							taskId: "already-titled",
							title: "Existing title",
							prompt: "Keep this title",
							baseRef: "main",
							createdAt: 101,
						},
					],
				};

				const created = await service.executeBatch(scope, input);
				expect(listener).toHaveBeenCalledWith({
					scope,
					commandId: input.commandId,
					revision: created.state.revision,
					replayed: false,
					effects: [
						{
							type: "untitled_task_created",
							task: { taskId: "untitled", prompt: "Generate a title", createdAt: 100 },
						},
					],
				});

				await service.executeBatch(scope, input);
				expect(listener).toHaveBeenLastCalledWith(
					expect.objectContaining({
						replayed: true,
						effects: [expect.objectContaining({ type: "untitled_task_created" })],
					}),
				);
				expect(listener).toHaveBeenCalledTimes(2);
			} finally {
				cleanup();
			}
		});
	});

	it("persists generated titles under the runtime lock without overwriting a manual title or replacement task", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-runtime-title-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const publishAuthoritativeState = vi.fn(async () => {});
				const service = new ProjectBoardCommandService({
					getAuthoritativeSessions: () => ({}),
					publishAuthoritativeState,
				});
				const scope = { projectId: context.projectId, projectPath };
				const created = await service.execute(scope, {
					commandId: "create-untitled-task",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task",
						columnId: "backlog",
						taskId: "task-a",
						prompt: "Title me",
						baseRef: "main",
						createdAt: 100,
					},
				});
				const replacementMismatch = await service.setGeneratedTaskTitle(
					scope,
					"task-a",
					99,
					"Wrong task title",
					150,
				);
				expect(replacementMismatch.changed).toBe(false);
				expect(replacementMismatch.state.revision).toBe(created.state.revision);

				const generated = await service.setGeneratedTaskTitle(scope, "task-a", 100, "Generated", 200);
				expect(generated).toMatchObject({ changed: true, acceptedChange: true });
				expect(
					generated.state.board.columns.flatMap((column) => column.cards).find((card) => card.id === "task-a")
						?.title,
				).toBe("Generated");

				const manual = await service.execute(scope, {
					commandId: "manual-title",
					expectedRevision: generated.state.revision,
					command: {
						kind: "patch_task",
						taskId: "task-a",
						title: "Manual",
						updatedAt: 300,
					},
				});
				const staleGenerator = await service.setGeneratedTaskTitle(scope, "task-a", 100, "Late generated", 400);

				expect(staleGenerator.changed).toBe(false);
				expect(staleGenerator.state.revision).toBe(manual.state.revision);
				expect(
					staleGenerator.state.board.columns.flatMap((column) => column.cards).find((card) => card.id === "task-a")
						?.title,
				).toBe("Manual");
				expect(manual.state.revision).toBe(created.state.revision + 2);
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(3);
			} finally {
				cleanup();
			}
		});
	});

	it("rejects lifecycle-managed transitions at the generic client boundary", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-board-client-boundary-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await service.executeClientBatch(scope, {
					commandId: "client-create",
					expectedRevision: initial.revision,
					commands: [
						{
							kind: "create_task",
							columnId: "backlog",
							taskId: "task-a",
							prompt: "Safe generic edit",
							baseRef: "main",
							createdAt: 100,
						},
					],
				});

				await expect(
					service.executeClientBatch(scope, {
						commandId: "client-managed-create-and-place",
						expectedRevision: created.state.revision,
						commands: [
							{
								kind: "create_task",
								columnId: "in_progress",
								taskId: "task-b",
								prompt: "Bypass lifecycle",
								baseRef: "main",
								createdAt: 200,
							},
						],
					}),
				).rejects.toBeInstanceOf(ProjectBoardLifecycleCommandRequiredError);
				await expect(
					service.executeClientBatch(scope, {
						commandId: "client-managed-start",
						expectedRevision: created.state.revision,
						commands: [
							{
								kind: "move_task",
								taskId: "task-a",
								sourceColumnId: "backlog",
								targetColumnId: "in_progress",
								updatedAt: 200,
							},
						],
					}),
				).rejects.toBeInstanceOf(ProjectBoardLifecycleCommandRequiredError);
				await expect(
					service.executeClientBatch(scope, {
						commandId: "client-managed-delete",
						expectedRevision: created.state.revision,
						commands: [{ kind: "delete_tasks", taskIds: ["task-a"] }],
					}),
				).rejects.toBeInstanceOf(ProjectBoardLifecycleCommandRequiredError);

				const loaded = await loadProjectState(projectPath);
				expect(loaded.revision).toBe(created.state.revision);
				expect(loaded.board.columns[0]?.cards[0]?.id).toBe("task-a");
			} finally {
				cleanup();
			}
		});
	});
});
