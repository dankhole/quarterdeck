import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { restoreProjectBoard, stashProjectBoard, updateProjectBoardCache } from "@/runtime/project-board-cache";
import { fetchProjectState } from "@/runtime/project-state-query";
import type { RuntimeGitRepositoryInfo, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { normalizeBoardData } from "@/state/board-state";
import { setProjectPath as setStoreProjectPath } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

import {
	applyAuthoritativeProjectBoard,
	type CachedProjectBoardRestore,
	type ProjectVersion,
	reconcileAuthoritativeTaskSessionSummaries,
	resolveAuthoritativeBoardAction,
	shouldApplyProjectUpdate,
} from "./project-sync";

interface UseProjectSyncInput {
	currentProjectId: string | null;
	streamedProjectState: RuntimeProjectStateResponse | null;
	hasNoProjects: boolean;
	hasReceivedSnapshot: boolean;
	isDocumentVisible: boolean;
	boardRef: MutableRefObject<BoardData>;
	sessionsRef: MutableRefObject<Record<string, RuntimeTaskSessionSummary>>;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	setCanPersistProjectState: Dispatch<SetStateAction<boolean>>;
}

interface UseProjectSyncResult {
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	projectRevision: number | null;
	setProjectRevision: Dispatch<SetStateAction<number | null>>;
	projectHydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	isProjectStateRefreshing: boolean;
	isProjectMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	refreshProjectState: () => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
}

interface ProjectHydrationState {
	nonce: number;
	shouldSkipPersistOnHydration: boolean;
}

export function useProjectSync({
	currentProjectId,
	streamedProjectState,
	hasNoProjects,
	hasReceivedSnapshot,
	isDocumentVisible,
	boardRef,
	sessionsRef,
	setBoard,
	setSessions,
	setCanPersistProjectState,
}: UseProjectSyncInput): UseProjectSyncResult {
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const [projectGit, setProjectGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedProjectId, setAppliedProjectId] = useState<string | null>(null);
	const [projectRevision, setProjectRevision] = useState<number | null>(null);
	const [projectHydrationState, setProjectHydrationState] = useState<ProjectHydrationState>({
		nonce: 0,
		shouldSkipPersistOnHydration: true,
	});
	const [isProjectStateRefreshing, setIsProjectStateRefreshing] = useState(false);
	const [isServedFromBoardCache, setIsServedFromBoardCache] = useState(false);
	const authoritativeProjectVersionRef = useRef<ProjectVersion>({
		projectId: null,
		revision: null,
	});
	const cachedBoardRestoreRef = useRef<CachedProjectBoardRestore | null>(null);
	const syncTargetProjectIdRef = useRef<string | null>(currentProjectId);
	const projectRefreshRequestIdRef = useRef(0);

	const isProjectMetadataPending = currentProjectId !== null && appliedProjectId !== currentProjectId;

	useEffect(() => {
		if (authoritativeProjectVersionRef.current.projectId !== currentProjectId) {
			return;
		}
		authoritativeProjectVersionRef.current = {
			projectId: currentProjectId,
			revision: projectRevision,
		};
	}, [currentProjectId, projectRevision]);

	const applyProjectState = useCallback(
		(nextProjectState: RuntimeProjectStateResponse | null) => {
			if (!nextProjectState) {
				syncTargetProjectIdRef.current = null;
				cachedBoardRestoreRef.current = null;
				setCanPersistProjectState(false);
				setProjectPath(null);
				setStoreProjectPath(null);
				setProjectGit(null);
				setAppliedProjectId(null);
				setBoard(createInitialBoardData());
				setSessions({});
				setProjectRevision(null);
				setProjectHydrationState((current) => ({
					nonce: current.nonce,
					shouldSkipPersistOnHydration: true,
				}));
				setIsServedFromBoardCache(false);
				authoritativeProjectVersionRef.current = {
					projectId: null,
					revision: null,
				};
				return;
			}
			if (currentProjectId !== syncTargetProjectIdRef.current) {
				return;
			}
			if (
				shouldApplyProjectUpdate(
					authoritativeProjectVersionRef.current,
					currentProjectId,
					nextProjectState.revision,
				) === "skip"
			) {
				return;
			}
			setProjectPath(nextProjectState.repoPath);
			setStoreProjectPath(nextProjectState.repoPath);
			setProjectGit(nextProjectState.git);
			const incomingSessions = nextProjectState.sessions ?? {};
			const reconciledSessions = reconcileAuthoritativeTaskSessionSummaries(sessionsRef.current, incomingSessions);
			setSessions(reconciledSessions);
			const normalizedBoard = normalizeBoardData(nextProjectState.board) ?? createInitialBoardData();
			const authoritativeBoard = applyAuthoritativeProjectBoard(normalizedBoard, reconciledSessions);
			const currentProjectedBoard = applyAuthoritativeProjectBoard(boardRef.current, reconciledSessions);
			const boardAction = resolveAuthoritativeBoardAction(
				authoritativeProjectVersionRef.current,
				currentProjectId,
				nextProjectState.revision,
				cachedBoardRestoreRef.current,
			);
			if (boardAction === "hydrate") {
				setBoard(authoritativeBoard.board);
				setProjectHydrationState((current) => ({
					nonce: current.nonce + 1,
					shouldSkipPersistOnHydration: authoritativeBoard.shouldSkipPersistOnHydration,
				}));
			} else if (!currentProjectedBoard.shouldSkipPersistOnHydration) {
				setBoard(currentProjectedBoard.board);
				setProjectHydrationState((current) => ({
					nonce: current.nonce + 1,
					shouldSkipPersistOnHydration: currentProjectedBoard.shouldSkipPersistOnHydration,
				}));
			}
			setProjectRevision(nextProjectState.revision);
			authoritativeProjectVersionRef.current = {
				projectId: currentProjectId,
				revision: nextProjectState.revision,
			};
			syncTargetProjectIdRef.current = currentProjectId;
			cachedBoardRestoreRef.current = null;
			setAppliedProjectId(currentProjectId);
			setCanPersistProjectState(true);
			setIsServedFromBoardCache(false);
			if (currentProjectId) {
				updateProjectBoardCache(currentProjectId, {
					board: boardAction === "hydrate" ? authoritativeBoard.board : currentProjectedBoard.board,
					sessions: reconciledSessions,
					authoritativeRevision: nextProjectState.revision,
					projectPath: nextProjectState.repoPath,
					projectGit: nextProjectState.git,
				});
			}
		},
		[currentProjectId, setBoard, setCanPersistProjectState, setSessions],
	);

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
		} catch (error) {
			if (
				projectRefreshRequestIdRef.current !== requestId ||
				syncTargetProjectIdRef.current !== requestedProjectId
			) {
				return;
			}
			const message = toErrorMessage(error);
			notifyError(message);
		} finally {
			if (projectRefreshRequestIdRef.current === requestId) {
				setIsProjectStateRefreshing(false);
			}
		}
	}, [applyProjectState, currentProjectId]);

	const resetProjectSyncState = useCallback(
		(targetProjectId?: string | null) => {
			const prevProjectId = authoritativeProjectVersionRef.current.projectId;
			const prevRevision = authoritativeProjectVersionRef.current.revision;
			if (prevProjectId && prevRevision != null) {
				stashProjectBoard(prevProjectId, {
					board: boardRef.current,
					sessions: sessionsRef.current,
					authoritativeRevision: prevRevision,
					projectPath: projectPath,
					projectGit: projectGit,
				});
			}

			const restoreId = targetProjectId ?? currentProjectId;
			syncTargetProjectIdRef.current = restoreId;
			authoritativeProjectVersionRef.current = {
				projectId: restoreId,
				revision: null,
			};
			cachedBoardRestoreRef.current = null;
			projectRefreshRequestIdRef.current += 1;
			setCanPersistProjectState(false);
			setIsProjectStateRefreshing(false);
			setAppliedProjectId(null);
			setProjectRevision(null);
			setProjectHydrationState((current) => ({
				nonce: current.nonce,
				shouldSkipPersistOnHydration: true,
			}));

			const cached = restoreId ? restoreProjectBoard(restoreId) : null;
			if (cached && restoreId) {
				setBoard(cached.board);
				setSessions(cached.sessions);
				setProjectPath(cached.projectPath);
				setStoreProjectPath(cached.projectPath);
				setProjectGit(cached.projectGit);
				cachedBoardRestoreRef.current = {
					projectId: restoreId,
					authoritativeRevision: cached.authoritativeRevision,
				};
				setIsServedFromBoardCache(true);
			} else {
				setBoard(createInitialBoardData());
				setSessions({});
				setProjectPath(null);
				setStoreProjectPath(null);
				setProjectGit(null);
				setIsServedFromBoardCache(false);
			}
		},
		[
			boardRef,
			currentProjectId,
			sessionsRef,
			setBoard,
			setCanPersistProjectState,
			setSessions,
			projectGit,
			projectPath,
		],
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
		if (!hasReceivedSnapshot || !isDocumentVisible) {
			return;
		}
		void refreshProjectState();
	}, [hasReceivedSnapshot, isDocumentVisible, refreshProjectState]);

	return {
		projectPath,
		projectGit,
		projectRevision,
		setProjectRevision,
		projectHydrationNonce: projectHydrationState.nonce,
		shouldSkipPersistOnHydration: projectHydrationState.shouldSkipPersistOnHydration,
		isProjectStateRefreshing,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
	};
}
