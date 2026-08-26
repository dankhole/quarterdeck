import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskLifecycleCommand, RuntimeTaskSessionSummary } from "../../src/core";
import { findCardInBoard, getTaskColumnId } from "../../src/core";
import { ProjectTaskLifecycleService } from "../../src/server";
import {
	fingerprintTaskLifecycleCommand,
	loadProjectContext,
	loadProjectState,
	ProjectBoardCommandService,
	ProjectTaskLifecycleOperationStore,
} from "../../src/state";
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

type CreateAndStartCommand = Extract<RuntimeTaskLifecycleCommand, { kind: "create_and_start" }>;
type CreateAndStartInput = Omit<CreateAndStartCommand, "kind" | "operationId"> & { commandId: string };

async function executeCreateAndStart(
	lifecycle: ProjectTaskLifecycleService,
	scope: { projectId: string; projectPath: string },
	input: CreateAndStartInput,
) {
	const { commandId, ...command } = input;
	return await lifecycle.execute(scope, {
		kind: "create_and_start",
		operationId: commandId,
		...command,
	});
}

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
				const postCommitEffect = vi.fn();
				boardCommands.subscribeToPostCommitEffects(postCommitEffect);
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession,
				});
				const scope = { projectId: context.projectId, projectPath };

				const result = await executeCreateAndStart(lifecycle, scope, {
					commandId: "create-and-start-task-a",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
					cols: 120,
					rows: 36,
				});

				expect(result.ok).toBe(true);
				expect(result.operation.outcomeCode).toBe("completed");
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
				expect(postCommitEffect).toHaveBeenCalledOnce();
				expect(postCommitEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						scope,
						effects: [
							{
								type: "untitled_task_created",
								task: {
									taskId: TASK_SPEC.taskId,
									prompt: TASK_SPEC.prompt,
									createdAt: TASK_SPEC.createdAt,
								},
							},
						],
					}),
				);
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(2);

				const replayBoardCommands = new ProjectBoardCommandService({
					getAuthoritativeSessions: () => sessions,
					publishAuthoritativeState,
				});
				replayBoardCommands.subscribeToPostCommitEffects(postCommitEffect);
				const replayed = await executeCreateAndStart(
					new ProjectTaskLifecycleService({
						boardCommands: replayBoardCommands,
						startTaskSession,
					}),
					scope,
					{
						commandId: "create-and-start-task-a",
						expectedRevision: initial.revision,
						task: TASK_SPEC,
						startedAt: 150,
						cols: 120,
						rows: 36,
					},
				);

				expect(replayed.ok).toBe(true);
				expect(replayed.operation.outcomeCode).toBe("completed");
				expect(replayed.state.revision).toBe(2);
				expect(startTaskSession).toHaveBeenCalledOnce();
				expect(postCommitEffect).toHaveBeenCalledOnce();
				expect(publishAuthoritativeState).toHaveBeenCalledTimes(2);
			} finally {
				cleanup();
			}
		});
	});

	it("does not schedule a title for a different task identity after create is rejected", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-title-identity-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const scope = { projectId: context.projectId, projectPath };
				await boardCommands.execute(scope, {
					commandId: "create-existing-task",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task",
						columnId: "backlog",
						taskId: TASK_SPEC.taskId,
						prompt: "Existing private prompt",
						baseRef: "main",
						createdAt: TASK_SPEC.createdAt - 1,
					},
				});
				const startTaskSession = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession,
				});

				const result = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "reject-duplicate-task",
					expectedRevision: initial.revision,
					startedAt: 150,
					task: TASK_SPEC,
				});

				expect(result).toMatchObject({
					ok: false,
					operation: { outcomeCode: "revision_conflict" },
				});
				expect(startTaskSession).not.toHaveBeenCalled();
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

				const result = await executeCreateAndStart(lifecycle, scope, input);

				expect(result).toMatchObject({
					ok: false,
					operation: { outcomeCode: "session_start_failed" },
					error: "Agent process did not start.",
					state: { revision: 3 },
				});
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(result.state.board.columns[0]?.cards[0]).toMatchObject({
					id: TASK_SPEC.taskId,
					branch: TASK_SPEC.branch,
					useWorktree: true,
				});

				const replayed = await executeCreateAndStart(
					new ProjectTaskLifecycleService({
						boardCommands: new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) }),
						startTaskSession,
					}),
					scope,
					input,
				);
				expect(replayed).toMatchObject({
					ok: false,
					operation: { outcomeCode: "session_start_failed" },
					state: { revision: 3 },
				});
				expect(getTaskColumnId(replayed.state.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("rebases create-and-start across an unrelated runtime-owned title revision", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-title-rebase-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				const seeded = await boardCommands.execute(scope, {
					commandId: "seed-untitled-task",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task",
						columnId: "backlog",
						taskId: "existing-task",
						prompt: "Existing task",
						baseRef: "main",
						createdAt: 99,
					},
				});
				const generatedTitle = await boardCommands.setGeneratedTaskTitle(
					scope,
					"existing-task",
					99,
					"Generated title",
					125,
				);
				const startTaskSession = vi.fn(async (_scope, request) => {
					const summary = createTestTaskSessionSummary({
						taskId: request.taskId,
						launchOperationId: request.launchOperationId,
						state: "running",
						agentId: "codex",
						pid: 456,
						startedAt: 200,
						updatedAt: 200,
					});
					sessions[request.taskId] = summary;
					return { ok: true as const, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });

				const result = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "create-after-generated-title",
					expectedRevision: seeded.state.revision,
					startedAt: 150,
					task: TASK_SPEC,
				});

				expect(result).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "completed" },
					state: { revision: generatedTitle.state.revision + 2 },
				});
				expect(findCardInBoard(result.state.board, "existing-task")?.title).toBe("Generated title");
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("in_progress");
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("rebases the create-and-start move across consecutive runtime-owned projections", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-mid-create-rebase-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				let moveAttemptCount = 0;
				const executeBoardCommand = vi.fn(async (...args: Parameters<ProjectBoardCommandService["execute"]>) => {
					const [commandScope, input] = args;
					if (input.command.kind === "move_task" && input.command.taskId === TASK_SPEC.taskId) {
						moveAttemptCount += 1;
						if (moveAttemptCount === 2) {
							await boardCommands.reconcileRuntimeTaskBaseRef(commandScope, TASK_SPEC.taskId, "projected-base");
						}
					}
					const result = await boardCommands.execute(commandScope, input);
					if (input.command.kind === "create_task" && input.command.taskId === TASK_SPEC.taskId) {
						await boardCommands.setGeneratedTaskTitle(
							commandScope,
							TASK_SPEC.taskId,
							TASK_SPEC.createdAt,
							"Generated during start",
							125,
						);
					}
					return result;
				});
				const startTaskSession = vi.fn(async (_scope, request) => {
					const summary = createTestTaskSessionSummary({
						taskId: request.taskId,
						launchOperationId: request.launchOperationId,
						state: "running",
						agentId: "codex",
						pid: 456,
						startedAt: 200,
						updatedAt: 200,
					});
					sessions[request.taskId] = summary;
					return { ok: true as const, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands: {
						execute: executeBoardCommand,
					},
					startTaskSession,
				});

				const result = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "create-with-mid-operation-title",
					expectedRevision: initial.revision,
					startedAt: 150,
					task: TASK_SPEC,
				});

				expect(result).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "completed" },
					state: { revision: 4 },
				});
				expect(findCardInBoard(result.state.board, TASK_SPEC.taskId)?.title).toBe("Generated during start");
				expect(findCardInBoard(result.state.board, TASK_SPEC.taskId)?.baseRef).toBe("projected-base");
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("in_progress");
				expect(executeBoardCommand).toHaveBeenCalledTimes(4);
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("fails closed after exhausting bounded semantic rebase retries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-rebase-exhausted-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				let competingTaskIndex = 0;
				const executeBoardCommand = vi.fn(async (...args: Parameters<ProjectBoardCommandService["execute"]>) => {
					const [commandScope, input] = args;
					if (input.command.kind === "create_task" && input.command.taskId === TASK_SPEC.taskId) {
						const current = await loadProjectState(projectPath);
						const index = competingTaskIndex;
						competingTaskIndex += 1;
						await boardCommands.execute(commandScope, {
							commandId: `competing-create-${index}`,
							expectedRevision: current.revision,
							command: {
								kind: "create_task",
								columnId: "backlog",
								taskId: `competing-task-${index}`,
								prompt: "Concurrent edit",
								baseRef: "main",
								createdAt: 200 + index,
							},
						});
					}
					return await boardCommands.execute(commandScope, input);
				});
				const startTaskSession = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands: {
						execute: executeBoardCommand,
					},
					startTaskSession,
				});

				const result = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "exhaust-create-rebase",
					expectedRevision: initial.revision,
					startedAt: 150,
					task: TASK_SPEC,
				});

				expect(result).toMatchObject({
					ok: false,
					operation: { status: "failed", outcomeCode: "revision_conflict" },
					state: { revision: 5 },
				});
				expect(executeBoardCommand).toHaveBeenCalledTimes(5);
				expect(findCardInBoard(result.state.board, TASK_SPEC.taskId)).toBeNull();
				expect(startTaskSession).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	it("rebases create-and-start across a distinct concurrent task creation", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-conflict-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				const current = await boardCommands.execute(scope, {
					commandId: "competing-create",
					expectedRevision: initial.revision,
					command: {
						kind: "create_task",
						columnId: "backlog",
						taskId: "competing-task",
						prompt: "Concurrent edit",
						baseRef: "main",
						createdAt: 99,
					},
				});
				const startTaskSession = vi.fn(async (_scope, request) => {
					const summary = createTestTaskSessionSummary({
						taskId: request.taskId,
						launchOperationId: request.launchOperationId,
						state: "running",
						agentId: "codex",
						pid: 456,
						startedAt: 200,
						updatedAt: 200,
					});
					sessions[request.taskId] = summary;
					return { ok: true as const, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });

				const result = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "stale-create-and-start",
					expectedRevision: initial.revision,
					startedAt: 150,
					task: TASK_SPEC,
				});

				expect(result).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "completed", phase: "finished" },
					state: { revision: current.state.revision + 2 },
				});
				expect(findCardInBoard(result.state.board, "competing-task")).not.toBeNull();
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("in_progress");
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

				const first = executeCreateAndStart(lifecycle, scope, input);
				await startEntered.promise;
				const duplicate = executeCreateAndStart(lifecycle, scope, input);
				const collision = await executeCreateAndStart(lifecycle, scope, {
					...input,
					task: { ...TASK_SPEC, prompt: "Different content" },
				});
				expect(collision).toMatchObject({
					ok: false,
					operation: { outcomeCode: "identity_conflict" },
				});
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

	it("returns busy for a different operation on the same task without blocking another task", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-lifecycle-busy-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const firstStartEntered = createDeferred();
				const firstStartGate = createDeferred();
				const startTaskSession = vi.fn(async (_scope, request) => {
					if (request.taskId === TASK_SPEC.taskId) {
						firstStartEntered.resolve();
						await firstStartGate.promise;
					}
					return {
						ok: true as const,
						summary: createTestTaskSessionSummary({
							taskId: request.taskId,
							sessionInstanceId: `session-${request.taskId}`,
							launchOperationId: request.launchOperationId,
							state: "running",
							agentId: "codex",
							pid: request.taskId === TASK_SPEC.taskId ? 501 : 502,
							startedAt: 500,
							updatedAt: 500,
						}),
					};
				});
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands: new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) }),
					startTaskSession,
				});
				const firstCommand: RuntimeTaskLifecycleCommand = {
					kind: "create_and_start",
					operationId: "busy-first-task",
					expectedRevision: initial.revision,
					startedAt: 200,
					task: TASK_SPEC,
				};
				const first = lifecycle.execute(scope, firstCommand);
				await firstStartEntered.promise;
				const stateWhileFirstStarts = await loadProjectState(projectPath);

				const busy = await lifecycle.execute(scope, {
					kind: "stop",
					operationId: "busy-second-operation",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: stateWhileFirstStarts.revision,
				});
				const secondTask = {
					...TASK_SPEC,
					taskId: "task-b",
					branch: "feature/task-b",
					createdAt: 101,
				};
				const independent = await lifecycle.execute(scope, {
					kind: "create_and_start",
					operationId: "independent-second-task",
					expectedRevision: stateWhileFirstStarts.revision,
					startedAt: 201,
					task: secondTask,
				});

				expect(busy).toMatchObject({ ok: false, operation: { outcomeCode: "busy" } });
				expect(independent).toMatchObject({
					ok: true,
					operation: { taskId: "task-b", outcomeCode: "completed" },
				});
				firstStartGate.resolve();
				await expect(first).resolves.toMatchObject({ ok: true });
				expect(startTaskSession).toHaveBeenCalledTimes(2);
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

				const result = await executeCreateAndStart(lifecycle, scope, {
					commandId: "interrupted-create-and-start",
					expectedRevision: initial.revision,
					task: TASK_SPEC,
					startedAt: 150,
				});

				expect(result).toMatchObject({
					ok: false,
					operation: { outcomeCode: "superseded" },
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

				const collision = await executeCreateAndStart(lifecycle, scope, {
					commandId: "colliding-create-and-start",
					expectedRevision: initial.revision + 1,
					task: TASK_SPEC,
					startedAt: 200,
				});
				expect(collision).toMatchObject({
					ok: false,
					operation: { outcomeCode: "invalid_transition" },
				});
				expect(startTaskSession).not.toHaveBeenCalled();

				const nonIsolatedTask = {
					...TASK_SPEC,
					taskId: "task-shared",
					branch: undefined,
					useWorktree: false,
					createdAt: 400,
				};
				const nonIsolated = await executeCreateAndStart(lifecycle, scope, {
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

	it("recovers a start after its board receipt commits and compensates without launching twice", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-start-recovery-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-start-recovery",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "backlog" },
				});
				const operationStore = new ProjectTaskLifecycleOperationStore();
				const command: RuntimeTaskLifecycleCommand = {
					kind: "start",
					operationId: "recover-start-task-a",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
				};
				const begun = await operationStore.begin(scope, command);
				await operationStore.update(scope, command.operationId, (operation) => ({
					...operation,
					phase: "board_transition",
				}));
				await boardCommands.execute(scope, {
					commandId: `${command.operationId}:move`,
					expectedRevision: command.expectedRevision,
					command: {
						kind: "move_task",
						taskId: TASK_SPEC.taskId,
						sourceColumnId: "backlog",
						targetColumnId: "in_progress",
						targetIndex: 0,
						updatedAt: begun.operation.requestedAt,
					},
				});

				const startTaskSession = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession,
					operationStore,
				});
				await lifecycle.recover(scope);
				const recovered = await lifecycle.getOperation(scope, command.operationId);

				expect(recovered).toMatchObject({
					ok: false,
					operation: { status: "failed", outcomeCode: "superseded", phase: "finished" },
				});
				expect(getTaskColumnId(recovered?.state.board ?? initial.board, TASK_SPEC.taskId)).toBe("backlog");
				expect(startTaskSession).not.toHaveBeenCalled();
				expect(await operationStore.listActive(scope)).toEqual([]);
			} finally {
				cleanup();
			}
		});
	});

	it("replays a committed trash move and performs cleanup exactly once", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-trash-recovery-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-trash-recovery",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "review" },
				});
				const operationStore = new ProjectTaskLifecycleOperationStore();
				const command: RuntimeTaskLifecycleCommand = {
					kind: "trash",
					operationId: "recover-trash-task-a",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
					sourceColumnId: "review",
				};
				const begun = await operationStore.begin(scope, command);
				await operationStore.update(scope, command.operationId, (operation) => ({
					...operation,
					phase: "board_transition",
				}));
				await boardCommands.execute(scope, {
					commandId: `${command.operationId}:move`,
					expectedRevision: command.expectedRevision,
					command: {
						kind: "move_task",
						taskId: TASK_SPEC.taskId,
						sourceColumnId: "review",
						targetColumnId: "trash",
						targetIndex: 0,
						updatedAt: begun.operation.requestedAt,
					},
				});

				const stopTaskSession = vi.fn(async (_scope, taskId: string) => ({
					summary: null,
					requestedSessionInstanceId: null,
					didExit: true,
					outcome: "not_running" as const,
					taskId,
				}));
				const archiveTaskWorktree = vi.fn(async () => ({ ok: true as const, removed: false }));
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession: vi.fn(),
					stopTaskSession,
					archiveTaskWorktree,
					operationStore,
				});
				await lifecycle.recover(scope);
				await lifecycle.recover(scope);
				const recovered = await lifecycle.getOperation(scope, command.operationId);

				expect(recovered).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "completed" },
				});
				expect(getTaskColumnId(recovered?.state.board ?? initial.board, TASK_SPEC.taskId)).toBe("trash");
				expect(stopTaskSession).toHaveBeenCalledTimes(2);
				expect(archiveTaskWorktree).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("starts linked backlog tasks from the durable pre-trash transition plan", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-trash-linked-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				const parentTask = {
					...TASK_SPEC,
					taskId: "review-parent",
					createdAt: 201,
					useWorktree: false,
					branch: undefined,
				};
				const childTask = {
					...TASK_SPEC,
					taskId: "backlog-child",
					createdAt: 202,
					useWorktree: false,
					branch: undefined,
				};
				const parentCreated = await boardCommands.execute(scope, {
					commandId: "seed-linked-parent",
					expectedRevision: initial.revision,
					command: { ...parentTask, kind: "create_task", columnId: "review" },
				});
				const childCreated = await boardCommands.execute(scope, {
					commandId: "seed-linked-child",
					expectedRevision: parentCreated.state.revision,
					command: { ...childTask, kind: "create_task", columnId: "backlog" },
				});
				const linked = await boardCommands.execute(scope, {
					commandId: "seed-linked-dependency",
					expectedRevision: childCreated.state.revision,
					command: {
						kind: "add_dependency",
						firstTaskId: childTask.taskId,
						secondTaskId: parentTask.taskId,
						dependencyId: "linked-child-parent",
						createdAt: 203,
					},
				});
				const startTaskSession = vi.fn(async (_scope, request) => {
					const summary = createTestTaskSessionSummary({
						taskId: request.taskId,
						sessionInstanceId: `session-${request.taskId}`,
						launchOperationId: request.launchOperationId,
						state: "running",
						agentId: "codex",
						pid: 808,
						startedAt: 300,
						updatedAt: 300,
					});
					sessions[request.taskId] = summary;
					return { ok: true as const, summary };
				});
				const lifecycle = new ProjectTaskLifecycleService({ boardCommands, startTaskSession });
				const command: RuntimeTaskLifecycleCommand = {
					kind: "trash",
					operationId: "trash-linked-parent",
					taskId: parentTask.taskId,
					taskCreatedAt: parentTask.createdAt,
					expectedRevision: linked.state.revision,
					sourceColumnId: "review",
				};

				const result = await lifecycle.execute(scope, command);
				const replayed = await lifecycle.execute(scope, command);

				expect(result).toMatchObject({
					ok: true,
					operation: {
						status: "completed",
						childOperationIds: [expect.stringContaining("linked-0")],
					},
				});
				expect(getTaskColumnId(result.state.board, parentTask.taskId)).toBe("trash");
				expect(getTaskColumnId(result.state.board, childTask.taskId)).toBe("in_progress");
				expect(result.state.board.dependencies).toEqual([]);
				expect(startTaskSession).toHaveBeenCalledOnce();
				expect(startTaskSession).toHaveBeenCalledWith(
					scope,
					expect.objectContaining({ taskId: childTask.taskId, launchOperationId: expect.any(String) }),
				);
				expect(replayed).toEqual(result);
				expect(startTaskSession).toHaveBeenCalledOnce();
			} finally {
				cleanup();
			}
		});
	});

	it("reconciles a lost restore launch response and ignores viewport changes on retry", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-restore-recovery-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => sessions });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-restore-recovery",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "trash" },
				});
				const operationStore = new ProjectTaskLifecycleOperationStore();
				const command: Extract<RuntimeTaskLifecycleCommand, { kind: "restore" }> = {
					kind: "restore",
					operationId: "recover-restore-task-a",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
					cols: 100,
					rows: 30,
				};
				const begun = await operationStore.begin(scope, command);
				await operationStore.update(scope, command.operationId, (operation) => ({
					...operation,
					phase: "board_transition",
				}));
				await boardCommands.execute(scope, {
					commandId: `${command.operationId}:move`,
					expectedRevision: command.expectedRevision,
					command: {
						kind: "move_task",
						taskId: TASK_SPEC.taskId,
						sourceColumnId: "trash",
						targetColumnId: "review",
						targetIndex: 0,
						updatedAt: begun.operation.requestedAt,
					},
				});

				const startTaskSession = vi.fn(async (_scope, request) => {
					sessions[TASK_SPEC.taskId] = createTestTaskSessionSummary({
						taskId: TASK_SPEC.taskId,
						sessionInstanceId: "restore-session",
						launchOperationId: request.launchOperationId,
						state: "awaiting_review",
						agentId: "codex",
						pid: 987,
						startedAt: 500,
						updatedAt: 500,
					});
					throw new Error("Response connection closed after spawn.");
				});
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession,
					getTaskSessionSummary: (_scope, taskId) => sessions[taskId] ?? null,
					ensureTaskWorktree: async () => ({
						ok: true,
						path: join(projectPath, ".quarterdeck", "task-a"),
						baseRef: "main",
						baseCommit: "abc123",
						branch: TASK_SPEC.branch,
					}),
					operationStore,
				});
				await lifecycle.recover(scope);
				const recovered = await lifecycle.getOperation(scope, command.operationId);
				const geometryRetry = await lifecycle.execute(scope, { ...command, cols: 48, rows: 12 });

				expect(recovered).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "already_applied" },
					summary: { sessionInstanceId: "restore-session", launchOperationId: command.operationId },
				});
				expect(geometryRetry.ok).toBe(true);
				expect(getTaskColumnId(geometryRetry.state.board, TASK_SPEC.taskId)).toBe("review");
				expect(startTaskSession).toHaveBeenCalledOnce();
				expect(fingerprintTaskLifecycleCommand(command)).toBe(
					fingerprintTaskLifecycleCommand({ ...command, cols: 48, rows: 12 }),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("does not let a stale restore failure move a newer running projection back to Trash", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-stale-compensation-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-stale-compensation",
					expectedRevision: initial.revision,
					command: {
						...TASK_SPEC,
						kind: "create_task",
						columnId: "trash",
						useWorktree: false,
					},
				});
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession: async () => {
						const state = await loadProjectState(projectPath);
						await boardCommands.execute(scope, {
							commandId: "newer-running-projection",
							expectedRevision: state.revision,
							command: {
								kind: "move_task",
								taskId: TASK_SPEC.taskId,
								sourceColumnId: "review",
								targetColumnId: "in_progress",
								targetIndex: 0,
								updatedAt: 900,
							},
						});
						return { ok: false, summary: null, error: "Lost stale restore response." };
					},
				});

				const result = await lifecycle.execute(scope, {
					kind: "restore",
					operationId: "stale-restore-failure",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
				});

				expect(result).toMatchObject({
					ok: false,
					operation: { outcomeCode: "compensation_failed" },
				});
				expect(getTaskColumnId(result.state.board, TASK_SPEC.taskId)).toBe("in_progress");
			} finally {
				cleanup();
			}
		});
	});

	it("restarts In Progress work without claiming Running before provider confirmation", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-restart-confirmation-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-restart-confirmation",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "in_progress", useWorktree: false },
				});
				const stopTaskSession = vi.fn(async () => ({
					summary: createTestTaskSessionSummary({
						taskId: TASK_SPEC.taskId,
						state: "awaiting_review",
						reviewReason: "interrupted",
						pid: null,
					}),
					requestedSessionInstanceId: "old-session",
					didExit: true,
					outcome: "exited" as const,
				}));
				const restartedSummary = createTestTaskSessionSummary({
					taskId: TASK_SPEC.taskId,
					state: "awaiting_review",
					reviewReason: "attention",
					pid: 456,
					sessionInstanceId: "new-session",
				});
				const startTaskSession = vi.fn(async () => ({ ok: true, summary: restartedSummary }));
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession,
					stopTaskSession,
				});

				const result = await lifecycle.execute(scope, {
					kind: "restart",
					operationId: "restart-without-false-running",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
					sessionInstanceId: "old-session",
				});

				expect(result.ok).toBe(true);
				expect(result.summary).toEqual(restartedSummary);
				expect(startTaskSession).toHaveBeenCalledWith(
					scope,
					expect.objectContaining({
						taskId: TASK_SPEC.taskId,
						resumeConversation: true,
						awaitReview: true,
					}),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("blocks trash cleanup and permanent deletion when the process stop times out", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-stop-timeout-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const reviewTask = { ...TASK_SPEC, taskId: "task-review", createdAt: 101 };
				const trashTask = { ...TASK_SPEC, taskId: "task-trash", createdAt: 102 };
				const first = await boardCommands.execute(scope, {
					commandId: "seed-timeout-review",
					expectedRevision: initial.revision,
					command: { ...reviewTask, kind: "create_task", columnId: "review" },
				});
				const second = await boardCommands.execute(scope, {
					commandId: "seed-timeout-trash",
					expectedRevision: first.state.revision,
					command: { ...trashTask, kind: "create_task", columnId: "trash" },
				});
				const stopTaskSession = vi.fn(async () => ({
					summary: createTestTaskSessionSummary({
						state: "awaiting_review",
						reviewReason: "interrupted",
						pid: 456,
					}),
					requestedSessionInstanceId: "live-session",
					didExit: false,
					outcome: "timed_out" as const,
					error: "Task session did not exit before the timeout.",
				}));
				const archiveTaskWorktree = vi.fn();
				const purgeTaskWorkspace = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession: vi.fn(),
					stopTaskSession,
					archiveTaskWorktree,
					purgeTaskWorkspace,
				});

				const trashed = await lifecycle.execute(scope, {
					kind: "trash",
					operationId: "trash-timeout",
					taskId: reviewTask.taskId,
					taskCreatedAt: reviewTask.createdAt,
					expectedRevision: second.state.revision,
					sourceColumnId: "review",
				});
				const stateAfterTrash = await loadProjectState(projectPath);
				const deleted = await lifecycle.execute(scope, {
					kind: "delete",
					operationId: "delete-timeout",
					taskId: trashTask.taskId,
					taskCreatedAt: trashTask.createdAt,
					expectedRevision: stateAfterTrash.revision,
					sessionInstanceId: "live-session",
				});

				expect(trashed.operation.outcomeCode).toBe("stop_timed_out");
				expect(getTaskColumnId(trashed.state.board, reviewTask.taskId)).toBe("review");
				expect(deleted.operation.outcomeCode).toBe("stop_timed_out");
				expect(findCardInBoard(deleted.state.board, trashTask.taskId)).not.toBeNull();
				expect(archiveTaskWorktree).not.toHaveBeenCalled();
				expect(purgeTaskWorkspace).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	it("finishes a delete from its receipt after a crash following card removal", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-delete-recovery-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "seed-delete-recovery",
					expectedRevision: initial.revision,
					command: { ...TASK_SPEC, kind: "create_task", columnId: "trash" },
				});
				const operationStore = new ProjectTaskLifecycleOperationStore();
				const command: RuntimeTaskLifecycleCommand = {
					kind: "delete",
					operationId: "recover-delete-task-a",
					taskId: TASK_SPEC.taskId,
					taskCreatedAt: TASK_SPEC.createdAt,
					expectedRevision: created.state.revision,
				};
				await operationStore.begin(scope, command);
				await operationStore.update(scope, command.operationId, (operation) => ({
					...operation,
					phase: "deleting_card",
				}));
				await boardCommands.execute(scope, {
					commandId: `${command.operationId}:delete`,
					expectedRevision: command.expectedRevision,
					command: { kind: "delete_tasks", taskIds: [TASK_SPEC.taskId] },
				});
				const stopTaskSession = vi.fn();
				const purgeTaskWorkspace = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					startTaskSession: vi.fn(),
					stopTaskSession,
					purgeTaskWorkspace,
					operationStore,
				});

				await lifecycle.recover(scope);
				const recovered = await lifecycle.getOperation(scope, command.operationId);

				expect(recovered).toMatchObject({
					ok: true,
					operation: { status: "completed", outcomeCode: "already_applied" },
				});
				expect(findCardInBoard(recovered?.state.board ?? initial.board, TASK_SPEC.taskId)).toBeNull();
				expect(stopTaskSession).not.toHaveBeenCalled();
				expect(purgeTaskWorkspace).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});
});
