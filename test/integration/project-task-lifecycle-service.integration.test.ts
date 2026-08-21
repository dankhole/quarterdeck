import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../src/core";
import { getTaskColumnId } from "../../src/core";
import { ProjectTaskLifecycleIdentityConflictError, ProjectTaskLifecycleService } from "../../src/server";
import { loadProjectContext, loadProjectState, ProjectBoardCommandService } from "../../src/state";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

const TASK_SPEC = {
	taskId: "task-a",
	title: null,
	prompt: "Create and start without a browser",
	baseRef: "main",
	agentId: "codex" as const,
	useWorktree: true,
	branch: "feature/task-a",
	createdAt: 100,
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) {
		throw new Error("Deferred promise resolver was not initialized.");
	}
	return { promise, resolve: resolvePromise };
}

describe.sequential("ProjectTaskLifecycleService integration", () => {
	it("persists, starts, publishes, and safely replays create-and-start without a browser", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const publishAuthoritativeState = vi.fn(async () => {});
				const boardCommands = new ProjectBoardCommandService({
					getAuthoritativeSessions: () => sessions,
					publishAuthoritativeState,
				});
				const startTaskSession = vi.fn(async () => {
					const stateBeforeStart = await loadProjectState(projectPath);
					expect(getTaskColumnId(stateBeforeStart.board, TASK_SPEC.taskId)).toBe("in_progress");
					const summary = createTestTaskSessionSummary({
						taskId: TASK_SPEC.taskId,
						state: "running",
						agentId: "codex",
						sessionLaunchPath: join(projectPath, ".quarterdeck", "task-a"),
						pid: 123,
						startedAt: 200,
						updatedAt: 200,
					});
					sessions[TASK_SPEC.taskId] = summary;
					return { ok: true, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });
				const scope = { projectId: context.projectId, projectPath };

				const result = await lifecycle.createAndStartTask(scope, {
					commandId: "create-and-start-task-a",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
					cols: 120,
					rows: 36,
				});

				expect(result.ok).toBe(true);
				expect(result.replayed).toBe(false);
				expect(result.state.revision).toBe(2);
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("in_progress");
				expect(result.state.sessions[TASK_SPEC.taskId]).toEqual(sessions[TASK_SPEC.taskId]);
				expect(startTaskSession).toHaveBeenCalledWith(
					scope,
					expect.objectContaining({
						taskId: TASK_SPEC.taskId,
						prompt: TASK_SPEC.prompt,
						agentId: "codex",
						baseRef: "main",
						useWorktree: true,
						cols: 120,
						rows: 36,
					}),
				);
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(2);

				const replayed = await new ProjectTaskLifecycleService({
					boardCommands: new ProjectBoardCommandService({
						getAuthoritativeSessions: () => sessions,
						publishAuthoritativeState,
					}),
					startTaskSession,
				}).createAndStartTask(scope, {
					commandId: "create-and-start-task-a",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
					cols: 120,
					rows: 36,
				});

				expect(replayed.ok).toBe(true);
				expect(replayed.replayed).toBe(true);
				expect(replayed.state.revision).toBe(2);
				expect(startTaskSession).toHaveBeenCalledOnce();
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(4);
			} finally {
				cleanup();
			}
		});
	});

	it("returns a failed start to backlog without deleting recoverable worktree or branch state", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-failure-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const startTaskSession = vi.fn(async () => ({
					ok: false,
					summary: null,
					error: "Agent process did not start.",
				}));
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });
				const scope = { projectId: context.projectId, projectPath };
				const input = {
					commandId: "failed-create-and-start",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
				};

				const result = await lifecycle.createAndStartTask(scope, input);

				expect(result).toMatchObject({
					ok: false,
					code: "session_start_failed",
					error: "Agent process did not start.",
					replayed: false,
					state: { revision: 3 },
				});
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(result.state.board.columns[0]?.cards[0]).toMatchObject({
					id: TASK_SPEC.taskId,
					branch: TASK_SPEC.branch,
					useWorktree: true,
				});

				const replayed = await new ProjectTaskLifecycleService({
					boardCommands: new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) }),
					startTaskSession,
				}).createAndStartTask(scope, input);
				expect(replayed).toMatchObject({
					ok: false,
					code: "session_start_interrupted",
					replayed: true,
					state: { revision: 3 },
				});
				expect(getTaskColumnId(replayed.state.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("coalesces concurrent retries and rejects in-flight command ID reuse with different content", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-concurrent-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				const startEntered = createDeferred();
				const startGate = createDeferred();
				const startTaskSession = vi.fn(async () => {
					startEntered.resolve();
					await startGate.promise;
					const summary = createTestTaskSessionSummary({
						taskId: TASK_SPEC.taskId,
						state: "running",
						agentId: "codex",
						pid: 456,
						startedAt: 250,
						updatedAt: 250,
					});
					sessions[TASK_SPEC.taskId] = summary;
					return { ok: true, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });
				const input = {
					commandId: "concurrent-create-and-start",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
				};

				const first = lifecycle.createAndStartTask(scope, input);
				await startEntered.promise;
				const duplicate = lifecycle.createAndStartTask(scope, input);
				await expect(
					lifecycle.createAndStartTask(scope, {
						...input,
						task: { ...TASK_SPEC, prompt: "Different content" },
					}),
				).rejects.toBeInstanceOf(ProjectTaskLifecycleIdentityConflictError);
				startGate.resolve();

				const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
				expect(firstResult).toEqual(duplicateResult);
				expect(firstResult.ok).toBe(true);
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("recovers a persisted move whose session effect was interrupted before startup", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-interrupted-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				await boardCommands.execute(scope, {
					commandId: "interrupted-create-and-start:create",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "backlog" },
				});
				await boardCommands.execute(scope, {
					commandId: "interrupted-create-and-start:move",
					expectedRevision: initial.revision + 1,
					command: {
						kind: "move_task",
						taskId: TASK_SPEC.taskId,
						sourceColumnId: "backlog",
						targetColumnId: "in_progress",
						targetIndex: 0,
						updatedAt: 150,
					},
				});
				const startTaskSession = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });

				const result = await lifecycle.createAndStartTask(scope, {
					commandId: "interrupted-create-and-start",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
				});

				expect(result).toMatchObject({
					ok: false,
					code: "session_start_interrupted",
					replayed: true,
					state: { revision: 3 },
				});
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(startTaskSession).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	it("does not attach lifecycle effects to a first-seen no-op create or a non-isolated task incorrectly", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-preconditions-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				await boardCommands.execute(scope, {
					commandId: "seed-task-a",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "backlog" },
				});
				const startTaskSession = vi.fn(async (_scope, request) => {
					const summary = createTestTaskSessionSummary({
						taskId: request.taskId,
						state: "running",
						agentId: request.agentId ?? null,
						pid: 321,
						startedAt: 300,
						updatedAt: 300,
					});
					sessions[request.taskId] = summary;
					return { ok: true, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });

				const collision = await lifecycle.createAndStartTask(scope, {
					commandId: "colliding-create-and-start",
					expectedRevision: initial.revision + 1,
					task: TASK_SPEC,
					startedAt: 200,
				});
				expect(collision).toMatchObject({ ok: false, code: "task_already_exists" });
				expect(startTaskSession).not.toHaveBeenCalled();

				const nonIsolatedTask = {
					...TASK_SPEC,
					taskId: "task-shared",
					branch: undefined,
					useWorktree: false,
					createdAt: 400,
				};
				const nonIsolated = await lifecycle.createAndStartTask(scope, {
					commandId: "create-and-start-shared",
					expectedRevision: collision.state.revision,
					task: nonIsolatedTask,
					startedAt: 450,
				});
				expect(nonIsolated.ok).toBe(true);
				expect(startTaskSession).toHaveBeenCalledOnce();
				expect(startTaskSession).toHaveBeenCalledWith(
					scope,
					expect.objectContaining({ taskId: "task-shared", useWorktree: false }),
				);
			} finally {
				cleanup();
			}
		});
	});
});
