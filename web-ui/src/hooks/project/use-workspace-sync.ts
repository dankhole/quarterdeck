import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { restoreProjectBoard, stashProjectBoard, updateProjectBoardCache } from "@/runtime/project-board-cache";
import type {
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";
import { normalizeBoardData } from "@/state/board-state";
import { setWorkspacePath as setStoreWorkspacePath } from "@/stores/workspace-metadata-store";
import type { BoardData } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

import {
	mergeTaskSessionSummaries,
	shouldApplyWorkspaceUpdate,
	shouldHydrateBoard,
	type WorkspaceVersion,
} from "./workspace-sync";

interface UseWorkspaceSyncInput {
	currentProjectId: string | null;
	streamedWorkspaceState: RuntimeWorkspaceStateResponse | null;
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
	workspacePath: string | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	workspaceRevision: number | null;
	setWorkspaceRevision: Dispatch<SetStateAction<number | null>>;
	workspaceHydrationNonce: number;
	isWorkspaceStateRefreshing: boolean;
	isWorkspaceMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	refreshWorkspaceState: () => Promise<void>;
	resetWorkspaceSyncState: (targetProjectId?: string | null) => void;
}

export function useWorkspaceSync({
	currentProjectId,
	streamedWorkspaceState,
	hasNoProjects,
	hasReceivedSnapshot,
	isDocumentVisible,
	boardRef,
	sessionsRef,
	setBoard,
	setSessions,
	setCanPersistWorkspaceState,
}: UseWorkspaceSyncInput): UseWorkspaceSyncResult {
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);
	const [workspaceGit, setWorkspaceGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedWorkspaceProjectId, setAppliedWorkspaceProjectId] = useState<string | null>(null);
	const [workspaceRevision, setWorkspaceRevision] = useState<number | null>(null);
	const [workspaceHydrationNonce, setWorkspaceHydrationNonce] = useState(0);
	const [isWorkspaceStateRefreshing, setIsWorkspaceStateRefreshing] = useState(false);
	const [isServedFromBoardCache, setIsServedFromBoardCache] = useState(false);
	const workspaceVersionRef = useRef<WorkspaceVersion>({
		projectId: null,
		revision: null,
	});
	const workspaceRefreshRequestIdRef = useRef(0);

	const isWorkspaceMetadataPending = currentProjectId !== null && appliedWorkspaceProjectId !== currentProjectId;

	useEffect(() => {
		if (workspaceVersionRef.current.projectId !== currentProjectId) {
			return;
		}
		workspaceVersionRef.current = {
			projectId: currentProjectId,
			revision: workspaceRevision,
		};
	}, [currentProjectId, workspaceRevision]);

	const applyWorkspaceState = useCallback(
		(nextWorkspaceState: RuntimeWorkspaceStateResponse | null) => {
			if (!nextWorkspaceState) {
				setCanPersistWorkspaceState(false);
				setWorkspacePath(null);
				setStoreWorkspacePath(null);
				setWorkspaceGit(null);
				setAppliedWorkspaceProjectId(null);
				setBoard(createInitialBoardData());
				setSessions({});
				setWorkspaceRevision(null);
				setIsServedFromBoardCache(false);
				workspaceVersionRef.current = {
					projectId: currentProjectId,
					revision: null,
				};
				return;
			}
			if (
				shouldApplyWorkspaceUpdate(workspaceVersionRef.current, currentProjectId, nextWorkspaceState.revision) ===
				"skip"
			) {
				return;
			}
			setWorkspacePath(nextWorkspaceState.repoPath);
			setStoreWorkspacePath(nextWorkspaceState.repoPath);
			setWorkspaceGit(nextWorkspaceState.git);
			setSessions((currentSessions) => {
				const incomingSessions = nextWorkspaceState.sessions ?? {};
				return mergeTaskSessionSummaries(currentSessions, incomingSessions);
			});
			const normalizedBoard = normalizeBoardData(nextWorkspaceState.board) ?? createInitialBoardData();
			if (shouldHydrateBoard(workspaceVersionRef.current, currentProjectId, nextWorkspaceState.revision)) {
				setBoard(normalizedBoard);
				setWorkspaceHydrationNonce((current) => current + 1);
			}
			setWorkspaceRevision(nextWorkspaceState.revision);
			workspaceVersionRef.current = {
				projectId: currentProjectId,
				revision: nextWorkspaceState.revision,
			};
			setAppliedWorkspaceProjectId(currentProjectId);
			setCanPersistWorkspaceState(true);
			setIsServedFromBoardCache(false);
			if (currentProjectId) {
				updateProjectBoardCache(currentProjectId, {
					board: normalizedBoard,
					sessions: nextWorkspaceState.sessions ?? {},
					revision: nextWorkspaceState.revision,
					workspacePath: nextWorkspaceState.repoPath,
					workspaceGit: nextWorkspaceState.git,
				});
			}
		},
		[currentProjectId, setBoard, setCanPersistWorkspaceState, setSessions],
	);

	const refreshWorkspaceState = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const requestId = workspaceRefreshRequestIdRef.current + 1;
		workspaceRefreshRequestIdRef.current = requestId;
		const requestedProjectId = currentProjectId;
		setIsWorkspaceStateRefreshing(true);
		try {
			const refreshed = await fetchWorkspaceState(requestedProjectId);
			if (
				workspaceRefreshRequestIdRef.current !== requestId ||
				workspaceVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			applyWorkspaceState(refreshed);
		} catch (error) {
			if (
				workspaceRefreshRequestIdRef.current !== requestId ||
				workspaceVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			const message = toErrorMessage(error);
			notifyError(message);
		} finally {
			if (workspaceRefreshRequestIdRef.current === requestId) {
				setIsWorkspaceStateRefreshing(false);
			}
		}
	}, [applyWorkspaceState, currentProjectId]);

	const resetWorkspaceSyncState = useCallback(
		(targetProjectId?: string | null) => {
			const prevProjectId = workspaceVersionRef.current.projectId;
			const prevRevision = workspaceVersionRef.current.revision;
			if (prevProjectId && prevRevision != null) {
				stashProjectBoard(prevProjectId, {
					board: boardRef.current,
					sessions: sessionsRef.current,
					revision: prevRevision,
					workspacePath: workspacePath,
					workspaceGit: workspaceGit,
				});
			}

			workspaceRefreshRequestIdRef.current += 1;
			setCanPersistWorkspaceState(false);
			setIsWorkspaceStateRefreshing(false);
			setAppliedWorkspaceProjectId(null);

			const restoreId = targetProjectId ?? currentProjectId;
			const cached = restoreId ? restoreProjectBoard(restoreId) : null;
			if (cached) {
				setBoard(cached.board);
				setSessions(cached.sessions);
				setWorkspaceRevision(cached.revision);
				setWorkspacePath(cached.workspacePath);
				setStoreWorkspacePath(cached.workspacePath);
				setWorkspaceGit(cached.workspaceGit);
				workspaceVersionRef.current = {
					projectId: restoreId,
					revision: cached.revision,
				};
				setIsServedFromBoardCache(true);
			} else {
				setWorkspaceRevision(null);
				workspaceVersionRef.current = {
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
			workspaceGit,
			workspacePath,
		],
	);

	useEffect(() => {
		if (hasNoProjects) {
			applyWorkspaceState(null);
			return;
		}
		if (!streamedWorkspaceState) {
			return;
		}
		applyWorkspaceState(streamedWorkspaceState);
	}, [applyWorkspaceState, hasNoProjects, streamedWorkspaceState]);

	useEffect(() => {
		if (!hasReceivedSnapshot || !isDocumentVisible) {
			return;
		}
		void refreshWorkspaceState();
	}, [hasReceivedSnapshot, isDocumentVisible, refreshWorkspaceState]);

	return {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		isServedFromBoardCache,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	};
}
