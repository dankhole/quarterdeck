import { rm } from "node:fs/promises";

import type {
	RuntimeBoardData,
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "../core/api-contract";
import { runtimeWorkspaceStateSaveRequestSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	ensureWorkspaceEntry,
	findWorkspaceEntry,
	parseWorkspaceStateSavePayload,
	readWorkspaceBoard,
	readWorkspaceIndex,
	readWorkspaceMeta,
	readWorkspaceSessions,
	writeWorkspaceIndexSafe,
} from "./workspace-state-index";
import {
	detectGitRepositoryInfo,
	getWorkspaceBoardPath,
	getWorkspaceDirectoryLockRequest,
	getWorkspaceDirectoryPath,
	getWorkspaceIndexLockRequest,
	getWorkspaceMetaPath,
	getWorkspaceSessionsPath,
	getWorkspacesRootLockRequest,
	resolveWorkspacePath,
} from "./workspace-state-utils";

export type { RuntimeWorkspaceIndexEntry } from "./workspace-state-index";
export {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	removeWorkspaceIndexEntry,
	updateProjectOrder,
} from "./workspace-state-index";
// Re-export everything consumers need from sub-modules.
export {
	getRuntimeHomePath,
	getTaskWorktreesHomePath,
	getWorkspaceDirectoryPath,
	getWorkspacesRootPath,
	isUnderWorktreesHome,
} from "./workspace-state-utils";

export interface RuntimeWorkspaceContext {
	repoPath: string;
	workspaceId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function toWorkspaceStateResponse(
	context: RuntimeWorkspaceContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		board,
		sessions,
		revision,
	};
}

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Workspace state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function loadWorkspaceContext(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceContext> {
	const repoPath = await resolveWorkspacePath(cwd);
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	if (!autoCreateIfMissing) {
		const index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Quarterdeck yet.`);
		}
		return {
			repoPath,
			workspaceId: existingEntry.workspaceId,
			statePath: getWorkspaceDirectoryPath(existingEntry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
		};
	}

	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		let index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureWorkspaceEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeWorkspaceIndexSafe(index);
		}

		return {
			repoPath,
			workspaceId: ensured.entry.workspaceId,
			statePath: getWorkspaceDirectoryPath(ensured.entry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
		};
	});
}

export async function loadWorkspaceContextById(workspaceId: string): Promise<RuntimeWorkspaceContext | null> {
	const index = await readWorkspaceIndex();
	const entry = index.entries[workspaceId];
	if (!entry) {
		return null;
	}
	try {
		return await loadWorkspaceContext(entry.repoPath);
	} catch {
		return null;
	}
}

export async function removeWorkspaceStateFiles(workspaceId: string): Promise<void> {
	await lockedFileSystem.withLocks(
		[getWorkspacesRootLockRequest(), getWorkspaceDirectoryLockRequest(workspaceId)],
		async () => {
			await rm(getWorkspaceDirectoryPath(workspaceId), {
				recursive: true,
				force: true,
			});
		},
	);
}

export async function loadWorkspaceState(cwd: string): Promise<RuntimeWorkspaceStateResponse> {
	const context = await loadWorkspaceContext(cwd);
	const [board, sessions, meta] = await Promise.all([
		readWorkspaceBoard(context.workspaceId),
		readWorkspaceSessions(context.workspaceId),
		readWorkspaceMeta(context.workspaceId),
	]);
	return toWorkspaceStateResponse(context, board, sessions, meta.revision);
}

export async function saveWorkspaceState(
	cwd: string,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const parsedPayload = parseWorkspaceStateSavePayload(payload, runtimeWorkspaceStateSaveRequestSchema);
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const metaPath = getWorkspaceMetaPath(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new WorkspaceStateConflictError(expectedRevision, currentMeta.revision);
		}
		const board = parsedPayload.board;
		const sessions = parsedPayload.sessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(context.workspaceId), board, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(context.workspaceId), sessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, board, sessions, nextRevision);
	});
}
