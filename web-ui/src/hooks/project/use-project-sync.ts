import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { restoreProjectBoard, stashProjectBoard, updateProjectBoardCache } from "@/runtime/project-board-cache";
import { fetchProjectState } from "@/runtime/project-state-query";
import type { RuntimeGitRepositoryInfo, RuntimeProjectStateResponse } from "@/runtime/types";
import { setProjectPath as setStoreProjectPath } from "@/stores/project-metadata-store";
import { toErrorMessage } from "@/utils/to-error-message";

import {
	applyAuthoritativeProjectState,
	type CachedProjectBoardRestore,
	type ProjectBoardSessionsState,
	type ProjectVersion,
} from "./project-sync";

interface UseProjectSyncInput {
	currentProjectId: string | null;
	streamedProjectState: RuntimeProjectStateResponse | null;
	hasNoProjects: boolean;
	hasReceivedSnapshot: boolean;
	isDocumentVisible: boolean;
	projectBoardSessionsRef: MutableRefObject<ProjectBoardSessionsState>;
	setProjectBoardSessions: Dispatch<SetStateAction<ProjectBoardSessionsState>>;
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
	projectBoardSessionsRef,
	setProjectBoardSessions,
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
				setProjectBoardSessions({
					board: createInitialBoardData(),
					sessions: {},
				});
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
			setProjectPath(nextProjectState.repoPath);
			setStoreProjectPath(nextProjectState.repoPath);
			setProjectGit(nextProjectState.git);
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
				return;
			}
			setProjectBoardSessions(applyResult.nextState);
			if (applyResult.shouldBumpHydrationNonce) {
				setProjectHydrationState((current) => ({
					nonce: current.nonce + 1,
					shouldSkipPersistOnHydration: applyResult.shouldSkipPersistOnHydration,
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
					board: applyResult.boardForCache,
					sessions: applyResult.nextState.sessions,
					authoritativeRevision: nextProjectState.revision,
					projectPath: nextProjectState.repoPath,
					projectGit: nextProjectState.git,
				});
			}
		},
		[currentProjectId, setCanPersistProjectState, setProjectBoardSessions],
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
					board: projectBoardSessionsRef.current.board,
					sessions: projectBoardSessionsRef.current.sessions,
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
				setProjectBoardSessions({
					board: cached.board,
					sessions: cached.sessions,
				});
				setProjectPath(cached.projectPath);
				setStoreProjectPath(cached.projectPath);
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
				setProjectPath(null);
				setStoreProjectPath(null);
				setProjectGit(null);
				setIsServedFromBoardCache(false);
			}
		},
		[currentProjectId, setCanPersistProjectState, setProjectBoardSessions, projectGit, projectPath],
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
