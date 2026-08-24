import { createHash } from "node:crypto";

import type {
	RuntimeProjectBoardCommand,
	RuntimeProjectBoardCommandBatchEnvelope,
	RuntimeProjectBoardCommandEnvelope,
	RuntimeProjectMetadata,
	RuntimeTaskSessionSummary,
} from "../core";
import {
	applyProjectBoardCommands,
	createTaggedLogger,
	isLifecycleManagedBoardCommand,
	projectRuntimeSessionsOntoBoard,
	projectRuntimeTaskBaseRefOntoBoard,
	projectRuntimeTaskMetadataOntoBoard,
	runtimeProjectBoardCommandBatchEnvelopeSchema,
	runtimeProjectBoardCommandEnvelopeSchema,
} from "../core";
import { type ApplyProjectBoardMutationResult, applyProjectBoardMutation } from "./project-state";

const log = createTaggedLogger("project-board-command");

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface ProjectBoardCommandScope {
	projectId: string;
	projectPath: string;
}

export type ExecuteProjectBoardCommandInput = RuntimeProjectBoardCommandEnvelope;
export type ExecuteProjectBoardCommandBatchInput = RuntimeProjectBoardCommandBatchEnvelope;

export interface ProjectBoardCommandServiceDependencies {
	getAuthoritativeSessions: (
		scope: ProjectBoardCommandScope,
	) => Promise<Record<string, RuntimeTaskSessionSummary>> | Record<string, RuntimeTaskSessionSummary>;
	publishAuthoritativeState?: (
		scope: ProjectBoardCommandScope,
		result: ApplyProjectBoardMutationResult,
	) => Promise<void> | void;
}

export class ProjectBoardLifecycleCommandRequiredError extends Error {
	constructor(readonly commandKind: RuntimeProjectBoardCommand["kind"]) {
		super("This task transition must be performed through the task lifecycle service.");
		this.name = "ProjectBoardLifecycleCommandRequiredError";
	}
}

/**
 * Runtime-owned persistence boundary for prepared board commands.
 *
 * This service intentionally owns no transport, lifecycle, or worktree policy.
 * The local tRPC boundary and runtime-owned projections both enter through this
 * singleton, while durable receipts make ambiguous transport retries safe.
 */
export class ProjectBoardCommandService {
	constructor(private readonly dependencies: ProjectBoardCommandServiceDependencies) {}

	async execute(
		scope: ProjectBoardCommandScope,
		input: ExecuteProjectBoardCommandInput,
	): Promise<ApplyProjectBoardMutationResult> {
		const envelope = runtimeProjectBoardCommandEnvelopeSchema.parse(input);
		return await this.executeBatch(scope, {
			commandId: envelope.commandId,
			expectedRevision: envelope.expectedRevision,
			commands: [envelope.command],
		});
	}

	async executeBatch(
		scope: ProjectBoardCommandScope,
		input: ExecuteProjectBoardCommandBatchInput,
	): Promise<ApplyProjectBoardMutationResult> {
		const envelope = runtimeProjectBoardCommandBatchEnvelopeSchema.parse(input);
		const fingerprint = createHash("sha256").update(JSON.stringify(envelope.commands)).digest("hex");
		const sessions = await this.dependencies.getAuthoritativeSessions(scope);
		const result = await applyProjectBoardMutation(scope.projectPath, {
			expectedRevision: envelope.expectedRevision,
			sessions,
			commandIdentity: {
				commandId: envelope.commandId,
				fingerprint,
			},
			mutate: (board) => applyProjectBoardCommands(board, envelope.commands),
		});
		try {
			await this.dependencies.publishAuthoritativeState?.(scope, result);
		} catch (error) {
			// Persistence already committed. Publication is a wake-up hint and a
			// later replay/reconnect can publish the same authoritative snapshot.
			log.warn("authoritative board state publication failed", {
				projectId: scope.projectId,
				commandId: envelope.commandId,
				error: toErrorMessage(error),
			});
		}
		return result;
	}

	async executeClientBatch(
		scope: ProjectBoardCommandScope,
		input: ExecuteProjectBoardCommandBatchInput,
	): Promise<ApplyProjectBoardMutationResult> {
		const envelope = runtimeProjectBoardCommandBatchEnvelopeSchema.parse(input);
		const managed = envelope.commands.find(isLifecycleManagedBoardCommand);
		if (managed) {
			throw new ProjectBoardLifecycleCommandRequiredError(managed.kind);
		}
		return await this.executeBatch(scope, envelope);
	}

	async executeLifecycle(
		scope: ProjectBoardCommandScope,
		input: ExecuteProjectBoardCommandInput,
	): Promise<ApplyProjectBoardMutationResult> {
		return await this.execute(scope, input);
	}

	async reconcileRuntimeSessions(scope: ProjectBoardCommandScope): Promise<ApplyProjectBoardMutationResult> {
		const sessions = await this.dependencies.getAuthoritativeSessions(scope);
		return await this.executeInternalMutation(scope, sessions, (board) =>
			projectRuntimeSessionsOntoBoard(board, Object.values(sessions), scope.projectPath),
		);
	}

	async reconcileRuntimeMetadata(
		scope: ProjectBoardCommandScope,
		metadata: RuntimeProjectMetadata,
	): Promise<ApplyProjectBoardMutationResult> {
		const sessions = await this.dependencies.getAuthoritativeSessions(scope);
		return await this.executeInternalMutation(scope, sessions, (board) =>
			projectRuntimeTaskMetadataOntoBoard(board, metadata.taskWorktrees, scope.projectPath),
		);
	}

	async reconcileRuntimeTaskBaseRef(
		scope: ProjectBoardCommandScope,
		taskId: string,
		baseRef: string,
	): Promise<ApplyProjectBoardMutationResult> {
		const sessions = await this.dependencies.getAuthoritativeSessions(scope);
		return await this.executeInternalMutation(scope, sessions, (board) =>
			projectRuntimeTaskBaseRefOntoBoard(board, taskId, baseRef),
		);
	}

	async setGeneratedTaskTitle(
		scope: ProjectBoardCommandScope,
		taskId: string,
		title: string,
		updatedAt: number = Date.now(),
	): Promise<ApplyProjectBoardMutationResult> {
		const sessions = await this.dependencies.getAuthoritativeSessions(scope);
		return await this.executeInternalMutation(scope, sessions, (board) =>
			applyProjectBoardCommands(board, [
				{
					kind: "patch_task",
					taskId,
					expectedTitle: null,
					title,
					updatedAt,
				},
			]),
		);
	}

	private async executeInternalMutation(
		scope: ProjectBoardCommandScope,
		sessions: Record<string, RuntimeTaskSessionSummary>,
		mutate: Parameters<typeof applyProjectBoardMutation>[1]["mutate"],
	): Promise<ApplyProjectBoardMutationResult> {
		const result = await applyProjectBoardMutation(scope.projectPath, {
			sessions,
			persistSessionsOnNoop: true,
			mutate,
		});
		if (result.changed) {
			try {
				await this.dependencies.publishAuthoritativeState?.(scope, result);
			} catch (error) {
				log.warn("authoritative runtime projection publication failed", {
					projectId: scope.projectId,
					error: toErrorMessage(error),
				});
			}
		}
		return result;
	}
}
