import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { restoreProjectBoard, stashProjectBoard, updateProjectBoardCache } from "@/runtime/project-board-cache";
import { fetchWorkspaceState } from "@/runtime/project-state-query";
import type { RuntimeGitRepositoryInfo, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { normalizeBoardData } from "@/state/board-state";
import { setProjectPath as setStoreWorkspacePath } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

import {
	mergeTaskSessionSummaries,
	type ProjectVersion,
	shouldApplyProjectUpdate,
	shouldHydrateBoard,
} from "./project-sync";

interface UseWorkspaceSyncInput {
	currentProjectId: string | null;
	streamedProjectState: RuntimeProjectStateResponse | null;
	hasNoProjects: boolean;
	hasReceivedSnapshot: boolean;
	isDocumentVisible: boolean;
	boardRef: MutableRefObject<BoardData>;
	sessionsRef: MutableRefObject<Record<string, RuntimeTaskSessionSummary>>;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	setCanPersistWorkspaceState: Dispatch<SetStateAction<boolean>>;
}

interface UseWorkspaceSyncResult {
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	projectRevision: number | null;
	setWorkspaceRevision: Dispatch<SetStateAction<number | null>>;
	projectHydrationNonce: number;
	isProjectStateRefreshing: boolean;
	isProjectMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	refreshWorkspaceState: () => Promise<void>;
	resetWorkspaceSyncState: (targetProjectId?: string | null) => void;
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
	setCanPersistWorkspaceState,
}: UseWorkspaceSyncInput): UseWorkspaceSyncResult {
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const [projectGit, setWorkspaceGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedProjectId, setAppliedWorkspaceProjectId] = useState<string | null>(null);
	const [projectRevision, setWorkspaceRevision] = useState<number | null>(null);
	const [projectHydrationNonce, setWorkspaceHydrationNonce] = useState(0);
	const [isProjectStateRefreshing, setIsWorkspaceStateRefreshing] = useState(false);
	const [isServedFromBoardCache, setIsServedFromBoardCache] = useState(false);
	const projectVersionRef = useRef<ProjectVersion>({
		projectId: null,
		revision: null,
	});
	const projectRefreshRequestIdRef = useRef(0);

	const isProjectMetadataPending = currentProjectId !== null && appliedProjectId !== currentProjectId;

	useEffect(() => {
		if (projectVersionRef.current.projectId !== currentProjectId) {
			return;
		}
		projectVersionRef.current = {
			projectId: currentProjectId,
			revision: projectRevision,
		};
	}, [currentProjectId, projectRevision]);

	const applyWorkspaceState = useCallback(
		(nextProjectState: RuntimeProjectStateResponse | null) => {
			if (!nextProjectState) {
				setCanPersistWorkspaceState(false);
				setProjectPath(null);
				setStoreWorkspacePath(null);
				setWorkspaceGit(null);
				setAppliedWorkspaceProjectId(null);
				setBoard(createInitialBoardData());
				setSessions({});
				setWorkspaceRevision(null);
				setIsServedFromBoardCache(false);
				projectVersionRef.current = {
					projectId: currentProjectId,
					revision: null,
				};
				return;
			}
			if (
				shouldApplyProjectUpdate(projectVersionRef.current, currentProjectId, nextProjectState.revision) === "skip"
			) {
				return;
			}
			setProjectPath(nextProjectState.repoPath);
			setStoreWorkspacePath(nextProjectState.repoPath);
			setWorkspaceGit(nextProjectState.git);
			setSessions((currentSessions) => {
				const incomingSessions = nextProjectState.sessions ?? {};
				return mergeTaskSessionSummaries(currentSessions, incomingSessions);
			});
			const normalizedBoard = normalizeBoardData(nextProjectState.board) ?? createInitialBoardData();
			if (shouldHydrateBoard(projectVersionRef.current, currentProjectId, nextProjectState.revision)) {
				setBoard(normalizedBoard);
				setWorkspaceHydrationNonce((current) => current + 1);
			}
			setWorkspaceRevision(nextProjectState.revision);
			projectVersionRef.current = {
				projectId: currentProjectId,
				revision: nextProjectState.revision,
			};
			setAppliedWorkspaceProjectId(currentProjectId);
			setCanPersistWorkspaceState(true);
			setIsServedFromBoardCache(false);
			if (currentProjectId) {
				updateProjectBoardCache(currentProjectId, {
					board: normalizedBoard,
					sessions: nextProjectState.sessions ?? {},
					revision: nextProjectState.revision,
					projectPath: nextProjectState.repoPath,
					projectGit: nextProjectState.git,
				});
			}
		},
		[currentProjectId, setBoard, setCanPersistWorkspaceState, setSessions],
	);

	const refreshWorkspaceState = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const requestId = projectRefreshRequestIdRef.current + 1;
		projectRefreshRequestIdRef.current = requestId;
		const requestedProjectId = currentProjectId;
		setIsWorkspaceStateRefreshing(true);
		try {
			const refreshed = await fetchWorkspaceState(requestedProjectId);
			if (
				projectRefreshRequestIdRef.current !== requestId ||
				projectVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			applyWorkspaceState(refreshed);
		} catch (error) {
			if (
				projectRefreshRequestIdRef.current !== requestId ||
				projectVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			const message = toErrorMessage(error);
			notifyError(message);
		} finally {
			if (projectRefreshRequestIdRef.current === requestId) {
				setIsWorkspaceStateRefreshing(false);
			}
		}
	}, [applyWorkspaceState, currentProjectId]);

	const resetWorkspaceSyncState = useCallback(
		(targetProjectId?: string | null) => {
			const prevProjectId = projectVersionRef.current.projectId;
			const prevRevision = projectVersionRef.current.revision;
			if (prevProjectId && prevRevision != null) {
				stashProjectBoard(prevProjectId, {
					board: boardRef.current,
					sessions: sessionsRef.current,
					revision: prevRevision,
					projectPath: projectPath,
					projectGit: projectGit,
				});
			}

			projectRefreshRequestIdRef.current += 1;
			setCanPersistWorkspaceState(false);
			setIsWorkspaceStateRefreshing(false);
			setAppliedWorkspaceProjectId(null);

			const restoreId = targetProjectId ?? currentProjectId;
			const cached = restoreId ? restoreProjectBoard(restoreId) : null;
			if (cached) {
				setBoard(cached.board);
				setSessions(cached.sessions);
				setWorkspaceRevision(cached.revision);
				setProjectPath(cached.projectPath);
				setStoreWorkspacePath(cached.projectPath);
				setWorkspaceGit(cached.projectGit);
				projectVersionRef.current = {
					projectId: restoreId,
					revision: cached.revision,
				};
				setIsServedFromBoardCache(true);
			} else {
				setWorkspaceRevision(null);
				projectVersionRef.current = {
					projectId: currentProjectId,
					revision: null,
				};
				setIsServedFromBoardCache(false);
			}
		},
		[
			boardRef,
			currentProjectId,
			sessionsRef,
			setBoard,
			setCanPersistWorkspaceState,
			setSessions,
			projectGit,
			projectPath,
		],
	);

	useEffect(() => {
		if (hasNoProjects) {
			applyWorkspaceState(null);
			return;
		}
		if (!streamedProjectState) {
			return;
		}
		applyWorkspaceState(streamedProjectState);
	}, [applyWorkspaceState, hasNoProjects, streamedProjectState]);

	useEffect(() => {
		if (!hasReceivedSnapshot || !isDocumentVisible) {
			return;
		}
		void refreshWorkspaceState();
	}, [hasReceivedSnapshot, isDocumentVisible, refreshWorkspaceState]);

	return {
		projectPath,
		projectGit,
		projectRevision,
		setWorkspaceRevision,
		projectHydrationNonce,
		isProjectStateRefreshing,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	};
}
