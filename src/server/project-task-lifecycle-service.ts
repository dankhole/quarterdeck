import { createHash } from "node:crypto";

import type {
	RuntimeBoardCard,
	RuntimeProjectBoardCommand,
	RuntimeProjectStateResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
} from "../core";
import { findCardInBoard, getTaskColumnId, runtimeProjectBoardCommandSchema } from "../core";
import { type ProjectBoardCommandScope, type ProjectBoardCommandService, ProjectStateConflictError } from "../state";

type RuntimeCreateTaskCommand = Extract<RuntimeProjectBoardCommand, { kind: "create_task" }>;

export type ProjectTaskCreateSpec = Omit<RuntimeCreateTaskCommand, "kind" | "columnId">;

export interface ProjectTaskCreateAndStartInput {
	commandId: string;
	expectedRevision: number;
	task: ProjectTaskCreateSpec;
	startedAt: number;
	cols?: number;
	rows?: number;
}

export type ProjectTaskCreateAndStartFailureCode =
	| "task_already_exists"
	| "task_identity_changed"
	| "task_not_startable"
	| "session_start_failed"
	| "session_start_interrupted";

export type ProjectTaskCreateAndStartResult =
	| {
			ok: true;
			state: RuntimeProjectStateResponse;
			summary: RuntimeTaskSessionSummary;
			replayed: boolean;
	  }
	| {
			ok: false;
			state: RuntimeProjectStateResponse;
			summary: RuntimeTaskSessionSummary | null;
			replayed: boolean;
			code: ProjectTaskCreateAndStartFailureCode;
			error: string;
	  };

export interface ProjectTaskLifecycleServiceDependencies {
	boardCommands: Pick<ProjectBoardCommandService, "execute">;
	startTaskSession: (
		scope: ProjectBoardCommandScope,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
}

interface InFlightCreateAndStart {
	fingerprint: string;
	promise: Promise<ProjectTaskCreateAndStartResult>;
}

export class ProjectTaskLifecycleIdentityConflictError extends Error {
	readonly commandId: string;

	constructor(commandId: string) {
		super(`Project task lifecycle command "${commandId}" is already running with different content.`);
		this.name = "ProjectTaskLifecycleIdentityConflictError";
		this.commandId = commandId;
	}
}

function getLifecycleCommandId(operationId: string, step: "create" | "move" | "recover"): string {
	const normalizedOperationId = operationId.trim();
	if (!normalizedOperationId) {
		throw new Error("Project task lifecycle command ID is required.");
	}
	const commandId = `${normalizedOperationId}:${step}`;
	if (commandId.length > 128) {
		throw new Error("Project task lifecycle command ID is too long.");
	}
	return commandId;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getCreateAndStartFingerprint(input: ProjectTaskCreateAndStartInput): string {
	const createCommand = runtimeProjectBoardCommandSchema.parse({
		...input.task,
		kind: "create_task",
		columnId: "backlog",
	});
	const moveCommand = runtimeProjectBoardCommandSchema.parse({
		kind: "move_task",
		taskId: input.task.taskId,
		sourceColumnId: "backlog",
		targetColumnId: "in_progress",
		targetIndex: 0,
		updatedAt: input.startedAt,
	});
	return createHash("sha256")
		.update(
			JSON.stringify({
				createCommand,
				moveCommand,
				cols: input.cols ?? null,
				rows: input.rows ?? null,
			}),
		)
		.digest("hex");
}

function withSessionSummary(
	state: RuntimeProjectStateResponse,
	summary: RuntimeTaskSessionSummary,
): RuntimeProjectStateResponse {
	return {
		...state,
		sessions: {
			...state.sessions,
			[summary.taskId]: summary,
		},
	};
}

function isStartedSessionSummary(summary: RuntimeTaskSessionSummary | undefined): summary is RuntimeTaskSessionSummary {
	return summary?.startedAt !== null && summary?.startedAt !== undefined;
}

function isCreatedTaskIdentityCurrent(card: RuntimeBoardCard | null, task: ProjectTaskCreateSpec): boolean {
	return card?.id === task.taskId && card.createdAt === task.createdAt;
}

/**
 * Headless runtime orchestration boundary for task lifecycle effects.
 *
 * The first slice covers create-and-start. It composes durable board
 * subcommands with the server-owned session launcher, which remains
 * responsible for worktree resolution and agent startup.
 */
export class ProjectTaskLifecycleService {
	private readonly inFlightCreateAndStartByKey = new Map<string, InFlightCreateAndStart>();

	constructor(private readonly dependencies: ProjectTaskLifecycleServiceDependencies) {}

	async createAndStartTask(
		scope: ProjectBoardCommandScope,
		input: ProjectTaskCreateAndStartInput,
	): Promise<ProjectTaskCreateAndStartResult> {
		const operationId = input.commandId.trim();
		getLifecycleCommandId(operationId, "recover");
		const operationKey = JSON.stringify([scope.projectId, scope.projectPath, operationId]);
		const fingerprint = getCreateAndStartFingerprint(input);
		const inFlight = this.inFlightCreateAndStartByKey.get(operationKey);
		if (inFlight) {
			if (inFlight.fingerprint !== fingerprint) {
				throw new ProjectTaskLifecycleIdentityConflictError(operationId);
			}
			return await inFlight.promise;
		}

		const promise = this.executeCreateAndStartTask(scope, input);
		this.inFlightCreateAndStartByKey.set(operationKey, { fingerprint, promise });
		try {
			return await promise;
		} finally {
			const current = this.inFlightCreateAndStartByKey.get(operationKey);
			if (current?.promise === promise) {
				this.inFlightCreateAndStartByKey.delete(operationKey);
			}
		}
	}

	private async executeCreateAndStartTask(
		scope: ProjectBoardCommandScope,
		input: ProjectTaskCreateAndStartInput,
	): Promise<ProjectTaskCreateAndStartResult> {
		const createResult = await this.dependencies.boardCommands.execute(scope, {
			commandId: getLifecycleCommandId(input.commandId, "create"),
			expectedRevision: input.expectedRevision,
			command: {
				...input.task,
				kind: "create_task",
				columnId: "backlog",
			},
		});

		if (!createResult.acceptedChange) {
			return {
				ok: false,
				state: createResult.state,
				summary: null,
				replayed: createResult.replayed,
				code: "task_already_exists",
				error: `Task "${input.task.taskId}" already exists.`,
			};
		}
		if (!isCreatedTaskIdentityCurrent(findCardInBoard(createResult.state.board, input.task.taskId), input.task)) {
			return {
				ok: false,
				state: createResult.state,
				summary: null,
				replayed: createResult.replayed,
				code: "task_identity_changed",
				error: `Task "${input.task.taskId}" no longer matches the created task identity.`,
			};
		}

		const moveResult = await this.dependencies.boardCommands.execute(scope, {
			commandId: getLifecycleCommandId(input.commandId, "move"),
			expectedRevision: createResult.state.revision,
			command: {
				kind: "move_task",
				taskId: input.task.taskId,
				sourceColumnId: "backlog",
				targetColumnId: "in_progress",
				targetIndex: 0,
				updatedAt: input.startedAt,
			},
		});
		const replayed = createResult.replayed || moveResult.replayed;

		if (!moveResult.acceptedChange) {
			return {
				ok: false,
				state: moveResult.state,
				summary: null,
				replayed,
				code: "task_not_startable",
				error: `Task "${input.task.taskId}" is no longer in backlog.`,
			};
		}

		if (moveResult.replayed) {
			const existingSummary = moveResult.state.sessions[input.task.taskId];
			if (isStartedSessionSummary(existingSummary)) {
				if (existingSummary.state === "failed" || existingSummary.state === "interrupted") {
					return {
						ok: false,
						state: moveResult.state,
						summary: existingSummary,
						replayed: true,
						code: "session_start_failed",
						error: "The recorded task session is no longer running.",
					};
				}
				return {
					ok: true,
					state: moveResult.state,
					summary: existingSummary,
					replayed: true,
				};
			}

			const recoveredState = await this.recoverUnstartedTask(scope, input, moveResult.state.revision);
			const recoveredToBacklog = getTaskColumnId(recoveredState.board, input.task.taskId) === "backlog";
			return {
				ok: false,
				state: recoveredState,
				summary: null,
				replayed: true,
				code: "session_start_interrupted",
				error: recoveredToBacklog
					? "Task creation was recorded, but session startup did not complete. The task was returned to backlog."
					: "Task creation was recorded, but session startup did not complete. No duplicate start was attempted.",
			};
		}

		const card = findCardInBoard(moveResult.state.board, input.task.taskId);
		if (!card || getTaskColumnId(moveResult.state.board, input.task.taskId) !== "in_progress") {
			return {
				ok: false,
				state: moveResult.state,
				summary: null,
				replayed,
				code: "task_not_startable",
				error: `Task "${input.task.taskId}" could not be prepared for startup.`,
			};
		}

		let startResponse: RuntimeTaskSessionStartResponse;
		try {
			startResponse = await this.dependencies.startTaskSession(scope, {
				taskId: card.id,
				prompt: card.prompt,
				images: card.images,
				agentId: card.agentId,
				baseRef: card.baseRef,
				useWorktree: card.useWorktree,
				cols: input.cols,
				rows: input.rows,
			});
		} catch (error) {
			const recoveredState = await this.recoverUnstartedTask(scope, input, moveResult.state.revision);
			return {
				ok: false,
				state: recoveredState,
				summary: null,
				replayed,
				code: "session_start_failed",
				error: toErrorMessage(error),
			};
		}

		if (!startResponse.ok || !startResponse.summary || startResponse.summary.taskId !== card.id) {
			const recoveredState = await this.recoverUnstartedTask(scope, input, moveResult.state.revision);
			return {
				ok: false,
				state: recoveredState,
				summary: null,
				replayed,
				code: "session_start_failed",
				error: startResponse.error ?? "Task session start failed.",
			};
		}

		return {
			ok: true,
			state: withSessionSummary(moveResult.state, startResponse.summary),
			summary: startResponse.summary,
			replayed,
		};
	}

	private async recoverUnstartedTask(
		scope: ProjectBoardCommandScope,
		input: ProjectTaskCreateAndStartInput,
		expectedRevision: number,
	): Promise<RuntimeProjectStateResponse> {
		const executeRecovery = async (revision: number) =>
			await this.dependencies.boardCommands.execute(scope, {
				commandId: getLifecycleCommandId(input.commandId, "recover"),
				expectedRevision: revision,
				command: {
					kind: "move_task",
					taskId: input.task.taskId,
					sourceColumnId: "in_progress",
					targetColumnId: "backlog",
					updatedAt: input.startedAt,
				},
			});

		try {
			return (await executeRecovery(expectedRevision)).state;
		} catch (error) {
			if (!(error instanceof ProjectStateConflictError)) {
				throw error;
			}
			return (await executeRecovery(error.currentRevision)).state;
		}
	}
}
