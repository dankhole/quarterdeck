import { isLifecycleManagedBoardCommand, normalizeDiagnosticErrorClass } from "@runtime-contract";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { recordBrowserEvent } from "@/diagnostics";
import { reconcileFileEditorProjectState, retireFileEditorScopes } from "@/hooks/git/file-editor-cache";
import {
	invalidateProjectBoardCache,
	restoreProjectBoard,
	stashProjectBoard,
	updateProjectBoardCache,
} from "@/runtime/project-board-cache";
import { invalidateProjectPreload, setSelectedProjectHydrating } from "@/runtime/project-preload-cache";
import { mergeProjectStateByRevision } from "@/runtime/project-state-ordering";
import { applyProjectBoardCommands, fetchProjectState, ProjectStateConflictError } from "@/runtime/project-state-query";
import type {
	RuntimeGitRepositoryInfo,
	RuntimeProjectBoardCommand,
	RuntimeProjectStateResponse,
} from "@/runtime/types";
import { resetProjectMetadataStore, setProjectPath as setStoreProjectPath } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { createRandomId } from "@/utils/random-id";
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

/**
 * Bounded backoff for retrying a project snapshot that failed to hydrate
 * (the runtime published `projectState: null`, or a `getState` refetch
 * failed). Keep retrying — capped at this delay — until the project
 * hydrates or the user navigates away; a transient upstream git/availability
 * failure (see docs/conventions/runtime-state.md) must not strand the
 * browser in a permanent loading state.
 */
const PROJECT_HYDRATION_RETRY_INITIAL_DELAY_MS = 1_000;
const PROJECT_HYDRATION_RETRY_MAX_DELAY_MS = 10_000;
/**
 * After this many retry attempts (delays 1s, 2s, 4s, 8s — ~15s elapsed), stop
 * reporting this project as "hydrating" for hover-preload gating purposes.
 * Retries keep running at the capped interval in the background regardless;
 * this only bounds how long a stuck project can suppress its own hover
 * preload (other projects' hover preload is never gated by this at all).
 */
const PROJECT_HYDRATION_PRELOAD_GATE_MAX_ATTEMPTS = 4;

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

function cacheAuthoritativeProjectState(projectId: string, state: RuntimeProjectStateResponse): void {
	updateProjectBoardCache(projectId, {
		board: state.board,
		sessions: state.sessions,
		authoritativeRevision: state.revision,
		projectPath: state.repoPath,
		projectGit: state.git,
		metadataRevision: state.metadataRevision,
		availability: state.availability,
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
	refreshProjectState: (options?: {
		restoreLifecyclePresentation?: boolean;
		suppressErrorToast?: boolean;
	}) => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	presentLifecycleBoard: Dispatch<SetStateAction<BoardData>>;
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
	const initialProjectSelectionPendingRef = useRef(currentProjectId === null);
	const projectRefreshRequestIdRef = useRef(0);
	const projectRefreshSuccessCountRef = useRef(0);
	const warnedProjectIdsRef = useRef<Set<string>>(new Set());
	const commandQueuesRef = useRef(new Map<string, ProjectBoardCommandQueue>());
	const lastAuthoritativeProjectStateRef = useRef<{
		projectId: string;
		state: RuntimeProjectStateResponse;
	} | null>(null);
	const previousLocationRef = useRef<{ projectId: string; path: string; unavailable: boolean } | null>(null);
	const applyProjectStateRef = useRef<(state: RuntimeProjectStateResponse) => void>(() => {});
	const refreshProjectStateRef = useRef<() => Promise<void>>(async () => {});
	// Snapshot-generation / visibility / project-switch transition tracking for
	// the refetch-trigger effect below (never retrigger on a plain streamed delta).
	const refreshTriggerSignalRef = useRef<{
		hasReceivedSnapshot: boolean;
		isDocumentVisible: boolean;
		currentProjectId: string | null;
	}>({ hasReceivedSnapshot: false, isDocumentVisible: false, currentProjectId: null });
	// Bounded-backoff hydration-retry bookkeeping, fenced by project identity.
	const hydrationRetryAttemptRef = useRef(0);
	const hydrationRetrySeriesProjectIdRef = useRef<string | null>(null);
	const hydrationRetryErrorNotifiedRef = useRef(false);

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
				previousLocationRef.current = null;
				return;
			}
			if (currentProjectId !== syncTargetProjectIdRef.current) {
				return;
			}
			const lastAuthoritative = lastAuthoritativeProjectStateRef.current;
			nextProjectState = mergeProjectStateByRevision(
				lastAuthoritative?.projectId === currentProjectId ? lastAuthoritative.state : null,
				nextProjectState,
			);
			const previousLocation = previousLocationRef.current;
			const unavailable = nextProjectState.availability?.status === "unavailable";
			if (currentProjectId) {
				if (previousLocation?.projectId === currentProjectId) {
					const pathChanged = previousLocation.path !== nextProjectState.repoPath;
					const availabilityChanged = previousLocation.unavailable !== unavailable;
					if (pathChanged || availabilityChanged) {
						retireFileEditorScopes({ projectId: currentProjectId });
						invalidateProjectPreload(currentProjectId);
						resetProjectMetadataStore(currentProjectId);
					}
					// The board cache is project-owned presentation reused for unavailable projects; only a path change stales its path/git fields.
					if (pathChanged) {
						invalidateProjectBoardCache(currentProjectId);
					}
				}
				previousLocationRef.current = { projectId: currentProjectId, path: nextProjectState.repoPath, unavailable };
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
			if (currentProjectId) reconcileFileEditorProjectState(currentProjectId, nextProjectState);
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
					metadataRevision: nextProjectState.metadataRevision,
					availability: nextProjectState.availability,
				});
			}
		},
		[currentProjectId, setProjectBoardSessions],
	);
	applyProjectStateRef.current = (state) => applyProjectState(state);

	const applyLifecycleProjectState = useCallback(
		(state: RuntimeProjectStateResponse): void => {
			if (!currentProjectId || syncTargetProjectIdRef.current !== currentProjectId) {
				return;
			}
			const currentVersion = authoritativeProjectVersionRef.current;
			// A lifecycle response must remove its optimistic presentation even when
			// the stream already advertised the same revision. Re-enter the one
			// authoritative apply seam with exact hydration enabled.
			if (currentVersion.revision === null || state.revision >= currentVersion.revision) {
				authoritativeProjectVersionRef.current = { projectId: currentProjectId, revision: null };
			}
			applyProjectState(state);
		},
		[applyProjectState, currentProjectId],
	);

	const refreshProjectState = useCallback(
		async (options?: { restoreLifecyclePresentation?: boolean; suppressErrorToast?: boolean }) => {
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
				if (options?.restoreLifecyclePresentation) {
					applyLifecycleProjectState(refreshed);
				} else {
					applyProjectState(refreshed);
				}
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
				if (!options?.suppressErrorToast) {
					notifyError(message);
				}
			} finally {
				if (projectRefreshRequestIdRef.current === requestId) {
					setIsProjectStateRefreshing(false);
				}
			}
		},
		[applyLifecycleProjectState, applyProjectState, currentProjectId],
	);
	refreshProjectStateRef.current = refreshProjectState;

	const setBoard = useCallback<Dispatch<SetStateAction<BoardData>>>(
		(nextBoardAction) => {
			const projectId = currentProjectId;
			const version = authoritativeProjectVersionRef.current;
			if (lastAuthoritativeProjectStateRef.current?.state.availability?.status === "unavailable") return;
			if (!projectId || version.projectId !== projectId) {
				return;
			}
			if (version.revision === null) {
				// The board shown right now is a read-only cached/preloaded view while
				// this project (re)hydrates. Tell the user instead of silently
				// discarding their edit (e.g. a drag-and-drop move).
				showAppToast(
					{ message: "Still syncing with the project. Try that again in a moment.", timeout: 3000 },
					"project-board-not-ready",
				);
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
			const lifecycleCommandCount = commands.length - ordinaryCommands.length;
			if (lifecycleCommandCount > 0) {
				recordBrowserEvent(
					"browser.lifecycle_board_command_rejected",
					{ commandCount: lifecycleCommandCount },
					{ projectId },
					{ level: "warn", essential: true },
				);
				showAppToast({
					intent: "danger",
					message: "Task state changes must use an explicit task action.",
				});
				return;
			}
			setProjectBoardSessions({ ...currentState, board: nextBoard });
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
			queue.pending.push({ commandId: createRandomId("browser"), commands: ordinaryCommands });
			pumpProjectBoardCommandQueue(projectId);
		},
		[currentProjectId, projectBoardSessionsRef, pumpProjectBoardCommandQueue, setProjectBoardSessions],
	);

	const presentLifecycleBoard = useCallback<Dispatch<SetStateAction<BoardData>>>(
		(nextBoardAction) => {
			const projectId = currentProjectId;
			const version = authoritativeProjectVersionRef.current;
			if (lastAuthoritativeProjectStateRef.current?.state.availability?.status === "unavailable") return;
			if (!projectId || version.projectId !== projectId) {
				return;
			}
			if (version.revision === null) {
				// Same read-only-while-hydrating rule as setBoard: tell the user
				// rather than silently discarding the optimistic lifecycle move.
				showAppToast(
					{ message: "Still syncing with the project. Try that again in a moment.", timeout: 3000 },
					"project-board-not-ready",
				);
				return;
			}
			const currentState = projectBoardSessionsRef.current;
			const nextBoard =
				typeof nextBoardAction === "function" ? nextBoardAction(currentState.board) : nextBoardAction;
			if (nextBoard === currentState.board) {
				return;
			}
			// Lifecycle persistence belongs exclusively to ProjectTaskLifecycleService.
			// This update is only an optimistic browser presentation and is always
			// replaced by the authoritative lifecycle response or runtime stream.
			setProjectBoardSessions({ ...currentState, board: nextBoard });
		},
		[currentProjectId, projectBoardSessionsRef, setProjectBoardSessions],
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

	const resetProjectSyncState = useCallback(
		(targetProjectId?: string | null) => {
			initialProjectSelectionPendingRef.current = false;
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
					metadataRevision: stateForCache?.metadataRevision,
					availability: stateForCache?.availability,
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
			previousLocationRef.current = null;
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
				if (cached.projectPath)
					previousLocationRef.current = {
						projectId: restoreId,
						path: cached.projectPath,
						unavailable: cached.availability?.status === "unavailable",
					};
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
		// Root navigation can receive the runtime's selected project without an
		// explicit switch. Adopt only that first authoritative selection; a reset
		// or any established target permanently consumes this initial allowance.
		if (
			initialProjectSelectionPendingRef.current &&
			hasReceivedSnapshot &&
			currentProjectId !== null &&
			syncTargetProjectIdRef.current === null &&
			authoritativeProjectVersionRef.current.projectId === null &&
			authoritativeProjectVersionRef.current.revision === null
		) {
			initialProjectSelectionPendingRef.current = false;
			syncTargetProjectIdRef.current = currentProjectId;
		}
		applyProjectState(streamedProjectState);
	}, [applyProjectState, currentProjectId, hasNoProjects, hasReceivedSnapshot, streamedProjectState]);

	// Refetch getState only on a real trigger — a new stream snapshot
	// generation, visibility regain, or an explicit project switch — never on
	// every streamed project-state object change. The apply effect above
	// already consumes those deltas directly; re-fetching on each one doubled
	// the browser's board/session traffic for no benefit.
	useEffect(() => {
		const previous = refreshTriggerSignalRef.current;
		const snapshotGenerationChanged = hasReceivedSnapshot && !previous.hasReceivedSnapshot;
		const visibilityRegained = isDocumentVisible && !previous.isDocumentVisible;
		const projectSwitched = currentProjectId !== previous.currentProjectId;
		refreshTriggerSignalRef.current = { hasReceivedSnapshot, isDocumentVisible, currentProjectId };
		if (snapshotGenerationChanged) {
			// A fresh connection/generation starts its own one-shot retry-failure notice.
			hydrationRetryErrorNotifiedRef.current = false;
		}
		if (!hasReceivedSnapshot || !isDocumentVisible || !streamedProjectState) {
			return;
		}
		if (!snapshotGenerationChanged && !visibilityRegained && !projectSwitched) {
			return;
		}
		void refreshProjectState();
	}, [currentProjectId, hasReceivedSnapshot, isDocumentVisible, refreshProjectState, streamedProjectState]);

	// Snapshot failure recovery: the runtime can publish `projectState: null`
	// (or keep the browser waiting) after a transient upstream failure. Retry
	// `getState` with bounded backoff until this exact project hydrates,
	// instead of leaving the browser stuck on its cached/preloaded board (or
	// no board at all) forever. Fenced by project identity; refreshProjectState's
	// own request-id fencing discards a response that arrives after a switch.
	// Failures are retried silently except for a single one-shot notice per
	// fenced retry series (cleared on success or on a project/generation switch)
	// so a flaky connection does not spam repeated error toasts.
	useEffect(() => {
		const needsHydration =
			hasReceivedSnapshot && isDocumentVisible && currentProjectId !== null && isProjectMetadataPending;
		if (!needsHydration) {
			hydrationRetryAttemptRef.current = 0;
			hydrationRetrySeriesProjectIdRef.current = null;
			// Hydrated (or no longer applicable) — this exact project no longer
			// gates its own hover preload. Other projects were never gated by it.
			setSelectedProjectHydrating(null);
			return;
		}
		if (hydrationRetrySeriesProjectIdRef.current !== currentProjectId) {
			hydrationRetrySeriesProjectIdRef.current = currentProjectId;
			hydrationRetryAttemptRef.current = 0;
			hydrationRetryErrorNotifiedRef.current = false;
		}
		// Self-contained recursive scheduler: a retry effect that only fires once
		// per dependency change would never reschedule after a *failed* attempt,
		// since a failure changes none of this effect's inputs. The loop here
		// reschedules itself on every failure and stops only once the effect is
		// torn down (hydrated, project switched, or unmounted).
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const scheduleNext = () => {
			const attempt = hydrationRetryAttemptRef.current;
			// Only gate this exact project's own hover preload for a bounded
			// number of attempts; keep retrying past that at the capped interval,
			// but stop treating it as "this project's own fetch" for preload.
			setSelectedProjectHydrating(attempt < PROJECT_HYDRATION_PRELOAD_GATE_MAX_ATTEMPTS ? currentProjectId : null);
			const delay = Math.min(
				PROJECT_HYDRATION_RETRY_MAX_DELAY_MS,
				PROJECT_HYDRATION_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
			);
			timer = setTimeout(async () => {
				if (cancelled) return;
				hydrationRetryAttemptRef.current = attempt + 1;
				const successCountBeforeRetry = projectRefreshSuccessCountRef.current;
				await refreshProjectState({ suppressErrorToast: true });
				if (cancelled) return;
				if (projectRefreshSuccessCountRef.current > successCountBeforeRetry) {
					// Hydrated — the dependency change this triggers will tear this
					// effect down; nothing left to reschedule.
					hydrationRetryErrorNotifiedRef.current = false;
					setSelectedProjectHydrating(null);
					return;
				}
				if (!hydrationRetryErrorNotifiedRef.current && syncTargetProjectIdRef.current === currentProjectId) {
					hydrationRetryErrorNotifiedRef.current = true;
					notifyError("Still trying to load this project. Quarterdeck will keep retrying.", {
						key: "project-hydration-retry",
					});
				}
				scheduleNext();
			}, delay);
		};
		scheduleNext();
		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
			// Unmounting mid-gate must not leave the module-level gate stuck
			// pointing at a project nothing will ever clear it for again.
			setSelectedProjectHydrating(null);
		};
	}, [currentProjectId, hasReceivedSnapshot, isDocumentVisible, isProjectMetadataPending, refreshProjectState]);

	return {
		boardProjectId,
		projectPath,
		projectGit,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
		setBoard,
		presentLifecycleBoard,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
	};
}
