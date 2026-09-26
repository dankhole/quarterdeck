import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { runtimeBoardDataSchema, runtimeTaskSessionSummarySchema } from "../core";
import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import {
	getProjectBoardPath,
	getProjectDirectoryLockRequest,
	getProjectDirectoryPath,
	getProjectMetaPath,
	getProjectSessionsPath,
} from "./project-state-utils";

export interface ProjectStateMeta {
	revision: number;
	updatedAt: number;
	recentBoardCommands: ProjectBoardCommandReceipt[];
}

export interface ProjectBoardCommandReceipt {
	commandId: string;
	fingerprint: string;
	revision: number;
	appliedAt: number;
	acceptedChange: boolean;
}

export const MAX_RECENT_BOARD_COMMAND_RECEIPTS = 256;

const projectBoardCommandReceiptSchema = z.object({
	commandId: z.string().min(1).max(128),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	revision: z.number().int().nonnegative(),
	appliedAt: z.number().finite().nonnegative(),
	acceptedChange: z.boolean(),
});

export const projectStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
	recentBoardCommands: z
		.array(projectBoardCommandReceiptSchema)
		.max(MAX_RECENT_BOARD_COMMAND_RECEIPTS)
		.optional()
		.default([]),
});

const projectStateTransactionSchema = z.object({
	version: z.literal(1),
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	meta: projectStateMetaSchema,
});

type ProjectStateTransaction = z.infer<typeof projectStateTransactionSchema>;

export function getProjectStateTransactionPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), "state-transaction.json");
}

async function syncFile(path: string): Promise<void> {
	// Windows FlushFileBuffers requires a writable file handle.
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncProjectDirectory(projectId: string): Promise<void> {
	// Node cannot open directories for fsync on Windows. File contents are still
	// flushed there; rename durability follows the platform filesystem contract.
	if (process.platform === "win32") return;
	const handle = await open(getProjectDirectoryPath(projectId), "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Caller must hold the project directory lock throughout installation. */
async function installProjectStateTransaction(projectId: string, transaction: ProjectStateTransaction): Promise<void> {
	// Flush the journal before replacing any destination, including on recovery
	// of a writer that died immediately after the journal rename.
	await syncFile(getProjectStateTransactionPath(projectId));
	await syncProjectDirectory(projectId);
	for (const [path, payload] of [
		[getProjectBoardPath(projectId), transaction.board],
		[getProjectSessionsPath(projectId), transaction.sessions],
		[getProjectMetaPath(projectId), transaction.meta],
	] as const) {
		await lockedFileSystem.writeJsonFileAtomic(path, payload, { lock: null });
		await syncFile(path);
	}
	// Destination renames must reach disk before the recovery record is removed.
	await syncProjectDirectory(projectId);
	await unlink(getProjectStateTransactionPath(projectId));
	await syncProjectDirectory(projectId);
}

/**
 * The atomic journal rename commits the complete next state. A failed install
 * leaves the journal intact; every subsequent reader/writer finishes it first.
 * Caller must hold the project directory lock and recover before deriving state.
 */
export async function writeProjectStateTransaction(
	projectId: string,
	state: Omit<ProjectStateTransaction, "version">,
): Promise<void> {
	const transaction = projectStateTransactionSchema.parse({ version: 1, ...state });
	await lockedFileSystem.writeJsonFileAtomic(getProjectStateTransactionPath(projectId), transaction, { lock: null });
	await installProjectStateTransaction(projectId, transaction);
}

/** Requires the project directory lock. Invalid journals fail closed. */
export async function recoverProjectStateTransaction(projectId: string): Promise<void> {
	const transactionPath = getProjectStateTransactionPath(projectId);
	let raw: string;
	try {
		raw = await readFile(transactionPath, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return;
		throw error;
	}
	const transaction = projectStateTransactionSchema.parse(JSON.parse(raw));
	await installProjectStateTransaction(projectId, transaction);
}

/** Serializes reads, repairs, and writes across processes, recovering first. */
export async function withProjectStateLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(projectId), async () => {
		await recoverProjectStateTransaction(projectId);
		return await operation();
	});
}
