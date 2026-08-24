import { randomBytes } from "node:crypto";
import { copyFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import type {
	RuntimeBoardData,
	RuntimeGitRepositoryInfo,
	RuntimeProjectStateResponse,
	RuntimeProjectStateWarning,
	RuntimeTaskSessionSummary,
} from "../core";
import {
	createTaggedLogger,
	pruneOrphanSessionsForPersist,
	runtimeBoardDataSchema,
	runtimeTaskSessionSummarySchema,
} from "../core";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	ensureProjectEntry,
	findProjectEntry,
	MAX_RECENT_BOARD_COMMAND_RECEIPTS,
	type ProjectBoardCommandReceipt,
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
	SESSIONS_FILENAME,
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

export interface RuntimeProjectScopeContext {
	repoPath: string;
	projectId: string;
	statePath: string;
}

export interface LoadProjectContextOptions {
	autoCreateIfMissing?: boolean;
}

const persistedProjectStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});

const persistedProjectSessionsSaveRequestSchema = z.object({
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
});

interface PersistedProjectStateSaveRequest {
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	expectedRevision?: number;
}

export interface ApplyProjectBoardMutationInput {
	expectedRevision?: number;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	mutate: (board: RuntimeBoardData) => { board: RuntimeBoardData; changed: boolean };
	persistSessionsOnNoop?: boolean;
	commandIdentity?: {
		commandId: string;
		fingerprint: string;
	};
}

export interface ApplyProjectBoardMutationResult {
	state: RuntimeProjectStateResponse;
	changed: boolean;
	acceptedChange: boolean;
	replayed: boolean;
}

export interface SaveProjectSessionsOptions {
	clearPendingWarnings?: boolean;
}

export interface ProjectSessionsPruneResult {
	projectId: string;
	beforeCount: number;
	afterCount: number;
	prunedCount: number;
	prunedTaskIds: string[];
	backupPath: string | null;
}

const projectStateLog = createTaggedLogger("project-state");

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

export class ProjectBoardCommandIdentityConflictError extends Error {
	readonly commandId: string;

	constructor(commandId: string) {
		super(`Project board command "${commandId}" was already used with different content.`);
		this.name = "ProjectBoardCommandIdentityConflictError";
		this.commandId = commandId;
	}
}

function assertExpectedRevision(expectedRevision: number | undefined, currentRevision: number): void {
	if (
		typeof expectedRevision === "number" &&
		Number.isInteger(expectedRevision) &&
		expectedRevision >= 0 &&
		expectedRevision !== currentRevision
	) {
		throw new ProjectStateConflictError(expectedRevision, currentRevision);
	}
}

async function writeProjectStateFiles(
	projectId: string,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	currentRevision: number,
	recentBoardCommands: ProjectBoardCommandReceipt[],
): Promise<number> {
	const nextRevision = currentRevision + 1;
	const nextMeta = {
		revision: nextRevision,
		updatedAt: Date.now(),
		recentBoardCommands,
	};

	await lockedFileSystem.writeJsonFileAtomic(getProjectBoardPath(projectId), board, {
		lock: null,
	});
	await lockedFileSystem.writeJsonFileAtomic(getProjectSessionsPath(projectId), sessions, {
		lock: null,
	});
	await lockedFileSystem.writeJsonFileAtomic(getProjectMetaPath(projectId), nextMeta, {
		lock: null,
	});

	pendingSessionsWarningByProjectId.delete(projectId);
	return nextRevision;
}

function appendBoardCommandReceipt(
	receipts: ProjectBoardCommandReceipt[],
	receipt: ProjectBoardCommandReceipt,
): ProjectBoardCommandReceipt[] {
	return [...receipts, receipt].slice(-MAX_RECENT_BOARD_COMMAND_RECEIPTS);
}

// Startup terminal-manager hydration can read and repair sessions.json before
// a browser client asks for the initial snapshot. Keep that warning alive until
// the next authoritative save so the UI still sees what was repaired.
const pendingSessionsWarningByProjectId = new Map<string, RuntimeProjectStateWarning>();

async function canonicalizeProjectInputPath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	try {
		return await realpath(resolvedCwd);
	} catch {
		return resolvedCwd;
	}
}

function toProjectScopeContext(input: { projectId: string; repoPath: string }): RuntimeProjectScopeContext {
	return {
		repoPath: input.repoPath,
		projectId: input.projectId,
		statePath: getProjectDirectoryPath(input.projectId),
	};
}

async function loadProjectScopeByRepoPath(repoPath: string): Promise<RuntimeProjectScopeContext | null> {
	const index = await readProjectIndex();
	const existingEntry = findProjectEntry(index, repoPath);
	return existingEntry ? toProjectScopeContext(existingEntry) : null;
}

// Keep scope lookup cheap: request routing, hooks, and project management only
// need identity/path data. Add git metadata through RuntimeProjectContext instead
// so those hot paths do not accidentally reintroduce blocking repository probes.
async function loadFullProjectContext(scope: RuntimeProjectScopeContext): Promise<RuntimeProjectContext> {
	return {
		...scope,
		git: await detectGitRepositoryInfo(scope.repoPath),
	};
}

export async function loadProjectContext(
	cwd: string,
	options: LoadProjectContextOptions = {},
): Promise<RuntimeProjectContext> {
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	const canonicalCwd = await canonicalizeProjectInputPath(cwd);
	const exactIndexedScope = await loadProjectScopeByRepoPath(canonicalCwd);
	if (exactIndexedScope) {
		return await loadFullProjectContext(exactIndexedScope);
	}

	const repoPath = await resolveProjectPath(canonicalCwd);
	if (!autoCreateIfMissing) {
		const existingScope = await loadProjectScopeByRepoPath(repoPath);
		if (!existingScope) {
			throw new Error(`Project ${repoPath} is not added to Quarterdeck yet.`);
		}
		return await loadFullProjectContext(existingScope);
	}

	const scope = await lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => {
		let index = await readProjectIndex();
		const existingEntry = findProjectEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureProjectEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeProjectIndexSafe(index);
		}

		return toProjectScopeContext(ensured.entry);
	});
	return await loadFullProjectContext(scope);
}

export async function loadProjectScopeById(projectId: string): Promise<RuntimeProjectScopeContext | null> {
	const index = await readProjectIndex();
	const entry = index.entries[projectId];
	if (!entry) {
		return null;
	}
	return toProjectScopeContext(entry);
}

export async function loadProjectContextById(projectId: string): Promise<RuntimeProjectContext | null> {
	const scope = await loadProjectScopeById(projectId);
	if (!scope) {
		return null;
	}
	try {
		return await loadFullProjectContext(scope);
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

/** Reads the count-bearing board and its revision under the same project lock. */
export async function loadProjectBoardSnapshotById(
	projectId: string,
): Promise<{ board: RuntimeBoardData; revision: number }> {
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(projectId), async () => {
		const [board, meta] = await Promise.all([readProjectBoard(projectId), readProjectMeta(projectId)]);
		return { board, revision: meta.revision };
	});
}

export async function saveProjectState(
	cwd: string,
	payload: PersistedProjectStateSaveRequest,
): Promise<RuntimeProjectStateResponse> {
	const parsedPayload = parseProjectStateSavePayload(payload, persistedProjectStateSaveRequestSchema);
	const context = await loadProjectContext(cwd);
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(context.projectId), async () => {
		const currentMeta = await readProjectMeta(context.projectId);
		assertExpectedRevision(parsedPayload.expectedRevision, currentMeta.revision);
		const board = parsedPayload.board;
		const sessions = parsedPayload.sessions;
		const nextRevision = await writeProjectStateFiles(
			context.projectId,
			board,
			sessions,
			currentMeta.revision,
			currentMeta.recentBoardCommands,
		);

		return toProjectStateResponse(context, board, sessions, nextRevision);
	});
}

/**
 * Applies a pure board mutation while holding the project state lock.
 *
 * This is the persistence seam for runtime-owned board commands. It is not a
 * public/browser API: callers must supply authoritative runtime sessions and a
 * deterministic synchronous reducer.
 */
export async function applyProjectBoardMutation(
	cwd: string,
	input: ApplyProjectBoardMutationInput,
): Promise<ApplyProjectBoardMutationResult> {
	const parsedSessions = parseProjectStateSavePayload(
		{ sessions: input.sessions },
		persistedProjectSessionsSaveRequestSchema,
	).sessions;
	const context = await loadProjectContext(cwd);
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(context.projectId), async () => {
		const currentMeta = await readProjectMeta(context.projectId);
		const commandIdentity = input.commandIdentity;
		if (commandIdentity) {
			const receipt = currentMeta.recentBoardCommands.find(
				(candidate) => candidate.commandId === commandIdentity.commandId,
			);
			if (receipt) {
				if (receipt.fingerprint !== commandIdentity.fingerprint) {
					throw new ProjectBoardCommandIdentityConflictError(commandIdentity.commandId);
				}
				const currentBoard = await readProjectBoard(context.projectId);
				const pendingWarning = pendingSessionsWarningByProjectId.get(context.projectId);
				return {
					state: toProjectStateResponse(
						context,
						currentBoard,
						pruneOrphanSessionsForPersist(parsedSessions, currentBoard),
						currentMeta.revision,
						pendingWarning ? [pendingWarning] : undefined,
					),
					changed: false,
					acceptedChange: receipt.acceptedChange,
					replayed: true,
				};
			}
		}
		assertExpectedRevision(input.expectedRevision, currentMeta.revision);

		const currentBoard = await readProjectBoard(context.projectId);
		const mutation = input.mutate(currentBoard);
		if (!mutation.changed) {
			if (commandIdentity) {
				const nextRevision = currentMeta.revision + 1;
				const parsedMutation = parseProjectStateSavePayload(
					{
						board: currentBoard,
						sessions: pruneOrphanSessionsForPersist(parsedSessions, currentBoard),
					},
					persistedProjectStateSaveRequestSchema,
				);
				const recentBoardCommands = appendBoardCommandReceipt(currentMeta.recentBoardCommands, {
					commandId: commandIdentity.commandId,
					fingerprint: commandIdentity.fingerprint,
					revision: nextRevision,
					appliedAt: Date.now(),
					acceptedChange: false,
				});
				const persistedRevision = await writeProjectStateFiles(
					context.projectId,
					parsedMutation.board,
					parsedMutation.sessions,
					currentMeta.revision,
					recentBoardCommands,
				);
				return {
					state: toProjectStateResponse(context, parsedMutation.board, parsedMutation.sessions, persistedRevision),
					changed: false,
					acceptedChange: false,
					replayed: false,
				};
			}
			const prunedSessions = pruneOrphanSessionsForPersist(parsedSessions, currentBoard);
			let persistedSessions: Record<string, RuntimeTaskSessionSummary>;
			if (input.persistSessionsOnNoop) {
				await lockedFileSystem.writeJsonFileAtomic(getProjectSessionsPath(context.projectId), prunedSessions, {
					lock: null,
				});
				persistedSessions = prunedSessions;
			} else {
				persistedSessions = (await readProjectSessions(context.projectId)).sessions;
			}
			const pendingWarning = pendingSessionsWarningByProjectId.get(context.projectId);
			return {
				state: toProjectStateResponse(
					context,
					currentBoard,
					persistedSessions,
					currentMeta.revision,
					pendingWarning ? [pendingWarning] : undefined,
				),
				changed: false,
				acceptedChange: false,
				replayed: false,
			};
		}

		const parsedMutation = parseProjectStateSavePayload(
			{
				board: mutation.board,
				sessions: pruneOrphanSessionsForPersist(parsedSessions, mutation.board),
			},
			persistedProjectStateSaveRequestSchema,
		);
		const anticipatedRevision = currentMeta.revision + 1;
		const recentBoardCommands = commandIdentity
			? appendBoardCommandReceipt(currentMeta.recentBoardCommands, {
					commandId: commandIdentity.commandId,
					fingerprint: commandIdentity.fingerprint,
					revision: anticipatedRevision,
					appliedAt: Date.now(),
					acceptedChange: true,
				})
			: currentMeta.recentBoardCommands;
		const nextRevision = await writeProjectStateFiles(
			context.projectId,
			parsedMutation.board,
			parsedMutation.sessions,
			currentMeta.revision,
			recentBoardCommands,
		);
		return {
			state: toProjectStateResponse(context, parsedMutation.board, parsedMutation.sessions, nextRevision),
			changed: true,
			acceptedChange: true,
			replayed: false,
		};
	});
}

export async function saveProjectSessions(
	cwd: string,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	options: SaveProjectSessionsOptions = {},
): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const clearPendingWarnings = options.clearPendingWarnings ?? true;
	const parsedPayload = parseProjectStateSavePayload({ sessions }, persistedProjectSessionsSaveRequestSchema);
	const context = await loadProjectContext(cwd);
	return await lockedFileSystem.withLock(getProjectDirectoryLockRequest(context.projectId), async () => {
		await lockedFileSystem.writeJsonFileAtomic(getProjectSessionsPath(context.projectId), parsedPayload.sessions, {
			lock: null,
		});

		if (clearPendingWarnings) {
			pendingSessionsWarningByProjectId.delete(context.projectId);
		}

		return parsedPayload.sessions;
	});
}

async function backUpSessionsBeforePrune(statePath: string): Promise<string | null> {
	const sessionsPath = join(statePath, SESSIONS_FILENAME);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${sessionsPath}.pruned-${timestamp}-${randomBytes(3).toString("hex")}`;
	try {
		await copyFile(sessionsPath, backupPath);
		return backupPath;
	} catch (error) {
		projectStateLog.warn("failed to back up sessions.json before orphan prune", {
			sessionsPath,
			backupPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export async function pruneProjectSessionsForBoard(cwd: string): Promise<ProjectSessionsPruneResult> {
	const context = await loadProjectContext(cwd);
	const projectState = await loadProjectState(cwd);
	const prunedSessions = pruneOrphanSessionsForPersist(projectState.sessions, projectState.board);
	const prunedTaskIds = Object.keys(projectState.sessions).filter((taskId) => !(taskId in prunedSessions));
	const beforeCount = Object.keys(projectState.sessions).length;
	const afterCount = Object.keys(prunedSessions).length;

	if (prunedTaskIds.length === 0) {
		return {
			projectId: context.projectId,
			beforeCount,
			afterCount,
			prunedCount: 0,
			prunedTaskIds: [],
			backupPath: null,
		};
	}

	const backupPath = await backUpSessionsBeforePrune(projectState.statePath);
	await saveProjectSessions(cwd, prunedSessions, { clearPendingWarnings: false });
	projectStateLog.warn("pruned orphan session summaries from sessions.json", {
		projectId: context.projectId,
		statePath: projectState.statePath,
		beforeCount,
		afterCount,
		prunedCount: prunedTaskIds.length,
		backupPath,
	});

	return {
		projectId: context.projectId,
		beforeCount,
		afterCount,
		prunedCount: prunedTaskIds.length,
		prunedTaskIds,
		backupPath,
	};
}
