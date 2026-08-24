import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { z } from "zod";

import {
	createTaggedLogger,
	type RuntimeTaskLifecycleCommand,
	type RuntimeTaskLifecycleOperation,
	runtimeTaskLifecycleCommandSchema,
	runtimeTaskLifecycleOperationSchema,
} from "../core";
import { isNodeError, lockedFileSystem } from "../fs";
import type { ProjectBoardCommandScope } from "./project-board-command-service";
import { getProjectDirectoryLockRequest, getProjectLifecycleOperationsPath } from "./project-state-utils";

const MAX_TERMINAL_OPERATIONS = 200;
const log = createTaggedLogger("task-lifecycle-journal");

const persistedOperationSchema = runtimeTaskLifecycleOperationSchema.extend({
	fingerprint: z.string(),
	command: runtimeTaskLifecycleCommandSchema,
	attempt: z.number().int().positive(),
	plannedLinkedTaskIds: z.array(z.string()).default([]),
	warning: z.string().nullable(),
	error: z.string().nullable(),
});
export type PersistedTaskLifecycleOperation = z.infer<typeof persistedOperationSchema>;

const operationJournalSchema = z.object({
	version: z.literal(1),
	operations: z.array(persistedOperationSchema),
});
type OperationJournal = z.infer<typeof operationJournalSchema>;

const EMPTY_JOURNAL: OperationJournal = { version: 1, operations: [] };

export class ProjectTaskLifecycleIdentityConflictError extends Error {
	constructor(readonly operationId: string) {
		super(`Task lifecycle operation "${operationId}" was already used with different content.`);
		this.name = "ProjectTaskLifecycleIdentityConflictError";
	}
}

export class ProjectTaskLifecycleBusyError extends Error {
	constructor(
		readonly operationId: string,
		readonly activeOperationId: string,
	) {
		super(`Task already has an active lifecycle operation "${activeOperationId}".`);
		this.name = "ProjectTaskLifecycleBusyError";
	}
}

export class ProjectTaskLifecycleJournalCorruptionError extends Error {
	constructor(
		readonly projectId: string,
		readonly backupPath: string | null,
	) {
		super(`Task lifecycle journal for project "${projectId}" is invalid.`);
		this.name = "ProjectTaskLifecycleJournalCorruptionError";
	}
}

function isTerminal(operation: RuntimeTaskLifecycleOperation): boolean {
	return operation.status !== "pending";
}

function getTaskIdentity(command: RuntimeTaskLifecycleCommand): { taskId: string; taskCreatedAt: number } {
	return command.kind === "create_and_start"
		? { taskId: command.task.taskId, taskCreatedAt: command.task.createdAt }
		: { taskId: command.taskId, taskCreatedAt: command.taskCreatedAt };
}

function getColumns(command: RuntimeTaskLifecycleCommand): {
	sourceColumnId: RuntimeTaskLifecycleOperation["sourceColumnId"];
	targetColumnId: RuntimeTaskLifecycleOperation["targetColumnId"];
} {
	switch (command.kind) {
		case "create_and_start":
		case "start":
			return { sourceColumnId: "backlog", targetColumnId: "in_progress" };
		case "trash":
			return { sourceColumnId: command.sourceColumnId, targetColumnId: "trash" };
		case "restore":
			return { sourceColumnId: "trash", targetColumnId: "review" };
		default:
			return { sourceColumnId: null, targetColumnId: null };
	}
}

export function fingerprintTaskLifecycleCommand(command: RuntimeTaskLifecycleCommand): string {
	const semanticCommand = { ...command, cols: undefined, rows: undefined };
	return createHash("sha256").update(JSON.stringify(semanticCommand)).digest("hex");
}

async function readJournal(scope: ProjectBoardCommandScope): Promise<OperationJournal> {
	const path = getProjectLifecycleOperationsPath(scope.projectId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return EMPTY_JOURNAL;
		}
		throw error;
	}
	try {
		return operationJournalSchema.parse(JSON.parse(raw));
	} catch (error) {
		const backupPath = `${path}.corrupt-${Date.now()}`;
		let persistedBackupPath: string | null = null;
		try {
			await rename(path, backupPath);
			persistedBackupPath = backupPath;
		} catch (backupError) {
			log.error("failed to back up corrupt lifecycle journal", {
				projectId: scope.projectId,
				error: backupError instanceof Error ? backupError.message : String(backupError),
			});
		}
		log.error("task lifecycle journal is corrupt", {
			projectId: scope.projectId,
			backupPath: persistedBackupPath,
			error: error instanceof Error ? error.message : String(error),
		});
		throw new ProjectTaskLifecycleJournalCorruptionError(scope.projectId, persistedBackupPath);
	}
}

function pruneJournal(journal: OperationJournal): OperationJournal {
	const active = journal.operations.filter((operation) => !isTerminal(operation));
	const terminal = journal.operations
		.filter(isTerminal)
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_TERMINAL_OPERATIONS);
	return { version: 1, operations: [...active, ...terminal] };
}

async function writeJournal(scope: ProjectBoardCommandScope, journal: OperationJournal): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(
		getProjectLifecycleOperationsPath(scope.projectId),
		pruneJournal(journal),
		{
			lock: null,
		},
	);
}

export class ProjectTaskLifecycleOperationStore {
	async begin(
		scope: ProjectBoardCommandScope,
		commandInput: RuntimeTaskLifecycleCommand,
	): Promise<{ operation: PersistedTaskLifecycleOperation; replayed: boolean }> {
		const command = runtimeTaskLifecycleCommandSchema.parse(commandInput);
		const fingerprint = fingerprintTaskLifecycleCommand(command);
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const existing = journal.operations.find((candidate) => candidate.operationId === command.operationId);
			if (existing) {
				if (existing.fingerprint !== fingerprint) {
					throw new ProjectTaskLifecycleIdentityConflictError(command.operationId);
				}
				return { operation: existing, replayed: true };
			}

			const identity = getTaskIdentity(command);
			const active = journal.operations.find(
				(candidate) =>
					candidate.status === "pending" &&
					candidate.taskId === identity.taskId &&
					candidate.taskCreatedAt === identity.taskCreatedAt,
			);
			if (active) {
				throw new ProjectTaskLifecycleBusyError(command.operationId, active.operationId);
			}

			const now = Date.now();
			const columns = getColumns(command);
			const operation: PersistedTaskLifecycleOperation = {
				operationId: command.operationId,
				fingerprint,
				command,
				attempt: 1,
				projectId: scope.projectId,
				taskId: identity.taskId,
				taskCreatedAt: identity.taskCreatedAt,
				kind: command.kind,
				status: "pending",
				phase: "requested",
				...columns,
				acceptedBoardRevision: null,
				launchOperationId:
					command.kind === "start" || command.kind === "restore" || command.kind === "restart"
						? command.operationId
						: command.kind === "create_and_start"
							? command.operationId
							: null,
				childOperationIds: [],
				plannedLinkedTaskIds: [],
				outcomeCode: null,
				requestedAt: now,
				updatedAt: now,
				completedAt: null,
				warning: null,
				error: null,
			};
			await writeJournal(scope, {
				version: 1,
				operations: [...journal.operations, operation],
			});
			return { operation, replayed: false };
		});
	}

	async update(
		scope: ProjectBoardCommandScope,
		operationId: string,
		updater: (operation: PersistedTaskLifecycleOperation) => PersistedTaskLifecycleOperation,
	): Promise<PersistedTaskLifecycleOperation> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			const index = journal.operations.findIndex((candidate) => candidate.operationId === operationId);
			const current = journal.operations[index];
			if (index < 0 || !current) {
				throw new Error(`Task lifecycle operation "${operationId}" was not found.`);
			}
			const next = persistedOperationSchema.parse({
				...updater(current),
				operationId: current.operationId,
				fingerprint: current.fingerprint,
				command: current.command,
				projectId: current.projectId,
				taskId: current.taskId,
				taskCreatedAt: current.taskCreatedAt,
				kind: current.kind,
				updatedAt: Date.now(),
			});
			const operations = journal.operations.slice();
			operations[index] = next;
			await writeJournal(scope, { version: 1, operations });
			return next;
		});
	}

	async get(scope: ProjectBoardCommandScope, operationId: string): Promise<PersistedTaskLifecycleOperation | null> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			return journal.operations.find((candidate) => candidate.operationId === operationId) ?? null;
		});
	}

	async listActive(scope: ProjectBoardCommandScope): Promise<PersistedTaskLifecycleOperation[]> {
		return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			const journal = await readJournal(scope);
			return journal.operations.filter((operation) => operation.status === "pending");
		});
	}
}
