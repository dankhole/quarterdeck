import { createHash } from "node:crypto";

import type {
	RuntimeBoardCard,
	RuntimeProjectStateResponse,
	RuntimeTaskLifecycleCommand,
	RuntimeTaskLifecycleOperation,
	RuntimeTaskLifecycleOutcomeCode,
	RuntimeTaskLifecycleResult,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core";
import {
	createTaggedLogger,
	findCardInBoard,
	getReadyLinkedTaskIdsForTrashTransition,
	getRuntimeDetailTerminalTaskId,
	getTaskColumnId,
	runtimeTaskLifecycleCommandSchema,
} from "../core";
import {
	fingerprintTaskLifecycleCommand,
	loadProjectState,
	type PersistedTaskLifecycleOperation,
	ProjectBoardCommandIdentityConflictError,
	type ProjectBoardCommandScope,
	type ProjectBoardCommandService,
	ProjectStateConflictError,
	ProjectTaskLifecycleBusyError,
	ProjectTaskLifecycleIdentityConflictError,
	ProjectTaskLifecycleOperationStore,
} from "../state";
import type { StopTaskSessionResult } from "../terminal/session-manager-types";
import { archiveTaskWorktreeForTrash, ensureTaskWorktreeIfDoesntExist, purgeTaskWorkspaceForDelete } from "../workdir";

type BoardCommandService = Pick<ProjectBoardCommandService, "execute">;

export interface ProjectTaskLifecycleServiceDependencies {
	boardCommands: BoardCommandService;
	startTaskSession: (
		scope: ProjectBoardCommandScope,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	stopTaskSession?: (
		scope: ProjectBoardCommandScope,
		taskId: string,
		sessionInstanceId?: string,
	) => Promise<StopTaskSessionResult>;
	restartStructuredTaskSession?: (
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string,
	) => Promise<RuntimeTaskSessionStartResponse | null>;
	onTaskDeleted?: (scope: ProjectBoardCommandScope, taskId: string) => Promise<void>;
	getTaskSessionSummary?: (
		scope: ProjectBoardCommandScope,
		taskId: string,
	) => Promise<RuntimeTaskSessionSummary | null> | RuntimeTaskSessionSummary | null;
	ensureTaskWorktree?: (options: {
		cwd: string;
		taskId: string;
		baseRef: string;
		branch?: string | null;
	}) => Promise<RuntimeWorktreeEnsureResponse>;
	archiveTaskWorktree?: (options: {
		repoPath: string;
		taskId: string;
		operationId?: string;
	}) => Promise<RuntimeWorktreeDeleteResponse>;
	purgeTaskWorkspace?: (options: {
		repoPath: string;
		taskId: string;
		operationId?: string;
	}) => Promise<RuntimeWorktreeDeleteResponse>;
	loadState?: (scope: ProjectBoardCommandScope) => Promise<RuntimeProjectStateResponse>;
	operationStore?: ProjectTaskLifecycleOperationStore;
}

interface InFlightOperation {
	fingerprint: string;
	promise: Promise<RuntimeTaskLifecycleResult>;
}

const log = createTaggedLogger("task-lifecycle");
const MAX_SEMANTIC_REBASE_RETRIES = 4;

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withSessionSummary(
	state: RuntimeProjectStateResponse,
	summary: RuntimeTaskSessionSummary,
): RuntimeProjectStateResponse {
	return {
		...state,
		sessions: { ...state.sessions, [summary.taskId]: summary },
	};
}

function getTaskIdentity(command: RuntimeTaskLifecycleCommand): { taskId: string; taskCreatedAt: number } {
	return command.kind === "create_and_start"
		? { taskId: command.task.taskId, taskCreatedAt: command.task.createdAt }
		: { taskId: command.taskId, taskCreatedAt: command.taskCreatedAt };
}

function getStepCommandId(operationId: string, step: string): string {
	const candidate = `${operationId}:${step}`;
	if (candidate.length <= 128) {
		return candidate;
	}
	const digest = createHash("sha256").update(operationId).digest("hex").slice(0, 32);
	return `lifecycle:${digest}:${step}`;
}

function isTaskIdentityCurrent(
	card: RuntimeBoardCard | null,
	taskId: string,
	taskCreatedAt: number,
): card is RuntimeBoardCard {
	return card?.id === taskId && card.createdAt === taskCreatedAt;
}

function isSuccessfulLaunch(
	summary: RuntimeTaskSessionSummary | null | undefined,
	operationId: string,
): summary is RuntimeTaskSessionSummary {
	return summary?.launchOperationId === operationId && summary.startedAt != null;
}

function toPublicOperation(operation: PersistedTaskLifecycleOperation): RuntimeTaskLifecycleOperation {
	const {
		fingerprint: _fingerprint,
		command: _command,
		attempt: _attempt,
		plannedLinkedTaskIds: _plannedLinkedTaskIds,
		warning: _warning,
		error: _error,
		...publicOperation
	} = operation;
	return publicOperation;
}

function outcomeIsSuccess(outcome: RuntimeTaskLifecycleOutcomeCode | null): boolean {
	return outcome === "completed" || outcome === "completed_with_warning" || outcome === "already_applied";
}

function createSyntheticOperation(
	scope: ProjectBoardCommandScope,
	command: RuntimeTaskLifecycleCommand,
	outcomeCode: "busy" | "identity_conflict",
): RuntimeTaskLifecycleOperation {
	const identity = getTaskIdentity(command);
	const now = Date.now();
	return {
		operationId: command.operationId,
		projectId: scope.projectId,
		taskId: identity.taskId,
		taskCreatedAt: identity.taskCreatedAt,
		kind: command.kind,
		status: "failed",
		phase: "finished",
		sourceColumnId: command.kind === "trash" ? command.sourceColumnId : null,
		targetColumnId: null,
		acceptedBoardRevision: null,
		launchOperationId: null,
		childOperationIds: [],
		outcomeCode,
		requestedAt: now,
		updatedAt: now,
		completedAt: now,
	};
}

/** Server-owned coordinator for durable task intent and process/worktree effects. */
export class ProjectTaskLifecycleService {
	private readonly operationStore: ProjectTaskLifecycleOperationStore;
	private readonly inFlightByKey = new Map<string, InFlightOperation>();

	constructor(private readonly dependencies: ProjectTaskLifecycleServiceDependencies) {
		this.operationStore = dependencies.operationStore ?? new ProjectTaskLifecycleOperationStore();
	}

	async execute(
		scope: ProjectBoardCommandScope,
		commandInput: RuntimeTaskLifecycleCommand,
	): Promise<RuntimeTaskLifecycleResult> {
		const command = runtimeTaskLifecycleCommandSchema.parse(commandInput);
		const key = JSON.stringify([scope.projectId, command.operationId]);
		const fingerprint = fingerprintTaskLifecycleCommand(command);
		const inFlight = this.inFlightByKey.get(key);
		if (inFlight) {
			if (inFlight.fingerprint !== fingerprint) {
				return await this.syntheticFailure(scope, command, "identity_conflict", "Operation ID was reused.");
			}
			return await inFlight.promise;
		}

		const promise = this.executeOnce(scope, command);
		this.inFlightByKey.set(key, { fingerprint, promise });
		try {
			return await promise;
		} finally {
			if (this.inFlightByKey.get(key)?.promise === promise) {
				this.inFlightByKey.delete(key);
			}
		}
	}

	async getOperation(
		scope: ProjectBoardCommandScope,
		operationId: string,
	): Promise<RuntimeTaskLifecycleResult | null> {
		const operation = await this.operationStore.get(scope, operationId);
		return operation ? await this.resultFromOperation(scope, operation) : null;
	}

	async recover(scope: ProjectBoardCommandScope): Promise<void> {
		const active = await this.operationStore.listActive(scope);
		if (active.length === 0) {
			return;
		}
		log.info("recovering pending task lifecycle operations", {
			projectId: scope.projectId,
			operationCount: active.length,
		});
		for (const operation of active) {
			try {
				await this.operationStore.update(scope, operation.operationId, (current) => ({
					...current,
					attempt: current.attempt + 1,
				}));
				await this.execute(scope, operation.command);
			} catch (error) {
				log.warn("task lifecycle recovery failed", {
					projectId: scope.projectId,
					taskId: operation.taskId,
					taskCreatedAt: operation.taskCreatedAt,
					operationId: operation.operationId,
					operationKind: operation.kind,
					phase: operation.phase,
					attempt: operation.attempt + 1,
					outcome: "recovery_failed",
					error: toErrorMessage(error),
				});
			}
		}
	}

	private async executeOnce(
		scope: ProjectBoardCommandScope,
		command: RuntimeTaskLifecycleCommand,
	): Promise<RuntimeTaskLifecycleResult> {
		let begun: { operation: PersistedTaskLifecycleOperation; replayed: boolean };
		try {
			begun = await this.operationStore.begin(scope, command);
		} catch (error) {
			if (error instanceof ProjectTaskLifecycleBusyError) {
				return await this.syntheticFailure(scope, command, "busy", error.message);
			}
			if (error instanceof ProjectTaskLifecycleIdentityConflictError) {
				return await this.syntheticFailure(scope, command, "identity_conflict", error.message);
			}
			throw error;
		}
		if (begun.operation.status !== "pending") {
			return await this.resultFromOperation(scope, begun.operation);
		}

		log.info("task lifecycle operation accepted", {
			projectId: scope.projectId,
			taskId: begun.operation.taskId,
			taskCreatedAt: begun.operation.taskCreatedAt,
			operationId: begun.operation.operationId,
			operationKind: begun.operation.kind,
			phase: begun.operation.phase,
			attempt: begun.operation.attempt,
			replayed: begun.replayed,
		});

		try {
			switch (command.kind) {
				case "create_and_start":
					return await this.executeCreateAndStart(scope, command, begun.operation);
				case "start":
					return await this.executeStart(scope, command, begun.operation);
				case "trash":
					return await this.executeTrash(scope, command, begun.operation);
				case "restore":
					return await this.executeRestore(scope, command, begun.operation);
				case "stop":
					return await this.executeStop(scope, command, begun.operation);
				case "restart":
					return await this.executeRestart(scope, command, begun.operation);
				case "delete":
					return await this.executeDelete(scope, command, begun.operation);
			}
		} catch (error) {
			if (error instanceof ProjectStateConflictError || error instanceof ProjectBoardCommandIdentityConflictError) {
				const outcomeCode = error instanceof ProjectStateConflictError ? "revision_conflict" : "identity_conflict";
				log.warn("task lifecycle operation rejected by durable board state", {
					projectId: scope.projectId,
					taskId: begun.operation.taskId,
					taskCreatedAt: begun.operation.taskCreatedAt,
					operationId: begun.operation.operationId,
					operationKind: begun.operation.kind,
					phase: begun.operation.phase,
					attempt: begun.operation.attempt,
					outcome: outcomeCode,
					error: toErrorMessage(error),
				});
				return await this.finish(scope, begun.operation, {
					status: "failed",
					outcomeCode,
					error: toErrorMessage(error),
					state: await this.loadState(scope),
				});
			}
			log.error("task lifecycle operation failed unexpectedly", {
				projectId: scope.projectId,
				taskId: begun.operation.taskId,
				taskCreatedAt: begun.operation.taskCreatedAt,
				operationId: begun.operation.operationId,
				operationKind: begun.operation.kind,
				phase: begun.operation.phase,
				attempt: begun.operation.attempt,
				outcome: "unexpected_failure",
				error: toErrorMessage(error),
			});
			return await this.finish(scope, begun.operation, {
				status: "failed",
				outcomeCode: "internal_error",
				error: toErrorMessage(error),
			});
		}
	}

	private async executeCreateAndStart(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "create_and_start" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		operation = await this.setPhase(scope, operation, "board_transition");
		const createResult = await this.executeBoardWithSemanticRebase(scope, {
			commandId: getStepCommandId(command.operationId, "create"),
			expectedRevision: command.expectedRevision,
			command: { ...command.task, kind: "create_task", columnId: "backlog" },
			taskCreatedAt: command.task.createdAt,
		});
		if (!createResult.acceptedChange) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: `Task "${command.task.taskId}" already exists.`,
				state: createResult.state,
			});
		}
		const moveResult = await this.executeBoardWithSemanticRebase(scope, {
			commandId: getStepCommandId(command.operationId, "move"),
			expectedRevision: createResult.state.revision,
			command: {
				kind: "move_task",
				taskId: command.task.taskId,
				sourceColumnId: "backlog",
				targetColumnId: "in_progress",
				targetIndex: 0,
				updatedAt: command.startedAt,
			},
			taskCreatedAt: command.task.createdAt,
		});
		if (!moveResult.acceptedChange) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: "Task is no longer startable from backlog.",
				state: moveResult.state,
			});
		}
		operation = await this.recordBoardAccepted(scope, operation, moveResult.state.revision);

		const existing = await this.getMatchingLaunchSummary(scope, command.task.taskId, command.operationId);
		if (isSuccessfulLaunch(existing, command.operationId)) {
			return await this.completeWithSummary(scope, operation, moveResult.state, existing, "already_applied");
		}
		if (moveResult.replayed) {
			const compensated = await this.compensateMove(
				scope,
				operation,
				command.task.taskId,
				command.task.createdAt,
				"in_progress",
				"backlog",
				command.startedAt,
			);
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: compensated.ok ? "superseded" : "compensation_failed",
				error: compensated.ok
					? "Task startup was interrupted before launch; the task was returned to backlog."
					: "Task startup was interrupted and could not be safely compensated.",
				state: compensated.state,
			});
		}

		const card = findCardInBoard(moveResult.state.board, command.task.taskId);
		if (!isTaskIdentityCurrent(card, command.task.taskId, command.task.createdAt)) {
			return await this.finish(scope, operation, {
				status: "superseded",
				outcomeCode: "stale_task",
				error: "Task identity changed before startup.",
				state: moveResult.state,
			});
		}
		return await this.launchOrCompensate(scope, operation, card, moveResult.state, {
			resumeConversation: false,
			awaitReview: false,
			cols: command.cols,
			rows: command.rows,
			compensateTo: "backlog",
		});
	}

	private async executeStart(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "start" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		const precondition = await this.validateTaskIdentity(scope, command.taskId, command.taskCreatedAt);
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		operation = await this.setPhase(scope, operation, "board_transition");
		const moveResult = await this.executeBoardWithSemanticRebase(scope, {
			commandId: getStepCommandId(command.operationId, "move"),
			expectedRevision: command.expectedRevision,
			command: {
				kind: "move_task",
				taskId: command.taskId,
				sourceColumnId: "backlog",
				targetColumnId: "in_progress",
				targetIndex: 0,
				updatedAt: operation.requestedAt,
			},
			taskCreatedAt: command.taskCreatedAt,
		});
		if (!moveResult.acceptedChange) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: "Task is no longer in backlog.",
				state: moveResult.state,
			});
		}
		operation = await this.recordBoardAccepted(scope, operation, moveResult.state.revision);
		const existing = await this.getMatchingLaunchSummary(scope, command.taskId, command.operationId);
		if (isSuccessfulLaunch(existing, command.operationId)) {
			return await this.completeWithSummary(scope, operation, moveResult.state, existing, "already_applied");
		}
		if (moveResult.replayed) {
			const compensated = await this.compensateMove(
				scope,
				operation,
				command.taskId,
				command.taskCreatedAt,
				"in_progress",
				"backlog",
				operation.requestedAt,
			);
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: compensated.ok ? "superseded" : "compensation_failed",
				error: compensated.ok
					? "Task startup was interrupted before launch; the task was returned to backlog."
					: "Task startup was interrupted and could not be safely compensated.",
				state: compensated.state,
			});
		}
		const card = findCardInBoard(moveResult.state.board, command.taskId);
		if (!card) {
			return await this.finish(scope, operation, {
				status: "superseded",
				outcomeCode: "stale_task",
				error: "Task no longer exists.",
				state: moveResult.state,
			});
		}
		return await this.launchOrCompensate(scope, operation, card, moveResult.state, {
			resumeConversation: false,
			awaitReview: false,
			cols: command.cols,
			rows: command.rows,
			compensateTo: "backlog",
		});
	}

	private async executeTrash(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "trash" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		const precondition = await this.validateTaskIdentity(scope, command.taskId, command.taskCreatedAt);
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		const readyLinkedTaskIds =
			operation.plannedLinkedTaskIds.length > 0 || operation.childOperationIds.length > 0
				? operation.plannedLinkedTaskIds
				: getReadyLinkedTaskIdsForTrashTransition(precondition.state.board, command.taskId, command.sourceColumnId);
		const childOperationIds = readyLinkedTaskIds.map((_taskId, index) =>
			getStepCommandId(command.operationId, `linked-${index}`),
		);
		operation = await this.operationStore.update(scope, operation.operationId, (current) => ({
			...current,
			plannedLinkedTaskIds: readyLinkedTaskIds,
			childOperationIds,
		}));
		operation = await this.setPhase(scope, operation, "board_transition");
		// The linked-child start plan is persisted before the parent move. Execute
		// against that exact revision so an unrelated concurrent board edit cannot
		// change the dependency graph after the durable plan was recorded.
		const moveResult = await this.executeBoard(scope, {
			commandId: getStepCommandId(command.operationId, "move"),
			expectedRevision: command.expectedRevision,
			command: {
				kind: "move_task",
				taskId: command.taskId,
				sourceColumnId: command.sourceColumnId,
				targetColumnId: "trash",
				targetIndex: 0,
				updatedAt: operation.requestedAt,
			},
		});
		if (!moveResult.acceptedChange) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: "Task is no longer in the expected source column.",
				state: moveResult.state,
			});
		}
		operation = await this.recordBoardAccepted(scope, operation, moveResult.state.revision);
		operation = await this.setPhase(scope, operation, "stopping_session");
		const stopped = await this.stopTaskAndDetailShell(scope, command.taskId, command.operationId);
		if (!this.didStop(stopped)) {
			const compensated = await this.compensateMove(
				scope,
				operation,
				command.taskId,
				command.taskCreatedAt,
				"trash",
				command.sourceColumnId,
				operation.requestedAt,
			);
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed",
				error: stopped.error,
				state: compensated.state,
			});
		}

		const card = findCardInBoard(moveResult.state.board, command.taskId);
		let warning: string | null = null;
		if (card?.useWorktree !== false) {
			operation = await this.setPhase(scope, operation, "archiving_worktree");
			const archived = await (this.dependencies.archiveTaskWorktree ?? archiveTaskWorktreeForTrash)({
				repoPath: scope.projectPath,
				taskId: command.taskId,
				operationId: command.operationId,
			});
			if (!archived.ok) {
				warning = archived.error ?? "Task was trashed, but its worktree could not be archived.";
				log.warn(
					"task lifecycle worktree archive failed",
					this.logFields(operation, { outcome: "worktree_failed", error: warning }),
				);
			}
		}

		for (const [index, readyTaskId] of readyLinkedTaskIds.entries()) {
			const state = await this.loadState(scope);
			const readyCard = findCardInBoard(state.board, readyTaskId);
			if (!readyCard || getTaskColumnId(state.board, readyTaskId) !== "backlog") {
				continue;
			}
			const childOperationId = childOperationIds[index];
			if (!childOperationId) {
				continue;
			}
			const child = await this.execute(scope, {
				kind: "start",
				operationId: childOperationId,
				taskId: readyCard.id,
				taskCreatedAt: readyCard.createdAt,
				expectedRevision: state.revision,
			});
			if (!child.ok) {
				warning ??= "Task was trashed, but a newly unblocked linked task could not be started.";
			}
		}
		return await this.finish(scope, operation, {
			status: warning ? "completed_with_warning" : "completed",
			outcomeCode: warning ? "completed_with_warning" : "completed",
			warning: warning ?? undefined,
		});
	}

	private async executeRestore(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "restore" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		const precondition = await this.validateTaskIdentity(scope, command.taskId, command.taskCreatedAt);
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		operation = await this.setPhase(scope, operation, "board_transition");
		const moveResult = await this.executeBoardWithSemanticRebase(scope, {
			commandId: getStepCommandId(command.operationId, "move"),
			expectedRevision: command.expectedRevision,
			command: {
				kind: "move_task",
				taskId: command.taskId,
				sourceColumnId: "trash",
				targetColumnId: "review",
				targetIndex: 0,
				updatedAt: operation.requestedAt,
			},
			taskCreatedAt: command.taskCreatedAt,
		});
		if (!moveResult.acceptedChange) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: "Task is no longer in Trash.",
				state: moveResult.state,
			});
		}
		operation = await this.recordBoardAccepted(scope, operation, moveResult.state.revision);
		const existing = await this.getMatchingLaunchSummary(scope, command.taskId, command.operationId);
		if (isSuccessfulLaunch(existing, command.operationId)) {
			return await this.completeWithSummary(scope, operation, moveResult.state, existing, "already_applied");
		}

		operation = await this.setPhase(scope, operation, "stopping_session");
		const stopped = await this.stopOne(scope, command.taskId, undefined);
		if (!this.didStop(stopped)) {
			const compensated = await this.compensateMove(
				scope,
				operation,
				command.taskId,
				command.taskCreatedAt,
				"review",
				"trash",
				operation.requestedAt,
			);
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed",
				error: stopped.error,
				state: compensated.state,
			});
		}

		const card = findCardInBoard(moveResult.state.board, command.taskId);
		if (!card) {
			return await this.finish(scope, operation, {
				status: "superseded",
				outcomeCode: "stale_task",
				error: "Task no longer exists.",
				state: moveResult.state,
			});
		}
		let warning: string | undefined;
		if (card.useWorktree !== false) {
			operation = await this.setPhase(scope, operation, "ensuring_worktree");
			const ensured = await (this.dependencies.ensureTaskWorktree ?? ensureTaskWorktreeIfDoesntExist)({
				cwd: scope.projectPath,
				taskId: card.id,
				baseRef: card.baseRef,
				branch: card.branch,
			});
			if (!ensured.ok) {
				const compensated = await this.compensateMove(
					scope,
					operation,
					command.taskId,
					command.taskCreatedAt,
					"review",
					"trash",
					operation.requestedAt,
				);
				return await this.finish(scope, operation, {
					status: "failed",
					outcomeCode: compensated.ok ? "worktree_failed" : "compensation_failed",
					error: ensured.error ?? "Could not restore the task worktree.",
					state: compensated.state,
				});
			}
			warning = ensured.warning;
		}

		return await this.launchOrCompensate(scope, operation, card, moveResult.state, {
			resumeConversation: true,
			awaitReview: true,
			cols: command.cols,
			rows: command.rows,
			compensateTo: "trash",
			warning,
		});
	}

	private async executeStop(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "stop" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		const precondition = await this.validateTask(scope, command.taskId, command.taskCreatedAt, [
			"in_progress",
			"review",
		]);
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		operation = await this.setPhase(scope, operation, "stopping_session");
		const stopped = await this.stopOne(scope, command.taskId, command.sessionInstanceId ?? undefined);
		if (!this.didStop(stopped)) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed",
				error: stopped.error,
			});
		}
		return await this.finish(scope, operation, { status: "completed", outcomeCode: "completed" });
	}

	private async executeRestart(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "restart" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		const precondition = await this.validateTask(scope, command.taskId, command.taskCreatedAt, [
			"in_progress",
			"review",
		]);
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		const structuredRestart = await this.dependencies.restartStructuredTaskSession?.(
			scope,
			command.taskId,
			command.operationId,
		);
		if (structuredRestart !== null && structuredRestart !== undefined) {
			if (!structuredRestart.ok || !structuredRestart.summary) {
				return await this.finish(scope, operation, {
					status: "failed",
					outcomeCode: "session_start_failed",
					error: structuredRestart.error ?? "Structured owner restart failed.",
				});
			}
			return await this.completeWithSummary(
				scope,
				operation,
				precondition.state,
				structuredRestart.summary,
				"completed",
			);
		}
		operation = await this.setPhase(scope, operation, "stopping_session");
		const stopped = await this.stopOne(scope, command.taskId, command.sessionInstanceId ?? undefined);
		if (!this.didStop(stopped)) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed",
				error: stopped.error,
			});
		}
		return await this.launchOrCompensate(scope, operation, precondition.card, precondition.state, {
			resumeConversation: true,
			// Replacing a process is not proof that provider work resumed. Keep the
			// restarted task in neutral Review until a current native hook confirms
			// either work or completion.
			awaitReview: true,
			cols: command.cols,
			rows: command.rows,
			compensateTo: null,
		});
	}

	private async executeDelete(
		scope: ProjectBoardCommandScope,
		command: Extract<RuntimeTaskLifecycleCommand, { kind: "delete" }>,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		// The phase write happens before the durable delete command. If the runtime
		// exits after that command commits but before the journal is finalized, the
		// card is intentionally gone and cannot satisfy the normal identity check.
		// Replaying the stable board receipt is the only authoritative proof that
		// this operation performed the deletion; a first-seen no-op remains stale.
		if (operation.phase === "deleting_card") {
			const state = await this.loadState(scope);
			if (!findCardInBoard(state.board, command.taskId)) {
				const replayedDelete = await this.executeBoard(scope, {
					commandId: getStepCommandId(command.operationId, "delete"),
					expectedRevision: command.expectedRevision,
					command: { kind: "delete_tasks", taskIds: [command.taskId] },
				});
				if (replayedDelete.replayed && !findCardInBoard(replayedDelete.state.board, command.taskId)) {
					operation = await this.recordBoardAccepted(scope, operation, replayedDelete.state.revision);
					await this.dependencies.onTaskDeleted?.(scope, command.taskId);
					return await this.finish(scope, operation, {
						status: "completed",
						outcomeCode: "already_applied",
						state: replayedDelete.state,
					});
				}
				return await this.finish(scope, operation, {
					status: "superseded",
					outcomeCode: "stale_task",
					error: "Task identity no longer matches this delete operation.",
					state: replayedDelete.state,
				});
			}
		}
		const precondition = await this.validateTask(scope, command.taskId, command.taskCreatedAt, "trash");
		if (!precondition.ok) {
			return await this.finish(scope, operation, precondition.failure);
		}
		operation = await this.setPhase(scope, operation, "stopping_session");
		const stopped = await this.stopTaskAndDetailShell(
			scope,
			command.taskId,
			command.operationId,
			command.sessionInstanceId ?? undefined,
		);
		if (!this.didStop(stopped)) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed",
				error: stopped.error,
			});
		}
		operation = await this.setPhase(scope, operation, "purging_workspace");
		if (precondition.card.useWorktree !== false) {
			const purged = await (this.dependencies.purgeTaskWorkspace ?? purgeTaskWorkspaceForDelete)({
				repoPath: scope.projectPath,
				taskId: command.taskId,
				operationId: command.operationId,
			});
			if (!purged.ok) {
				return await this.finish(scope, operation, {
					status: "failed",
					outcomeCode: "worktree_failed",
					error: purged.error ?? "Could not permanently remove the task workspace.",
				});
			}
		}
		operation = await this.setPhase(scope, operation, "deleting_card");
		const deleted = await this.executeBoardWithSemanticRebase(scope, {
			commandId: getStepCommandId(command.operationId, "delete"),
			expectedRevision: command.expectedRevision,
			command: { kind: "delete_tasks", taskIds: [command.taskId] },
			taskCreatedAt: command.taskCreatedAt,
		});
		if (!deleted.acceptedChange && findCardInBoard(deleted.state.board, command.taskId)) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "invalid_transition",
				error: "Task could not be permanently deleted.",
				state: deleted.state,
			});
		}
		operation = await this.recordBoardAccepted(scope, operation, deleted.state.revision);
		await this.dependencies.onTaskDeleted?.(scope, command.taskId);
		return await this.finish(scope, operation, {
			status: "completed",
			outcomeCode: deleted.replayed ? "already_applied" : "completed",
			state: deleted.state,
		});
	}

	private async launchOrCompensate(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		card: RuntimeBoardCard,
		state: RuntimeProjectStateResponse,
		options: {
			resumeConversation: boolean;
			awaitReview: boolean;
			cols?: number;
			rows?: number;
			compensateTo: "backlog" | "trash" | null;
			warning?: string;
		},
	): Promise<RuntimeTaskLifecycleResult> {
		operation = await this.setPhase(scope, operation, "starting_session");
		let response: RuntimeTaskSessionStartResponse;
		try {
			response = await this.dependencies.startTaskSession(scope, {
				taskId: card.id,
				launchOperationId: operation.operationId,
				prompt: options.resumeConversation ? "" : card.prompt,
				images: options.resumeConversation ? undefined : card.images,
				agentId: card.agentId,
				resumeConversation: options.resumeConversation,
				awaitReview: options.awaitReview,
				baseRef: card.baseRef,
				useWorktree: card.useWorktree,
				cols: options.cols,
				rows: options.rows,
			});
		} catch (error) {
			const matching = await this.getMatchingLaunchSummary(scope, card.id, operation.operationId);
			if (isSuccessfulLaunch(matching, operation.operationId)) {
				return await this.completeWithSummary(
					scope,
					operation,
					state,
					matching,
					"already_applied",
					options.warning,
				);
			}
			return await this.handleLaunchFailure(
				scope,
				operation,
				card,
				state,
				options.compensateTo,
				toErrorMessage(error),
			);
		}
		if (!response.ok || !response.summary || response.summary.taskId !== card.id) {
			const matching = await this.getMatchingLaunchSummary(scope, card.id, operation.operationId);
			if (isSuccessfulLaunch(matching, operation.operationId)) {
				return await this.completeWithSummary(
					scope,
					operation,
					state,
					matching,
					"already_applied",
					options.warning,
				);
			}
			return await this.handleLaunchFailure(
				scope,
				operation,
				card,
				state,
				options.compensateTo,
				response.error ?? "Task session start failed.",
			);
		}
		return await this.completeWithSummary(
			scope,
			operation,
			state,
			response.summary,
			options.warning ? "completed_with_warning" : "completed",
			options.warning,
		);
	}

	private async handleLaunchFailure(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		card: RuntimeBoardCard,
		state: RuntimeProjectStateResponse,
		compensateTo: "backlog" | "trash" | null,
		error: string,
	): Promise<RuntimeTaskLifecycleResult> {
		if (!compensateTo) {
			return await this.finish(scope, operation, {
				status: "failed",
				outcomeCode: "session_start_failed",
				error,
				state,
			});
		}
		const sourceColumn = compensateTo === "backlog" ? "in_progress" : "review";
		const compensated = await this.compensateMove(
			scope,
			operation,
			card.id,
			card.createdAt,
			sourceColumn,
			compensateTo,
			operation.requestedAt,
		);
		return await this.finish(scope, operation, {
			status: "failed",
			outcomeCode: compensated.ok ? "session_start_failed" : "compensation_failed",
			error,
			state: compensated.state,
		});
	}

	private async compensateMove(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		taskId: string,
		taskCreatedAt: number,
		sourceColumnId: "in_progress" | "review" | "trash",
		targetColumnId: "backlog" | "in_progress" | "review" | "trash",
		updatedAt: number,
	): Promise<{ ok: boolean; state: RuntimeProjectStateResponse }> {
		operation = await this.setPhase(scope, operation, "compensating");
		const state = await this.loadState(scope);
		const card = findCardInBoard(state.board, taskId);
		const matchingLaunch = await this.getMatchingLaunchSummary(scope, taskId, operation.operationId);
		if (
			!isTaskIdentityCurrent(card, taskId, taskCreatedAt) ||
			getTaskColumnId(state.board, taskId) !== sourceColumnId ||
			isSuccessfulLaunch(matchingLaunch, operation.operationId)
		) {
			log.warn(
				"task lifecycle compensation suppressed by newer authoritative state",
				this.logFields(operation, { outcome: "superseded", observedRevision: state.revision }),
			);
			return { ok: false, state };
		}
		try {
			const result = await this.executeBoard(scope, {
				commandId: getStepCommandId(operation.operationId, "compensate"),
				expectedRevision: state.revision,
				command: {
					kind: "move_task",
					taskId,
					sourceColumnId,
					targetColumnId,
					targetIndex: 0,
					updatedAt,
				},
			});
			log.warn(
				"task lifecycle transition compensated",
				this.logFields(operation, {
					outcome: result.acceptedChange ? "compensated" : "compensation_rejected",
					observedRevision: result.state.revision,
				}),
			);
			return { ok: result.acceptedChange, state: result.state };
		} catch (error) {
			log.error(
				"task lifecycle compensation failed",
				this.logFields(operation, { outcome: "compensation_failed", error: toErrorMessage(error) }),
			);
			return { ok: false, state: await this.loadState(scope) };
		}
	}

	private async validateTask(
		scope: ProjectBoardCommandScope,
		taskId: string,
		taskCreatedAt: number,
		expectedColumn: RuntimeTaskLifecycleOperation["sourceColumnId"] | readonly string[],
	): Promise<
		| { ok: true; state: RuntimeProjectStateResponse; card: RuntimeBoardCard }
		| {
				ok: false;
				failure: {
					status: "failed" | "superseded";
					outcomeCode: "stale_task" | "invalid_transition";
					error: string;
					state: RuntimeProjectStateResponse;
				};
		  }
	> {
		const state = await this.loadState(scope);
		const card = findCardInBoard(state.board, taskId);
		if (!isTaskIdentityCurrent(card, taskId, taskCreatedAt)) {
			return {
				ok: false,
				failure: {
					status: "superseded",
					outcomeCode: "stale_task",
					error: "Task identity no longer matches this operation.",
					state,
				},
			};
		}
		const columnId = getTaskColumnId(state.board, taskId);
		const accepted = Array.isArray(expectedColumn)
			? expectedColumn.includes(columnId ?? "")
			: columnId === expectedColumn;
		if (!accepted) {
			return {
				ok: false,
				failure: {
					status: "failed",
					outcomeCode: "invalid_transition",
					error: "Task is no longer in the expected column.",
					state,
				},
			};
		}
		return { ok: true, state, card: card as RuntimeBoardCard };
	}

	private async validateTaskIdentity(
		scope: ProjectBoardCommandScope,
		taskId: string,
		taskCreatedAt: number,
	): Promise<
		| { ok: true; state: RuntimeProjectStateResponse; card: RuntimeBoardCard }
		| {
				ok: false;
				failure: {
					status: "superseded";
					outcomeCode: "stale_task";
					error: string;
					state: RuntimeProjectStateResponse;
				};
		  }
	> {
		const state = await this.loadState(scope);
		const card = findCardInBoard(state.board, taskId);
		if (!isTaskIdentityCurrent(card, taskId, taskCreatedAt)) {
			return {
				ok: false,
				failure: {
					status: "superseded",
					outcomeCode: "stale_task",
					error: "Task identity no longer matches this operation.",
					state,
				},
			};
		}
		return { ok: true, state, card };
	}

	private async executeBoardWithSemanticRebase(
		scope: ProjectBoardCommandScope,
		input: Parameters<ProjectBoardCommandService["execute"]>[1] & { taskCreatedAt: number },
	) {
		let candidate = input;
		let retryCount = 0;
		while (true) {
			try {
				return await this.executeBoard(scope, candidate);
			} catch (error) {
				if (!(error instanceof ProjectStateConflictError) || retryCount >= MAX_SEMANTIC_REBASE_RETRIES) {
					throw error;
				}
				const state = await this.loadState(scope);
				const command = candidate.command;
				const taskId =
					command.kind === "delete_tasks" ? command.taskIds[0] : "taskId" in command ? command.taskId : null;
				const card = taskId ? findCardInBoard(state.board, taskId) : null;
				if (!taskId) {
					throw error;
				}
				if (command.kind === "create_task") {
					// Creating a fresh stable identity commutes with unrelated board
					// mutations such as automatic titles and session projections. The
					// original revision still protects identity: never rebase if that ID
					// appeared while this operation was waiting.
					if (card) {
						throw error;
					}
				} else if (!isTaskIdentityCurrent(card, taskId, input.taskCreatedAt)) {
					throw error;
				}
				if (command.kind === "move_task" && getTaskColumnId(state.board, taskId) !== command.sourceColumnId) {
					throw error;
				}
				if (command.kind === "delete_tasks" && getTaskColumnId(state.board, taskId) !== "trash") {
					throw error;
				}
				retryCount += 1;
				log.debug("task lifecycle board step semantically rebased", {
					projectId: scope.projectId,
					taskId,
					boardCommandId: input.commandId,
					expectedRevision: candidate.expectedRevision,
					observedRevision: state.revision,
					retryCount,
					maxRetries: MAX_SEMANTIC_REBASE_RETRIES,
				});
				candidate = { ...candidate, expectedRevision: state.revision };
			}
		}
	}

	private async executeBoard(
		scope: ProjectBoardCommandScope,
		input: Parameters<ProjectBoardCommandService["execute"]>[1],
	) {
		return await this.dependencies.boardCommands.execute(scope, input);
	}

	private async stopOne(
		scope: ProjectBoardCommandScope,
		taskId: string,
		sessionInstanceId?: string,
	): Promise<StopTaskSessionResult> {
		if (!this.dependencies.stopTaskSession) {
			return {
				summary: null,
				requestedSessionInstanceId: sessionInstanceId ?? null,
				didExit: true,
				outcome: "not_running",
			};
		}
		try {
			return await this.dependencies.stopTaskSession(scope, taskId, sessionInstanceId);
		} catch (error) {
			return {
				summary: null,
				requestedSessionInstanceId: sessionInstanceId ?? null,
				didExit: false,
				outcome: "failed",
				error: toErrorMessage(error),
			};
		}
	}

	private didStop(result: StopTaskSessionResult): boolean {
		return result.didExit && result.outcome !== "failed" && result.outcome !== "timed_out";
	}

	private async stopTaskAndDetailShell(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string,
		sessionInstanceId?: string,
	): Promise<StopTaskSessionResult> {
		const taskStop = await this.stopOne(scope, taskId, sessionInstanceId);
		if (!this.didStop(taskStop)) {
			log.warn("task lifecycle stop did not complete", {
				projectId: scope.projectId,
				taskId,
				operationId,
				sessionInstanceId: taskStop.requestedSessionInstanceId,
				outcome: taskStop.outcome,
				error: taskStop.error ?? null,
			});
			return taskStop;
		}
		const shellStop = await this.stopOne(scope, getRuntimeDetailTerminalTaskId(taskId));
		if (!this.didStop(shellStop)) {
			log.warn("task lifecycle detail shell stop did not complete", {
				projectId: scope.projectId,
				taskId,
				operationId,
				outcome: shellStop.outcome,
				error: shellStop.error ?? null,
			});
			return shellStop;
		}
		return taskStop;
	}

	private async getMatchingLaunchSummary(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string,
	): Promise<RuntimeTaskSessionSummary | null> {
		const live = await this.dependencies.getTaskSessionSummary?.(scope, taskId);
		if (live?.launchOperationId === operationId) {
			return live;
		}
		const state = await this.loadState(scope);
		const persisted = state.sessions[taskId] ?? null;
		return persisted?.launchOperationId === operationId ? persisted : null;
	}

	private async setPhase(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		phase: PersistedTaskLifecycleOperation["phase"],
	): Promise<PersistedTaskLifecycleOperation> {
		return await this.operationStore.update(scope, operation.operationId, (current) => ({ ...current, phase }));
	}

	private async recordBoardAccepted(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		revision: number,
	): Promise<PersistedTaskLifecycleOperation> {
		return await this.operationStore.update(scope, operation.operationId, (current) => ({
			...current,
			acceptedBoardRevision: revision,
		}));
	}

	private async completeWithSummary(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		state: RuntimeProjectStateResponse,
		summary: RuntimeTaskSessionSummary,
		outcomeCode: "completed" | "completed_with_warning" | "already_applied",
		warning?: string,
	): Promise<RuntimeTaskLifecycleResult> {
		return await this.finish(scope, operation, {
			status: warning ? "completed_with_warning" : "completed",
			outcomeCode,
			warning,
			state: withSessionSummary(state, summary),
			summary,
		});
	}

	private async finish(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
		input: {
			status: "completed" | "completed_with_warning" | "failed" | "superseded";
			outcomeCode: RuntimeTaskLifecycleOutcomeCode;
			state?: RuntimeProjectStateResponse;
			summary?: RuntimeTaskSessionSummary | null;
			warning?: string;
			error?: string;
		},
	): Promise<RuntimeTaskLifecycleResult> {
		const completedAt = Date.now();
		const finished = await this.operationStore.update(scope, operation.operationId, (current) => ({
			...current,
			status: input.status,
			phase: "finished",
			outcomeCode: input.outcomeCode,
			completedAt,
			warning: input.warning ?? null,
			error: input.error ?? null,
		}));
		let state = input.state ?? (await this.loadState(scope));
		const summary =
			input.summary === undefined
				? await this.getCurrentSessionSummary(scope, operation.taskId, state)
				: input.summary;
		if (summary) {
			state = withSessionSummary(state, summary);
		}
		const ok = outcomeIsSuccess(finished.outcomeCode);
		const fields = this.logFields(finished, { outcome: input.outcomeCode });
		if (ok) {
			log.info("task lifecycle operation completed", fields);
		} else {
			log.warn("task lifecycle operation finished without success", {
				...fields,
				error: input.error ?? null,
			});
		}
		return {
			ok,
			operation: toPublicOperation(finished),
			state,
			summary,
			...(input.warning ? { warning: input.warning } : {}),
			...(input.error ? { error: input.error } : {}),
		};
	}

	private async resultFromOperation(
		scope: ProjectBoardCommandScope,
		operation: PersistedTaskLifecycleOperation,
	): Promise<RuntimeTaskLifecycleResult> {
		let state = await this.loadState(scope);
		const summary = await this.getCurrentSessionSummary(scope, operation.taskId, state);
		if (summary) {
			state = withSessionSummary(state, summary);
		}
		return {
			ok: outcomeIsSuccess(operation.outcomeCode),
			operation: toPublicOperation(operation),
			state,
			summary,
			...(operation.warning ? { warning: operation.warning } : {}),
			...(operation.error ? { error: operation.error } : {}),
		};
	}

	private async getCurrentSessionSummary(
		scope: ProjectBoardCommandScope,
		taskId: string,
		state: RuntimeProjectStateResponse,
	): Promise<RuntimeTaskSessionSummary | null> {
		return (await this.dependencies.getTaskSessionSummary?.(scope, taskId)) ?? state.sessions[taskId] ?? null;
	}

	private async syntheticFailure(
		scope: ProjectBoardCommandScope,
		command: RuntimeTaskLifecycleCommand,
		outcome: "busy" | "identity_conflict",
		error: string,
	): Promise<RuntimeTaskLifecycleResult> {
		const state = await this.loadState(scope);
		const identity = getTaskIdentity(command);
		log.warn("task lifecycle operation rejected", {
			projectId: scope.projectId,
			taskId: identity.taskId,
			taskCreatedAt: identity.taskCreatedAt,
			operationId: command.operationId,
			operationKind: command.kind,
			phase: "requested",
			outcome,
			error,
		});
		return {
			ok: false,
			operation: createSyntheticOperation(scope, command, outcome),
			state,
			summary: state.sessions[identity.taskId] ?? null,
			error,
		};
	}

	private async loadState(scope: ProjectBoardCommandScope): Promise<RuntimeProjectStateResponse> {
		return this.dependencies.loadState
			? await this.dependencies.loadState(scope)
			: await loadProjectState(scope.projectPath);
	}

	private logFields(operation: PersistedTaskLifecycleOperation, extra: Record<string, unknown> = {}) {
		return {
			projectId: operation.projectId,
			taskId: operation.taskId,
			taskCreatedAt: operation.taskCreatedAt,
			operationId: operation.operationId,
			operationKind: operation.kind,
			phase: operation.phase,
			acceptedBoardRevision: operation.acceptedBoardRevision,
			launchOperationId: operation.launchOperationId,
			attempt: operation.attempt,
			...extra,
		};
	}
}
