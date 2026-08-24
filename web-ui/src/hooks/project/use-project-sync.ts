import { isLifecycleManagedBoardCommand, normalizeDiagnosticErrorClass } from "@runtime-contract";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { recordBrowserEvent } from "@/diagnostics";
import { restoreProjectBoard, stashProjectBoard, updateProjectBoardCache } from "@/runtime/project-board-cache";
import { applyProjectBoardCommands, fetchProjectState, ProjectStateConflictError } from "@/runtime/project-state-query";
import type {
	RuntimeGitRepositoryInfo,
	RuntimeProjectBoardCommand,
	RuntimeProjectStateResponse,
} from "@/runtime/types";
import { setProjectPath as setStoreProjectPath } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";
import { applyPendingProjectBoardCommands, deriveProjectBoardCommands } from "./project-board-command-sync";
import {
	applyAuthoritativeProjectState,
	type CachedProjectBoardRestore,
	type ProjectBoardSessionsState,
	type ProjectVersion,
} from "./project-sync";

export interface FlushProjectBoardCommandsResult {
	ok: boolean;
	message?: string;
}

interface PendingProjectBoardCommandBatch {
	commandId: string;
	commands: RuntimeProjectBoardCommand[];
}

interface ProjectBoardCommandQueue {
	revision: number;
	pending: PendingProjectBoardCommandBatch[];
	running: boolean;
	waiters: Array<(result: FlushProjectBoardCommandsResult) => void>;
}

async function sendProjectBoardCommandBatch(
	projectId: string,
	revision: number,
	batch: PendingProjectBoardCommandBatch,
) {
	try {
		return await applyProjectBoardCommands(projectId, {
			commandId: batch.commandId,
			expectedRevision: revision,
			commands: batch.commands,
		});
	} catch (error) {
		if (error instanceof ProjectStateConflictError) {
			throw error;
		}
		// A lost response is ambiguous: the runtime may already have committed
		// the command. Retry the identical ID and revision once so the durable
		// receipt can turn that case into a safe replay. A genuinely competing
		// write still returns a revision conflict.
		return await applyProjectBoardCommands(projectId, {
			commandId: batch.commandId,
			expectedRevision: revision,
			commands: batch.commands,
		});
	}
}

function createBrowserCommandId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `browser:${crypto.randomUUID()}`;
	}
	return `browser:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function cacheAuthoritativeProjectState(projectId: string, state: RuntimeProjectStateResponse): void {
	updateProjectBoardCache(projectId, {
		board: state.board,
		sessions: state.sessions,
		authoritativeRevision: state.revision,
		projectPath: state.repoPath,
		projectGit: state.git,
	});
}

interface UseProjectSyncInput {
	currentProjectId: string | null;
	streamedProjectState: RuntimeProjectStateResponse | null;
	hasNoProjects: boolean;
	hasReceivedSnapshot: boolean;
	isDocumentVisible: boolean;
	projectBoardSessionsRef: MutableRefObject<ProjectBoardSessionsState>;
	setProjectBoardSessions: Dispatch<SetStateAction<ProjectBoardSessionsState>>;
}

interface UseProjectSyncResult {
	boardProjectId: string | null;
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	isProjectMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	refreshProjectState: () => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	flushBoardCommands: () => Promise<FlushProjectBoardCommandsResult>;
	getAuthoritativeRevision: () => number | null;
	applyLifecycleProjectState: (state: RuntimeProjectStateResponse) => void;
}

export function useProjectSync({
	currentProjectId,
	streamedProjectState,
	hasNoProjects,
	hasReceivedSnapshot,
	isDocumentVisible,
	projectBoardSessionsRef,
	setProjectBoardSessions,
}: UseProjectSyncInput): UseProjectSyncResult {
	const [boardProjectId, setBoardProjectId] = useState<string | null>(null);
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const [projectGit, setProjectGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedProjectId, setAppliedProjectId] = useState<string | null>(null);
	const [, setIsProjectStateRefreshing] = useState(false);
	const [isServedFromBoardCache, setIsServedFromBoardCache] = useState(false);
	const authoritativeProjectVersionRef = useRef<ProjectVersion>({
		projectId: null,
		revision: null,
	});
	const cachedBoardRestoreRef = useRef<CachedProjectBoardRestore | null>(null);
	const syncTargetProjectIdRef = useRef<string | null>(currentProjectId);
	const projectRefreshRequestIdRef = useRef(0);
	const projectRefreshSuccessCountRef = useRef(0);
	const warnedProjectIdsRef = useRef<Set<string>>(new Set());
	const commandQueuesRef = useRef(new Map<string, ProjectBoardCommandQueue>());
	const lastAuthoritativeProjectStateRef = useRef<{
		projectId: string;
		state: RuntimeProjectStateResponse;
	} | null>(null);
	const applyProjectStateRef = useRef<(state: RuntimeProjectStateResponse) => void>(() => {});
	const refreshProjectStateRef = useRef<() => Promise<void>>(async () => {});

	const isProjectMetadataPending = currentProjectId !== null && appliedProjectId !== currentProjectId;

	const pumpProjectBoardCommandQueue = useCallback((projectId: string) => {
		const queue = commandQueuesRef.current.get(projectId);
		if (!queue || queue.running) {
			return;
		}
		queue.running = true;
		void (async () => {
			let failure: FlushProjectBoardCommandsResult | null = null;
			while (queue.pending.length > 0) {
				const batch = queue.pending[0];
				if (!batch) {
					break;
				}
				try {
					const result = await sendProjectBoardCommandBatch(projectId, queue.revision, batch);
					queue.pending.shift();
					queue.revision = result.state.revision;
					// A command can finish after the user switches projects. Keep the
					// inactive project's cache authoritative too; otherwise a later
					// switch could revive the pre-command board until the stream catches up.
					cacheAuthoritativeProjectState(projectId, result.state);
					if (syncTargetProjectIdRef.current === projectId) {
						const currentRevision = authoritativeProjectVersionRef.current.revision;
						if (currentRevision === null || currentRevision <= result.state.revision) {
							authoritativeProjectVersionRef.current = { projectId, revision: null };
						}
						applyProjectStateRef.current(result.state);
					}
				} catch (error) {
					const message = toErrorMessage(error);
					queue.pending.splice(0);
					failure = { ok: false, message };
					if (syncTargetProjectIdRef.current === projectId) {
						authoritativeProjectVersionRef.current = { projectId, revision: null };
						const lastAuthoritative = lastAuthoritativeProjectStateRef.current;
						if (lastAuthoritative?.projectId === projectId) {
							applyProjectStateRef.current(lastAuthoritative.state);
						}
						showAppToast(
							{
								intent: "warning",
								icon: "warning-sign",
								message:
									error instanceof ProjectStateConflictError
										? "Project changed elsewhere. Synced the latest board; retry the last edit if needed."
										: `Could not save the board change: ${message}`,
								timeout: 6000,
							},
							"project-board-command-failed",
						);
						const successCountBeforeRefresh = projectRefreshSuccessCountRef.current;
						await refreshProjectStateRef.current();
						if (projectRefreshSuccessCountRef.current > successCountBeforeRefresh) {
							const refreshedVersion = authoritativeProjectVersionRef.current;
							if (refreshedVersion.projectId === projectId && refreshedVersion.revision !== null) {
								queue.revision = refreshedVersion.revision;
							}
						} else {
							authoritativeProjectVersionRef.current = { projectId, revision: null };
						}
					}
					break;
				}
			}
			queue.running = false;
			const waiters = queue.waiters.splice(0);
			for (const resolveWaiter of waiters) {
				resolveWaiter(failure ?? { ok: true });
			}
		})();
	}, []);

	const applyProjectState = useCallback(
		(nextProjectState: RuntimeProjectStateResponse | null) => {
			if (!nextProjectState) {
				recordBrowserEvent(
					"browser.project_hydration_cleared",
					{},
					{ projectId: currentProjectId ?? undefined },
					{ essential: true },
				);
				syncTargetProjectIdRef.current = null;
				cachedBoardRestoreRef.current = null;
				setBoardProjectId(null);
				setProjectPath(null);
				setStoreProjectPath(currentProjectId, null);
				setProjectGit(null);
				setAppliedProjectId(null);
				setProjectBoardSessions({
					board: createInitialBoardData(),
					sessions: {},
				});
				setIsServedFromBoardCache(false);
				authoritativeProjectVersionRef.current = {
					projectId: null,
					revision: null,
				};
				lastAuthoritativeProjectStateRef.current = null;
				return;
			}
			if (currentProjectId !== syncTargetProjectIdRef.current) {
				return;
			}
			setProjectPath(nextProjectState.repoPath);
			setStoreProjectPath(currentProjectId, nextProjectState.repoPath);
			setProjectGit(nextProjectState.git);
			if (currentProjectId && !warnedProjectIdsRef.current.has(currentProjectId)) {
				const sessionsWarning = nextProjectState.warnings?.find(
					(warning) => warning.kind === "sessions_corruption",
				);
				if (sessionsWarning) {
					warnedProjectIdsRef.current.add(currentProjectId);
					const plural = sessionsWarning.droppedCount === 1 ? "entry" : "entries";
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `Skipped ${sessionsWarning.droppedCount} invalid session ${plural}. See server log for details.`,
						timeout: 10000,
					});
				}
			}
			// Authoritative project state enters the browser through exactly one
			// atomic apply seam. Do not split session reconciliation, board
			// projection, hydration policy, or cache/revision updates back into
			// separate snapshots here.
			const applyResult = applyAuthoritativeProjectState({
				currentState: projectBoardSessionsRef.current,
				currentVersion: authoritativeProjectVersionRef.current,
				currentProjectId,
				incomingProjectState: nextProjectState,
				cachedRestore: cachedBoardRestoreRef.current,
			});
			if (!applyResult) {
				recordBrowserEvent(
					"browser.project_hydration_ignored",
					{ incomingRevision: nextProjectState.revision },
					{ projectId: currentProjectId ?? undefined },
				);
				return;
			}
			const queue = currentProjectId ? commandQueuesRef.current.get(currentProjectId) : undefined;
			const optimisticBoard = queue?.pending.length
				? applyPendingProjectBoardCommands(
						applyResult.nextState.board,
						queue.pending.map((batch) => batch.commands),
					)
				: applyResult.nextState.board;
			recordBrowserEvent(
				"browser.project_hydration_applied",
				{
					incomingRevision: nextProjectState.revision,
					boardAction: applyResult.boardAction,
					hasOptimisticOverlay: Boolean(queue?.pending.length),
					servedFromCache: cachedBoardRestoreRef.current !== null,
				},
				{ projectId: currentProjectId ?? undefined },
				{ essential: true },
			);
			setProjectBoardSessions({
				...applyResult.nextState,
				board: optimisticBoard,
			});
			setBoardProjectId(currentProjectId);
			if (queue && !queue.running && queue.pending.length === 0) {
				queue.revision = nextProjectState.revision;
			}
			authoritativeProjectVersionRef.current = {
				projectId: currentProjectId,
				revision: nextProjectState.revision,
			};
			if (currentProjectId) {
				lastAuthoritativeProjectStateRef.current = {
					projectId: currentProjectId,
					state: {
						...nextProjectState,
						board: applyResult.authoritativeBoard,
						sessions: applyResult.nextState.sessions,
					},
				};
			}
			syncTargetProjectIdRef.current = currentProjectId;
			cachedBoardRestoreRef.current = null;
			setAppliedProjectId(currentProjectId);
			setIsServedFromBoardCache(false);
			if (currentProjectId) {
				updateProjectBoardCache(currentProjectId, {
					board: applyResult.boardForCache,
					sessions: applyResult.nextState.sessions,
					authoritativeRevision: nextProjectState.revision,
					projectPath: nextProjectState.repoPath,
					projectGit: nextProjectState.git,
				});
			}
		},
		[currentProjectId, setProjectBoardSessions],
	);
	applyProjectStateRef.current = (state) => applyProjectState(state);

	const refreshProjectState = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const requestId = projectRefreshRequestIdRef.current + 1;
		projectRefreshRequestIdRef.current = requestId;
		const requestedProjectId = currentProjectId;
		setIsProjectStateRefreshing(true);
		try {
			const refreshed = await fetchProjectState(requestedProjectId);
			if (
				projectRefreshRequestIdRef.current !== requestId ||
				syncTargetProjectIdRef.current !== requestedProjectId
			) {
				return;
			}
			applyProjectState(refreshed);
			projectRefreshSuccessCountRef.current += 1;
		} catch (error) {
			if (
				projectRefreshRequestIdRef.current !== requestId ||
				syncTargetProjectIdRef.current !== requestedProjectId
			) {
				return;
			}
			const message = toErrorMessage(error);
			recordBrowserEvent(
				"browser.project_refresh_failed",
				{ errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError" },
				{ projectId: requestedProjectId },
				{ level: "warn", essential: true },
			);
			notifyError(message);
		} finally {
			if (projectRefreshRequestIdRef.current === requestId) {
				setIsProjectStateRefreshing(false);
			}
		}
	}, [applyProjectState, currentProjectId]);
	refreshProjectStateRef.current = refreshProjectState;

	const setBoard = useCallback<Dispatch<SetStateAction<BoardData>>>(
		(nextBoardAction) => {
			const projectId = currentProjectId;
			const version = authoritativeProjectVersionRef.current;
			if (!projectId || version.projectId !== projectId || version.revision === null) {
				return;
			}
			const currentState = projectBoardSessionsRef.current;
			const nextBoard =
				typeof nextBoardAction === "function" ? nextBoardAction(currentState.board) : nextBoardAction;
			if (nextBoard === currentState.board) {
				return;
			}
			let commands: RuntimeProjectBoardCommand[];
			try {
				commands = deriveProjectBoardCommands(currentState.board, nextBoard);
			} catch (error) {
				showAppToast({ intent: "danger", message: `Could not prepare board change: ${toErrorMessage(error)}` });
				return;
			}
			if (commands.length === 0) {
				return;
			}
			const ordinaryCommands = commands.filter((command) => !isLifecycleManagedBoardCommand(command));
			setProjectBoardSessions({ ...currentState, board: nextBoard });
			if (ordinaryCommands.length > 0) {
				let queue = commandQueuesRef.current.get(projectId);
				if (!queue) {
					queue = {
						revision: version.revision,
						pending: [],
						running: false,
						waiters: [],
					};
					commandQueuesRef.current.set(projectId, queue);
				}
				queue.pending.push({ commandId: createBrowserCommandId(), commands: ordinaryCommands });
				pumpProjectBoardCommandQueue(projectId);
			}
		},
		[currentProjectId, projectBoardSessionsRef, pumpProjectBoardCommandQueue, setProjectBoardSessions],
	);

	const flushBoardCommands = useCallback(async (): Promise<FlushProjectBoardCommandsResult> => {
		if (!currentProjectId) {
			return { ok: false, message: "No project selected." };
		}
		const queue = commandQueuesRef.current.get(currentProjectId);
		if (!queue || (!queue.running && queue.pending.length === 0)) {
			return { ok: true };
		}
		return await new Promise<FlushProjectBoardCommandsResult>((resolve) => {
			queue.waiters.push(resolve);
			pumpProjectBoardCommandQueue(currentProjectId);
		});
	}, [currentProjectId, pumpProjectBoardCommandQueue]);

	const getAuthoritativeRevision = useCallback((): number | null => {
		const version = authoritativeProjectVersionRef.current;
		return version.projectId === currentProjectId ? version.revision : null;
	}, [currentProjectId]);

	const applyLifecycleProjectState = useCallback(
		(state: RuntimeProjectStateResponse): void => {
			if (!currentProjectId || syncTargetProjectIdRef.current !== currentProjectId) {
				return;
			}
			const currentVersion = authoritativeProjectVersionRef.current;
			if (
				currentVersion.projectId === currentProjectId &&
				currentVersion.revision !== null &&
				state.revision < currentVersion.revision
			) {
				return;
			}
			// A lifecycle response must remove its optimistic presentation even when
			// the stream already advertised the same revision. Re-enter the one
			// authoritative apply seam with exact hydration enabled.
			authoritativeProjectVersionRef.current = { projectId: currentProjectId, revision: null };
			applyProjectState(state);
		},
		[applyProjectState, currentProjectId],
	);

	const resetProjectSyncState = useCallback(
		(targetProjectId?: string | null) => {
			const prevProjectId = authoritativeProjectVersionRef.current.projectId;
			const prevRevision = authoritativeProjectVersionRef.current.revision;
			if (prevProjectId && prevRevision != null) {
				const lastAuthoritative = lastAuthoritativeProjectStateRef.current;
				const stateForCache =
					lastAuthoritative?.projectId === prevProjectId && lastAuthoritative.state.revision === prevRevision
						? lastAuthoritative.state
						: null;
				stashProjectBoard(prevProjectId, {
					// Never label an optimistic overlay as an authoritative cache entry.
					// Pending commands continue in the per-project queue after a switch
					// and replace this cache with their committed result.
					board: stateForCache?.board ?? projectBoardSessionsRef.current.board,
					sessions: stateForCache?.sessions ?? projectBoardSessionsRef.current.sessions,
					authoritativeRevision: prevRevision,
					projectPath: stateForCache?.repoPath ?? projectPath,
					projectGit: stateForCache?.git ?? projectGit,
				});
			}

			const restoreId = targetProjectId ?? currentProjectId;
			syncTargetProjectIdRef.current = restoreId;
			authoritativeProjectVersionRef.current = {
				projectId: restoreId,
				revision: null,
			};
			cachedBoardRestoreRef.current = null;
			lastAuthoritativeProjectStateRef.current = null;
			projectRefreshRequestIdRef.current += 1;
			setIsProjectStateRefreshing(false);
			setAppliedProjectId(null);

			const cached = restoreId ? restoreProjectBoard(restoreId) : null;
			if (cached && restoreId) {
				setProjectBoardSessions({
					board: cached.board,
					sessions: cached.sessions,
				});
				setBoardProjectId(restoreId);
				setProjectPath(cached.projectPath);
				setStoreProjectPath(restoreId, cached.projectPath);
				setProjectGit(cached.projectGit);
				cachedBoardRestoreRef.current = {
					projectId: restoreId,
					authoritativeRevision: cached.authoritativeRevision,
				};
				setIsServedFromBoardCache(true);
			} else {
				setProjectBoardSessions({
					board: createInitialBoardData(),
					sessions: {},
				});
				setBoardProjectId(null);
				setProjectPath(null);
				setStoreProjectPath(restoreId, null);
				setProjectGit(null);
				setIsServedFromBoardCache(false);
			}
		},
		[currentProjectId, setProjectBoardSessions, projectGit, projectPath],
	);

	useEffect(() => {
		if (hasNoProjects) {
			applyProjectState(null);
			return;
		}
		if (!streamedProjectState) {
			return;
		}
		applyProjectState(streamedProjectState);
	}, [applyProjectState, hasNoProjects, streamedProjectState]);

	useEffect(() => {
		if (!hasReceivedSnapshot || !isDocumentVisible || !streamedProjectState) {
			return;
		}
		void refreshProjectState();
	}, [hasReceivedSnapshot, isDocumentVisible, refreshProjectState, streamedProjectState]);

	return {
		boardProjectId,
		projectPath,
		projectGit,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
		setBoard,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
	};
}
