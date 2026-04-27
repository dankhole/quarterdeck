import { rm } from "node:fs/promises";
import { z } from "zod";

import type {
	RuntimeBoardData,
	RuntimeGitRepositoryInfo,
	RuntimeProjectStateResponse,
	RuntimeProjectStateWarning,
	RuntimeTaskSessionSummary,
} from "../core";
import { runtimeBoardDataSchema, runtimeTaskSessionSummarySchema } from "../core";
import { lockedFileSystem } from "../fs";
import {
	ensureProjectEntry,
	findProjectEntry,
	parseProjectStateSavePayload,
	readProjectBoard,
	readProjectIndex,
	readProjectMeta,
	readProjectSessions,
	writeProjectIndexSafe,
} from "./project-state-index";
import {
	detectGitRepositoryInfo,
	getProjectBoardPath,
	getProjectDirectoryLockRequest,
	getProjectDirectoryPath,
	getProjectIndexLockRequest,
	getProjectMetaPath,
	getProjectSessionsPath,
	getProjectsRootLockRequest,
	resolveProjectPath,
} from "./project-state-utils";

export type { RuntimeProjectIndexEntry } from "./project-state-index";
export {
	listProjectIndexEntries,
	loadProjectBoardById,
	removeProjectIndexEntry,
	updateProjectOrder,
} from "./project-state-index";
// Re-export everything consumers need from sub-modules.
export {
	getProjectDirectoryPath,
	getProjectsRootPath,
	getRuntimeHomePath,
	getTaskWorktreesHomePath,
	isUnderWorktreesHome,
} from "./project-state-utils";

export interface RuntimeProjectContext {
	repoPath: string;
	projectId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
}

export interface LoadProjectContextOptions {
	autoCreateIfMissing?: boolean;
}

const persistedProjectStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});

interface PersistedProjectStateSaveRequest {
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	expectedRevision?: number;
}

function toProjectStateResponse(
	context: RuntimeProjectContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
	warnings?: RuntimeProjectStateWarning[],
): RuntimeProjectStateResponse {
	const response: RuntimeProjectStateResponse = {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		board,
		sessions,
		revision,
	};
	if (warnings && warnings.length > 0) {
		response.warnings = warnings;
	}
	return response;
}

export class ProjectStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Project state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		this.name = "ProjectStateConflictError";
		this.currentRevision = currentRevision;
	}
}

// Startup terminal-manager hydration can read and repair sessions.json before
// a browser client asks for the initial snapshot. Keep that warning alive until
// the next authoritative save so the UI still sees what was repaired.
const pendingSessionsWarningByProjectId = new Map<string, RuntimeProjectStateWarning>();

export async function loadProjectContext(
	cwd: string,
	options: LoadProjectContextOptions = {},
): Promise<RuntimeProjectContext> {
	const repoPath = await resolveProjectPath(cwd);
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	if (!autoCreateIfMissing) {
		const index = await readProjectIndex();
		const existingEntry = findProjectEntry(index, repoPath);
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Quarterdeck yet.`);
		}
		return {
			repoPath,
			projectId: existingEntry.projectId,
			statePath: getProjectDirectoryPath(existingEntry.projectId),
			git: detectGitRepositoryInfo(repoPath),
		};
	}

	return await lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => {
		let index = await readProjectIndex();
		const existingEntry = findProjectEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureProjectEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeProjectIndexSafe(index);
		}

		return {
			repoPath,
			projectId: ensured.entry.projectId,
			statePath: getProjectDirectoryPath(ensured.entry.projectId),
			git: detectGitRepositoryInfo(repoPath),
		};
	});
}

export async function loadProjectContextById(projectId: string): Promise<RuntimeProjectContext | null> {
	const index = await readProjectIndex();
	const entry = index.entries[projectId];
	if (!entry) {
		return null;
	}
	try {
		return await loadProjectContext(entry.repoPath);
	} catch {
		return null;
	}
}

export async function removeProjectStateFiles(projectId: string): Promise<void> {
	await lockedFileSystem.withLocks(
		[getProjectsRootLockRequest(), getProjectDirectoryLockRequest(projectId)],
		async () => {
			await rm(getProjectDirectoryPath(projectId), {
				recursive: true,
				force: true,
			});
		},
	);
}

export async function loadProjectState(cwd: string): Promise<RuntimeProjectStateResponse> {
	const context = await loadProjectContext(cwd);
	const [board, sessionsResult, meta] = await Promise.all([
		readProjectBoard(context.projectId),
		readProjectSessions(context.projectId),
		readProjectMeta(context.projectId),
	]);
	if (sessionsResult.droppedCount > 0) {
		pendingSessionsWarningByProjectId.set(context.projectId, {
			kind: "sessions_corruption",
			droppedCount: sessionsResult.droppedCount,
			backupPath: sessionsResult.backupPath,
		});
	}
	const pendingWarning = pendingSessionsWarningByProjectId.get(context.projectId);
	const warnings = pendingWarning ? [pendingWarning] : [];
	return toProjectStateResponse(context, board, sessionsResult.sessions, meta.revision, warnings);
}

export async function saveProjectState(
	cwd: string,
	payload: PersistedProjectStateSaveRequest,
): Promise<RuntimeProjectStateResponse> {
	const parsedPayload = parseProjectStateSavePayload(payload, persistedProjectStateSaveRequestSchema);
	const context = await loadProjectContext(cwd);
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(context.projectId), async () => {
		const metaPath = getProjectMetaPath(context.projectId);
		const currentMeta = await readProjectMeta(context.projectId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new ProjectStateConflictError(expectedRevision, currentMeta.revision);
		}
		const board = parsedPayload.board;
		const sessions = parsedPayload.sessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getProjectBoardPath(context.projectId), board, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getProjectSessionsPath(context.projectId), sessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		pendingSessionsWarningByProjectId.delete(context.projectId);

		return toProjectStateResponse(context, board, sessions, nextRevision);
	});
}
