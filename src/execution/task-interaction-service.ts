import { createHash } from "node:crypto";

import type { TaskResourceOperationRunner } from "../core";
import type { ProjectBoardCommandScope } from "../state";
import {
	ExecutionOperationIdentityConflictError,
	ExecutionOwnershipBusyError,
	ProjectExecutionOwnershipStore,
} from "../state";
import {
	MAX_TASK_INTERACTION_ID_LENGTH,
	type TaskInteractionKind,
	type TaskInteractionOutcome,
	type TaskInteractionResult,
} from "./execution-ownership-contracts";
import type { StructuredOwnerRegistryContract } from "./structured-owner";
import type { TaskExecutionOwnershipService } from "./task-execution-ownership-service";

interface TaskInteractionCommandBase {
	operationId: string;
	taskId: string;
	expectedOwnerGeneration: number;
}

const MAX_TASK_INTERACTION_TEXT_BYTES = 64 * 1024;
const MAX_TASK_INTERACTION_QUESTION_COUNT = 64;
const MAX_TASK_INTERACTION_ANSWER_COUNT = 32;
const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);

export interface SendTaskMessageCommand extends TaskInteractionCommandBase {
	kind: "send_message";
	text: string;
}

export type AnswerTaskInteractionCommand = TaskInteractionCommandBase &
	(
		| {
				kind: "answer_prompt";
				interactionId: string;
				answer: { type: "question"; answers: Record<string, string[]> };
		  }
		| {
				kind: "answer_prompt";
				interactionId: string;
				answer: { type: "approval"; decision: "accept" | "acceptForSession" | "decline" | "cancel" };
		  }
		| {
				kind: "answer_prompt";
				interactionId: string;
				answer: { type: "elicitation"; action: "accept" | "decline" | "cancel"; content: unknown | null };
		  }
	);

export interface StopTaskInteractionCommand extends TaskInteractionCommandBase {
	kind: "stop_task";
}

export type TaskInteractionCommand = SendTaskMessageCommand | AnswerTaskInteractionCommand | StopTaskInteractionCommand;

export interface TaskAttentionRequest {
	id: string;
	kind: "question" | "permission" | "elicitation";
	sessionInstanceId: string;
	createdAt: number;
	promptText: string | null;
	options: readonly string[];
}

function fingerprintContent(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toClientUserMessageId(projectId: string, taskId: string, operationId: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([projectId, taskId, operationId]))
		.digest("hex")
		.slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function hasDisallowedStructuredTextControl(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 8 ||
				(codePoint >= 11 && codePoint <= 12) ||
				(codePoint >= 14 && codePoint <= 31) ||
				codePoint === 127)
		) {
			return true;
		}
	}
	return false;
}

function isBoundedStructuredText(value: string, options?: { allowEmpty?: boolean }): boolean {
	if (!options?.allowEmpty && value.trim().length === 0) return false;
	return (
		Buffer.byteLength(value, "utf8") <= MAX_TASK_INTERACTION_TEXT_BYTES && !hasDisallowedStructuredTextControl(value)
	);
}

function isBoundedIdentifier(value: string, maxLength: number): boolean {
	return value.trim().length > 0 && value.length <= maxLength && !hasDisallowedStructuredTextControl(value);
}

function isBoundedJson(value: unknown): boolean {
	try {
		const serialized = JSON.stringify(value);
		return (
			serialized !== undefined &&
			Buffer.byteLength(serialized, "utf8") <= MAX_TASK_INTERACTION_TEXT_BYTES &&
			!hasDisallowedStructuredTextControl(serialized)
		);
	} catch {
		return false;
	}
}

function isValidTaskInteractionCommand(command: TaskInteractionCommand): boolean {
	if (
		!isBoundedIdentifier(command.operationId, 128) ||
		!isBoundedIdentifier(command.taskId, MAX_TASK_INTERACTION_ID_LENGTH) ||
		!Number.isSafeInteger(command.expectedOwnerGeneration) ||
		command.expectedOwnerGeneration < 0
	) {
		return false;
	}
	if (command.kind === "send_message") return isBoundedStructuredText(command.text);
	if (command.kind === "stop_task") return true;
	if (!isBoundedIdentifier(command.interactionId, MAX_TASK_INTERACTION_ID_LENGTH)) {
		return false;
	}
	if (command.answer.type === "approval") return APPROVAL_DECISIONS.has(command.answer.decision);
	if (command.answer.type === "question") {
		const answers = Object.entries(command.answer.answers);
		return (
			isBoundedJson(command.answer.answers) &&
			answers.length <= MAX_TASK_INTERACTION_QUESTION_COUNT &&
			answers.every(
				([questionId, values]) =>
					isBoundedIdentifier(questionId, MAX_TASK_INTERACTION_ID_LENGTH) &&
					values.length <= MAX_TASK_INTERACTION_ANSWER_COUNT &&
					values.every((value) => isBoundedStructuredText(value, { allowEmpty: true })),
			)
		);
	}
	return ELICITATION_ACTIONS.has(command.answer.action) && isBoundedJson(command.answer.content);
}

export class TaskInteractionService {
	private readonly store: ProjectExecutionOwnershipStore;

	constructor(
		private readonly dependencies: {
			ownership: TaskExecutionOwnershipService;
			structuredOwners: StructuredOwnerRegistryContract;
			store?: ProjectExecutionOwnershipStore;
			taskResourceOperations: TaskResourceOperationRunner;
		},
	) {
		this.store = dependencies.store ?? new ProjectExecutionOwnershipStore();
	}

	async execute(scope: ProjectBoardCommandScope, command: TaskInteractionCommand): Promise<TaskInteractionResult> {
		if (!isValidTaskInteractionCommand(command)) {
			return { ok: false, outcome: "invalid_request", replayed: false };
		}
		const payloadFingerprint = fingerprintContent(command);
		let begun: Awaited<ReturnType<ProjectExecutionOwnershipStore["beginInteraction"]>>;
		try {
			begun = await this.store.beginInteraction(scope, {
				operationId: command.operationId,
				taskId: command.taskId,
				kind: command.kind,
				ownerGeneration: command.expectedOwnerGeneration,
				payloadFingerprint,
			});
		} catch (error) {
			if (error instanceof ExecutionOperationIdentityConflictError) {
				return { ok: false, outcome: "operation_identity_conflict", replayed: false };
			}
			if (error instanceof ExecutionOwnershipBusyError) {
				return { ok: false, outcome: "busy", replayed: false };
			}
			throw error;
		}
		if (begun.replayed) return this.replay(begun.operation);
		const ownership = await this.dependencies.ownership.getOwnership(scope, command.taskId);
		if (ownership?.state !== "structured" || ownership.ownerGeneration !== command.expectedOwnerGeneration) {
			return await this.finish(scope, command.operationId, "owner_not_structured");
		}

		try {
			switch (command.kind) {
				case "send_message": {
					const dispatched = await this.dependencies.taskResourceOperations.run(
						scope.projectId,
						command.taskId,
						async () => {
							const latest = await this.dependencies.ownership.getOwnership(scope, command.taskId);
							const owner = this.dependencies.structuredOwners.get(scope.projectId, command.taskId);
							if (
								latest?.state !== "structured" ||
								latest.ownerGeneration !== command.expectedOwnerGeneration ||
								!owner ||
								owner.context.ownerGeneration !== command.expectedOwnerGeneration ||
								!owner.hasWriteAuthority()
							) {
								return null;
							}
							if (owner.hasActiveTurn()) return "busy" as const;
							return await owner.startMessage(
								command.text,
								toClientUserMessageId(scope.projectId, command.taskId, command.operationId),
							);
						},
					);
					if (!dispatched) return await this.finish(scope, command.operationId, "owner_not_structured");
					if (dispatched === "busy") return await this.finish(scope, command.operationId, "turn_in_progress");
					const turn = await dispatched.completion;
					if (turn.status === "failed") return await this.finish(scope, command.operationId, "failed", turn.id);
					if (turn.status === "interrupted") {
						return await this.finish(scope, command.operationId, "interrupted", turn.id);
					}
					return await this.finish(scope, command.operationId, "completed", turn.id);
				}
				case "answer_prompt": {
					return await this.dependencies.taskResourceOperations.run(scope.projectId, command.taskId, async () => {
						const latest = await this.dependencies.ownership.getOwnership(scope, command.taskId);
						const owner = this.dependencies.structuredOwners.get(scope.projectId, command.taskId);
						if (
							latest?.state !== "structured" ||
							latest.ownerGeneration !== command.expectedOwnerGeneration ||
							!owner ||
							owner.context.ownerGeneration !== command.expectedOwnerGeneration ||
							!owner.hasWriteAuthority()
						) {
							return await this.finish(
								scope,
								command.operationId,
								command.answer.type === "approval" ? "approval_not_found" : "question_not_found",
							);
						}
						return await this.finish(
							scope,
							command.operationId,
							owner.answerInteraction(command.interactionId, command.answer),
						);
					});
				}
				case "stop_task": {
					const stopped = await this.dependencies.taskResourceOperations.run(
						scope.projectId,
						command.taskId,
						async () => {
							const latest = await this.dependencies.ownership.getOwnership(scope, command.taskId);
							if (latest?.state !== "structured" || latest.ownerGeneration !== command.expectedOwnerGeneration) {
								return null;
							}
							return await this.dependencies.ownership.stopCurrentOwner(scope, command.taskId);
						},
					);
					if (!stopped) return await this.finish(scope, command.operationId, "owner_not_structured");
					return await this.finish(scope, command.operationId, stopped.didExit ? "completed" : "failed");
				}
			}
		} catch {
			if (command.kind === "send_message") {
				await this.store.finishInteraction(scope, command.operationId, {
					outcome: "turn_outcome_unknown",
					outcomeUnknown: true,
				});
				return { ok: false, outcome: "turn_outcome_unknown", replayed: false };
			}
			return await this.finish(scope, command.operationId, "failed");
		}
	}

	async listPendingAttention(
		scope: ProjectBoardCommandScope,
		taskId: string,
	): Promise<readonly TaskAttentionRequest[]> {
		const ownership = await this.dependencies.ownership.getOwnership(scope, taskId);
		const owner = this.dependencies.structuredOwners.get(scope.projectId, taskId);
		if (
			ownership?.state !== "structured" ||
			!owner ||
			ownership.ownerGeneration !== owner.context.ownerGeneration ||
			ownership.ownerSessionInstanceId !== owner.context.ownerSessionInstanceId ||
			!owner.hasWriteAuthority()
		) {
			return [];
		}
		return owner.listPendingInteractions().map((interaction) => ({
			id: interaction.interactionId,
			kind: interaction.kind === "approval" ? "permission" : interaction.kind,
			sessionInstanceId: owner.context.ownerSessionInstanceId,
			createdAt: interaction.createdAt,
			promptText: interaction.promptText,
			options: [...interaction.optionLabels],
		}));
	}

	private replay(operation: {
		status: string;
		outcome: TaskInteractionOutcome | null;
		providerTurnId: string | null;
	}): TaskInteractionResult {
		if (operation.status === "completed") {
			return {
				ok: true,
				outcome: "already_applied",
				replayed: true,
				...(operation.providerTurnId ? { turnId: operation.providerTurnId } : {}),
			};
		}
		if (operation.status === "pending" || operation.status === "outcome_unknown") {
			return { ok: false, outcome: "turn_outcome_unknown", replayed: true };
		}
		return { ok: false, outcome: operation.outcome ?? "failed", replayed: true };
	}

	private async finish(
		scope: ProjectBoardCommandScope,
		operationId: string,
		outcome: TaskInteractionOutcome,
		providerTurnId?: string | null,
	): Promise<TaskInteractionResult> {
		await this.store.finishInteraction(scope, operationId, { outcome, providerTurnId });
		return {
			ok: outcome === "completed",
			outcome,
			replayed: false,
			...(providerTurnId ? { turnId: providerTurnId } : {}),
		};
	}
}

export function isTaskInteractionKind(value: string): value is TaskInteractionKind {
	return value === "send_message" || value === "answer_prompt" || value === "stop_task";
}
