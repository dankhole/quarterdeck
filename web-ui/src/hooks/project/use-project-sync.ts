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
	mergeTaskSessionSummaries,
	type ProjectVersion,
	shouldApplyProjectUpdate,
	shouldHydrateBoard,
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
	isProjectStateRefreshing: boolean;
	isProjectMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	refreshProjectState: () => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
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
	const [projectHydrationNonce, setProjectHydrationNonce] = useState(0);
	const [isProjectStateRefreshing, setIsProjectStateRefreshing] = useState(false);
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

	const applyProjectState = useCallback(
		(nextProjectState: RuntimeProjectStateResponse | null) => {
			if (!nextProjectState) {
				setCanPersistProjectState(false);
				setProjectPath(null);
				setStoreProjectPath(null);
				setProjectGit(null);
				setAppliedProjectId(null);
				setBoard(createInitialBoardData());
				setSessions({});
				setProjectRevision(null);
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
			setStoreProjectPath(nextProjectState.repoPath);
			setProjectGit(nextProjectState.git);
			setSessions((currentSessions) => {
				const incomingSessions = nextProjectState.sessions ?? {};
				return mergeTaskSessionSummaries(currentSessions, incomingSessions);
			});
			const normalizedBoard = normalizeBoardData(nextProjectState.board) ?? createInitialBoardData();
			if (shouldHydrateBoard(projectVersionRef.current, currentProjectId, nextProjectState.revision)) {
				setBoard(normalizedBoard);
				setProjectHydrationNonce((current) => current + 1);
			}
			setProjectRevision(nextProjectState.revision);
			projectVersionRef.current = {
				projectId: currentProjectId,
				revision: nextProjectState.revision,
			};
			setAppliedProjectId(currentProjectId);
			setCanPersistProjectState(true);
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
				projectVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			applyProjectState(refreshed);
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
				setIsProjectStateRefreshing(false);
			}
		}
	}, [applyProjectState, currentProjectId]);

	const resetProjectSyncState = useCallback(
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
			setCanPersistProjectState(false);
			setIsProjectStateRefreshing(false);
			setAppliedProjectId(null);

			const restoreId = targetProjectId ?? currentProjectId;
			const cached = restoreId ? restoreProjectBoard(restoreId) : null;
			if (cached) {
				setBoard(cached.board);
				setSessions(cached.sessions);
				setProjectRevision(cached.revision);
				setProjectPath(cached.projectPath);
				setStoreProjectPath(cached.projectPath);
				setProjectGit(cached.projectGit);
				projectVersionRef.current = {
					projectId: restoreId,
					revision: cached.revision,
				};
				setIsServedFromBoardCache(true);
			} else {
				setProjectRevision(null);
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
		projectHydrationNonce,
		isProjectStateRefreshing,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
	};
}
