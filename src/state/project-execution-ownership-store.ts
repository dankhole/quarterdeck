import { COPYFILE_EXCL } from "node:constants";
import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { createTaggedLogger } from "../core";
import {
	type ExecutionHandoffOutcome,
	executionHandoffOutcomeSchema,
	type TaskExecutionOwnership,
	type TaskInteractionKind,
	type TaskInteractionOutcome,
	taskExecutionOwnershipSchema,
	taskInteractionKindSchema,
	taskInteractionOutcomeSchema,
} from "../execution/execution-ownership-contracts";
import { isNodeError, lockedFileSystem } from "../fs";
import type { ProjectBoardCommandScope } from "./project-board-command-service";
import { getProjectDirectoryLockRequest, getProjectExecutionOwnershipPath } from "./project-state-utils";

const MAX_TERMINAL_HANDOFFS = 200;
const MAX_TERMINAL_INTERACTIONS = 500;
const log = createTaggedLogger("execution-ownership-journal");

const handoffOperationSchema = z.object({
	operationId: z.string().min(1).max(128),
	projectId: z.string().min(1),
	taskId: z.string().min(1),
	fingerprint: z.string().length(64),
	targetOwner: z.enum(["native_tui", "structured"]),
	expectedOwnerGeneration: z.number().int().nonnegative(),
	status: z.enum(["pending", "completed", "failed"]),
	outcome: executionHandoffOutcomeSchema.nullable(),
	requestedAt: z.number().finite().nonnegative(),
	updatedAt: z.number().finite().nonnegative(),
});
export type PersistedExecutionHandoffOperation = z.infer<typeof handoffOperationSchema>;

const interactionOperationSchema = z.object({
	operationId: z.string().min(1).max(128),
	projectId: z.string().min(1),
	taskId: z.string().min(1),
	fingerprint: z.string().length(64),
	kind: taskInteractionKindSchema,
	ownerGeneration: z.number().int().nonnegative(),
	status: z.enum(["pending", "completed", "failed", "outcome_unknown"]),
	outcome: taskInteractionOutcomeSchema.nullable(),
	providerTurnId: z.string().min(1).nullable(),
	requestedAt: z.number().finite().nonnegative(),
	updatedAt: z.number().finite().nonnegative(),
});
export type PersistedTaskInteractionOperation = z.infer<typeof interactionOperationSchema>;

const executionOwnershipJournalSchema = z.object({
	version: z.literal(1),
	owners: z.record(z.string(), taskExecutionOwnershipSchema),
	handoffs: z.array(handoffOperationSchema),
	interactions: z.array(interactionOperationSchema),
});
type ExecutionOwnershipJournal = z.infer<typeof executionOwnershipJournalSchema>;

const EMPTY_JOURNAL: ExecutionOwnershipJournal = { version: 1, owners: {}, handoffs: [], interactions: [] };

export class ExecutionOperationIdentityConflictError extends Error {
	constructor(readonly operationId: string) {
		super(`Execution operation "${operationId}" was already used with different content.`);
		this.name = "ExecutionOperationIdentityConflictError";
	}
}

export class ExecutionOwnershipBusyError extends Error {
	constructor(readonly activeOperationId: string) {
		super(`Task already has an active execution operation "${activeOperationId}".`);
		this.name = "ExecutionOwnershipBusyError";
	}
}

export class ExecutionOwnershipGenerationConflictError extends Error {
	constructor(readonly currentOwnerGeneration: number | null) {
		super("Execution ownership generation changed before the operation was recorded.");
		this.name = "ExecutionOwnershipGenerationConflictError";
	}
}

export class ExecutionOwnershipJournalCorruptionError extends Error {
	constructor(
		readonly projectId: string,
		readonly backupPath: string | null,
	) {
		super(`Execution ownership journal for project "${projectId}" is invalid.`);
		this.name = "ExecutionOwnershipJournalCorruptionError";
	}
}

export function fingerprintExecutionOperation(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertJournalScope(scope: ProjectBoardCommandScope, journal: ExecutionOwnershipJournal): void {
	const handoffIds = new Set<string>();
	const interactionIds = new Set<string>();
	for (const [taskId, ownership] of Object.entries(journal.owners)) {
		if (
			ownership.projectId !== scope.projectId ||
			ownership.taskId !== taskId ||
			(ownership.ownerProcess !== null &&
				ownership.ownerProcess.sessionInstanceId !== ownership.ownerSessionInstanceId) ||
			(ownership.state === "native_tui" &&
				ownership.ownerProcess !== null &&
				ownership.ownerProcess.processKind !== "pty") ||
			(ownership.state === "structured" && ownership.ownerProcess?.processKind === "pty") ||
			(ownership.ownerProcess?.processKind === "stdio_app_server" && ownership.provider !== "codex") ||
			(ownership.ownerProcess?.processKind === "stdio_agent_sdk" && ownership.provider !== "claude") ||
			(ownership.state.includes("pending") ? ownership.pendingHandoff === null : ownership.pendingHandoff !== null)
		) {
			throw new Error("Execution ownership journal contains a cross-scope or incoherent owner record.");
		}
	}
	for (const operation of journal.handoffs) {
		if (operation.projectId !== scope.projectId || handoffIds.has(operation.operationId)) {
			throw new Error("Execution ownership journal contains an invalid handoff record.");
		}
		handoffIds.add(operation.operationId);
	}
	for (const operation of journal.interactions) {
		if (operation.projectId !== scope.projectId || interactionIds.has(operation.operationId)) {
			throw new Error("Execution ownership journal contains an invalid interaction record.");
		}
		interactionIds.add(operation.operationId);
	}
}

async function readJournal(scope: ProjectBoardCommandScope): Promise<ExecutionOwnershipJournal> {
	const path = getProjectExecutionOwnershipPath(scope.projectId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return EMPTY_JOURNAL;
		throw error;
	}
	try {
		const journal = executionOwnershipJournalSchema.parse(JSON.parse(raw));
		assertJournalScope(scope, journal);
		return journal;
	} catch {
		const backupPath = `${path}.corrupt-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
		let persistedBackupPath: string | null = null;
		try {
			// Preserve the corrupt source in place so every future ownership read
			// continues to fail closed until an operator deliberately repairs it.
			// The content-derived name plus exclusive copy bounds repeated reads of
			// the same corrupt payload to one backup artifact.
			await copyFile(path, backupPath, COPYFILE_EXCL);
			persistedBackupPath = backupPath;
		} catch (error) {
			if (isNodeError(error, "EEXIST")) persistedBackupPath = backupPath;
			// The typed corruption result remains fail-closed even if backup fails.
		}
		log.error("execution ownership journal is corrupt", {
			projectId: scope.projectId,
			backupCreated: persistedBackupPath !== null,
		});
		throw new ExecutionOwnershipJournalCorruptionError(scope.projectId, persistedBackupPath);
	}
}

function pruneJournal(journal: ExecutionOwnershipJournal): ExecutionOwnershipJournal {
	const activeHandoffs = journal.handoffs.filter((operation) => operation.status === "pending");
	const terminalHandoffs = journal.handoffs
		.filter((operation) => operation.status !== "pending")
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_TERMINAL_HANDOFFS);
	const activeInteractions = journal.interactions.filter((operation) => operation.status === "pending");
	const terminalInteractions = journal.interactions
		.filter((operation) => operation.status !== "pending")
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_TERMINAL_INTERACTIONS);
	return {
		version: 1,
		owners: journal.owners,
		handoffs: [...activeHandoffs, ...terminalHandoffs],
		interactions: [...activeInteractions, ...terminalInteractions],
	};
}

async function writeJournal(scope: ProjectBoardCommandScope, journal: ExecutionOwnershipJournal): Promise<void> {
	assertJournalScope(scope, journal);
	await lockedFileSystem.writeJsonFileAtomic(
		getProjectExecutionOwnershipPath(scope.projectId),
		pruneJournal(journal),
		{
			lock: null,
		},
	);
}

export interface BeginHandoffInput {
	operationId: string;
	taskId: string;
	targetOwner: "native_tui" | "structured";
	expectedOwnerGeneration: number;
}

export interface BeginInteractionInput {
	operationId: string;
	taskId: string;
	kind: TaskInteractionKind;
	ownerGeneration: number;
	payloadFingerprint: string;
}

export class ProjectExecutionOwnershipStore {
	async getOwnership(scope: ProjectBoardCommandScope, taskId: string): Promise<TaskExecutionOwnership | null> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			return (await readJournal(scope)).owners[taskId] ?? null;
		});
	}

	async listOwnership(scope: ProjectBoardCommandScope): Promise<TaskExecutionOwnership[]> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			return Object.values((await readJournal(scope)).owners);
		});
	}

	async putOwnership(
		scope: ProjectBoardCommandScope,
		ownershipInput: TaskExecutionOwnership,
	): Promise<TaskExecutionOwnership> {
		const ownership = taskExecutionOwnershipSchema.parse(ownershipInput);
		if (ownership.projectId !== scope.projectId) throw new Error("Execution ownership project scope mismatch.");
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			await writeJournal(scope, { ...journal, owners: { ...journal.owners, [ownership.taskId]: ownership } });
			return ownership;
		});
	}

	async putOwnershipIfCurrent(
		scope: ProjectBoardCommandScope,
		expectedCurrent: TaskExecutionOwnership | null,
		ownershipInput: TaskExecutionOwnership,
	): Promise<{ ownership: TaskExecutionOwnership | null; applied: boolean }> {
		const ownership = taskExecutionOwnershipSchema.parse(ownershipInput);
		if (ownership.projectId !== scope.projectId) throw new Error("Execution ownership project scope mismatch.");
		const expectedFingerprint = expectedCurrent ? fingerprintExecutionOperation(expectedCurrent) : null;
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const current = journal.owners[ownership.taskId] ?? null;
			const currentFingerprint = current ? fingerprintExecutionOperation(current) : null;
			if (currentFingerprint !== expectedFingerprint) {
				return { ownership: current, applied: false };
			}
			await writeJournal(scope, { ...journal, owners: { ...journal.owners, [ownership.taskId]: ownership } });
			return { ownership, applied: true };
		});
	}

	async updateOwnership(
		scope: ProjectBoardCommandScope,
		taskId: string,
		updater: (current: TaskExecutionOwnership) => TaskExecutionOwnership,
	): Promise<TaskExecutionOwnership> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const current = journal.owners[taskId];
			if (!current) throw new Error(`Execution ownership for task "${taskId}" was not found.`);
			const next = taskExecutionOwnershipSchema.parse({
				...updater(current),
				projectId: current.projectId,
				taskId: current.taskId,
				updatedAt: Date.now(),
			});
			await writeJournal(scope, { ...journal, owners: { ...journal.owners, [taskId]: next } });
			return next;
		});
	}

	async removeOwnership(scope: ProjectBoardCommandScope, taskId: string): Promise<void> {
		await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const owners = { ...journal.owners };
			delete owners[taskId];
			await writeJournal(scope, {
				...journal,
				owners,
				handoffs: journal.handoffs.filter((operation) => operation.taskId !== taskId),
				interactions: journal.interactions.filter((operation) => operation.taskId !== taskId),
			});
		});
	}

	async beginHandoff(
		scope: ProjectBoardCommandScope,
		input: BeginHandoffInput,
	): Promise<{ operation: PersistedExecutionHandoffOperation; replayed: boolean }> {
		const fingerprint = fingerprintExecutionOperation(input);
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const existing = journal.handoffs.find((candidate) => candidate.operationId === input.operationId);
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new ExecutionOperationIdentityConflictError(input.operationId);
				return { operation: existing, replayed: true };
			}
			const active = journal.handoffs.find(
				(candidate) => candidate.taskId === input.taskId && candidate.status === "pending",
			);
			if (active) throw new ExecutionOwnershipBusyError(active.operationId);
			const now = Date.now();
			const currentOwnership = journal.owners[input.taskId];
			if (!currentOwnership || currentOwnership.ownerGeneration !== input.expectedOwnerGeneration) {
				throw new ExecutionOwnershipGenerationConflictError(currentOwnership?.ownerGeneration ?? null);
			}
			const operation: PersistedExecutionHandoffOperation = {
				...input,
				projectId: scope.projectId,
				fingerprint,
				status: "pending",
				outcome: null,
				requestedAt: now,
				updatedAt: now,
			};
			const ownership = taskExecutionOwnershipSchema.parse({
				...currentOwnership,
				state: input.targetOwner === "structured" ? "handoff_to_structured_pending" : "handoff_to_native_pending",
				pendingHandoff: {
					operationId: input.operationId,
					targetOwner: input.targetOwner,
					expectedOwnerGeneration: input.expectedOwnerGeneration,
					phase: "recorded",
					startedAt: now,
				},
				updatedAt: now,
			});
			await writeJournal(scope, {
				...journal,
				owners: { ...journal.owners, [input.taskId]: ownership },
				handoffs: [...journal.handoffs, operation],
			});
			return { operation, replayed: false };
		});
	}

	async getHandoff(
		scope: ProjectBoardCommandScope,
		operationId: string,
	): Promise<PersistedExecutionHandoffOperation | null> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			return (await readJournal(scope)).handoffs.find((candidate) => candidate.operationId === operationId) ?? null;
		});
	}

	async recordAlreadyAppliedHandoff(
		scope: ProjectBoardCommandScope,
		input: BeginHandoffInput,
	): Promise<{ operation: PersistedExecutionHandoffOperation; replayed: boolean }> {
		const fingerprint = fingerprintExecutionOperation(input);
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const existing = journal.handoffs.find((candidate) => candidate.operationId === input.operationId);
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new ExecutionOperationIdentityConflictError(input.operationId);
				return { operation: existing, replayed: true };
			}
			const active = journal.handoffs.find(
				(candidate) => candidate.taskId === input.taskId && candidate.status === "pending",
			);
			if (active) throw new ExecutionOwnershipBusyError(active.operationId);
			const now = Date.now();
			const operation = handoffOperationSchema.parse({
				...input,
				projectId: scope.projectId,
				fingerprint,
				status: "completed",
				outcome: "already_applied",
				requestedAt: now,
				updatedAt: now,
			});
			await writeJournal(scope, { ...journal, handoffs: [...journal.handoffs, operation] });
			return { operation, replayed: false };
		});
	}

	async finishHandoff(
		scope: ProjectBoardCommandScope,
		operationId: string,
		outcome: ExecutionHandoffOutcome,
	): Promise<PersistedExecutionHandoffOperation> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const index = journal.handoffs.findIndex((candidate) => candidate.operationId === operationId);
			const current = journal.handoffs[index];
			if (!current) throw new Error(`Execution handoff "${operationId}" was not found.`);
			const next = handoffOperationSchema.parse({
				...current,
				status: outcome === "completed" || outcome === "already_applied" ? "completed" : "failed",
				outcome,
				updatedAt: Date.now(),
			});
			const handoffs = journal.handoffs.slice();
			handoffs[index] = next;
			await writeJournal(scope, { ...journal, handoffs });
			return next;
		});
	}

	async updateOwnershipAndFinishHandoff(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string,
		outcome: ExecutionHandoffOutcome,
		updater: (current: TaskExecutionOwnership) => TaskExecutionOwnership,
	): Promise<{
		ownership: TaskExecutionOwnership;
		operation: PersistedExecutionHandoffOperation;
	}> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const currentOwnership = journal.owners[taskId];
			if (!currentOwnership) throw new Error(`Execution ownership for task "${taskId}" was not found.`);
			const operationIndex = journal.handoffs.findIndex((candidate) => candidate.operationId === operationId);
			const currentOperation = journal.handoffs[operationIndex];
			if (!currentOperation) throw new Error(`Execution handoff "${operationId}" was not found.`);
			if (currentOperation.taskId !== taskId) {
				throw new ExecutionOperationIdentityConflictError(operationId);
			}
			const now = Date.now();
			const ownership = taskExecutionOwnershipSchema.parse({
				...updater(currentOwnership),
				projectId: currentOwnership.projectId,
				taskId: currentOwnership.taskId,
				updatedAt: now,
			});
			const operation = handoffOperationSchema.parse({
				...currentOperation,
				status: outcome === "completed" || outcome === "already_applied" ? "completed" : "failed",
				outcome,
				updatedAt: now,
			});
			const handoffs = journal.handoffs.slice();
			handoffs[operationIndex] = operation;
			await writeJournal(scope, {
				...journal,
				owners: { ...journal.owners, [taskId]: ownership },
				handoffs,
			});
			return { ownership, operation };
		});
	}

	async updateOwnershipAndFinishKnownHandoff(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string | null,
		outcome: ExecutionHandoffOutcome,
		updater: (current: TaskExecutionOwnership) => TaskExecutionOwnership,
	): Promise<{
		ownership: TaskExecutionOwnership;
		operation: PersistedExecutionHandoffOperation | null;
	}> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const currentOwnership = journal.owners[taskId];
			if (!currentOwnership) throw new Error(`Execution ownership for task "${taskId}" was not found.`);
			const operationIndex = operationId
				? journal.handoffs.findIndex((candidate) => candidate.operationId === operationId)
				: -1;
			const currentOperation = operationIndex >= 0 ? journal.handoffs[operationIndex] : null;
			if (currentOperation && currentOperation.taskId !== taskId) {
				throw new ExecutionOperationIdentityConflictError(currentOperation.operationId);
			}
			const now = Date.now();
			const ownership = taskExecutionOwnershipSchema.parse({
				...updater(currentOwnership),
				projectId: currentOwnership.projectId,
				taskId: currentOwnership.taskId,
				updatedAt: now,
			});
			const operation = currentOperation
				? handoffOperationSchema.parse({
						...currentOperation,
						status: outcome === "completed" || outcome === "already_applied" ? "completed" : "failed",
						outcome,
						updatedAt: now,
					})
				: null;
			const handoffs = journal.handoffs.slice();
			if (operation) handoffs[operationIndex] = operation;
			await writeJournal(scope, {
				...journal,
				owners: { ...journal.owners, [taskId]: ownership },
				handoffs,
			});
			return { ownership, operation };
		});
	}

	async beginInteraction(
		scope: ProjectBoardCommandScope,
		input: BeginInteractionInput,
	): Promise<{ operation: PersistedTaskInteractionOperation; replayed: boolean }> {
		const fingerprint = fingerprintExecutionOperation(input);
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const existing = journal.interactions.find((candidate) => candidate.operationId === input.operationId);
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new ExecutionOperationIdentityConflictError(input.operationId);
				return { operation: existing, replayed: true };
			}
			const active = journal.interactions.find(
				(candidate) =>
					candidate.taskId === input.taskId && candidate.status === "pending" && candidate.kind === input.kind,
			);
			if (active) throw new ExecutionOwnershipBusyError(active.operationId);
			const now = Date.now();
			const operation: PersistedTaskInteractionOperation = {
				operationId: input.operationId,
				projectId: scope.projectId,
				taskId: input.taskId,
				fingerprint,
				kind: input.kind,
				ownerGeneration: input.ownerGeneration,
				status: "pending",
				outcome: null,
				providerTurnId: null,
				requestedAt: now,
				updatedAt: now,
			};
			await writeJournal(scope, { ...journal, interactions: [...journal.interactions, operation] });
			return { operation, replayed: false };
		});
	}

	async finishInteraction(
		scope: ProjectBoardCommandScope,
		operationId: string,
		input: { outcome: TaskInteractionOutcome; providerTurnId?: string | null; outcomeUnknown?: boolean },
	): Promise<PersistedTaskInteractionOperation> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const index = journal.interactions.findIndex((candidate) => candidate.operationId === operationId);
			const current = journal.interactions[index];
			if (!current) throw new Error(`Task interaction "${operationId}" was not found.`);
			const next = interactionOperationSchema.parse({
				...current,
				status: input.outcomeUnknown ? "outcome_unknown" : input.outcome === "completed" ? "completed" : "failed",
				outcome: input.outcome,
				providerTurnId: input.providerTurnId ?? current.providerTurnId,
				updatedAt: Date.now(),
			});
			const interactions = journal.interactions.slice();
			interactions[index] = next;
			await writeJournal(scope, { ...journal, interactions });
			return next;
		});
	}

	async getInteraction(
		scope: ProjectBoardCommandScope,
		operationId: string,
	): Promise<PersistedTaskInteractionOperation | null> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			return (
				(await readJournal(scope)).interactions.find((candidate) => candidate.operationId === operationId) ?? null
			);
		});
	}
}
