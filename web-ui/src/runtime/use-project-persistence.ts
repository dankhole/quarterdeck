import { useEffect, useRef, useState } from "react";
import { ProjectStateConflictError } from "@/runtime/project-state-query";
import type {
	RuntimeProjectStateResponse,
	RuntimeProjectStateSaveRequest,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { BoardData } from "@/types";

const WORKSPACE_STATE_PERSIST_DEBOUNCE_MS = 120;

export interface UseProjectPersistenceParams {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectId: string | null;
	projectRevision: number | null;
	hydrationNonce: number;
	canPersistProjectState: boolean;
	isDocumentVisible: boolean;
	isProjectStateRefreshing: boolean;
	persistWorkspaceState: (input: {
		projectId: string;
		payload: RuntimeProjectStateSaveRequest;
	}) => Promise<RuntimeProjectStateResponse>;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceRevisionChange: (revision: number) => void;
	onWorkspaceStateConflict?: (input: { projectId: string; currentRevision: number }) => void;
}

export function useProjectPersistence({
	board,
	sessions,
	currentProjectId,
	projectRevision,
	hydrationNonce,
	canPersistProjectState,
	isDocumentVisible,
	isProjectStateRefreshing,
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceRevisionChange,
	onWorkspaceStateConflict,
}: UseProjectPersistenceParams): void {
	const [persistCycle, setPersistCycle] = useState(0);
	const skipNextPersistRef = useRef(false);
	const latestHydrationNonceRef = useRef(hydrationNonce);
	const latestPersistRequestIdRef = useRef(0);
	const persistInFlightRef = useRef(false);
	const persistQueuedRef = useRef(false);
	const currentProjectIdRef = useRef<string | null>(currentProjectId);
	const sessionsRef = useRef(sessions);
	const lastPersistedBoardRef = useRef<BoardData | null>(null);
	const lastPersistedWorkspaceIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentProjectIdRef.current = currentProjectId;
		if (lastPersistedWorkspaceIdRef.current !== currentProjectId) {
			lastPersistedWorkspaceIdRef.current = currentProjectId;
			lastPersistedBoardRef.current = null;
		}
	}, [currentProjectId]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		if (latestHydrationNonceRef.current === hydrationNonce) {
			return;
		}
		latestHydrationNonceRef.current = hydrationNonce;
		skipNextPersistRef.current = true;
		lastPersistedWorkspaceIdRef.current = currentProjectId;
		lastPersistedBoardRef.current = board;
	}, [board, currentProjectId, hydrationNonce]);

	useEffect(() => {
		if (!canPersistProjectState || !isDocumentVisible || isProjectStateRefreshing || projectRevision == null) {
			return;
		}
		if (persistInFlightRef.current) {
			persistQueuedRef.current = true;
			return;
		}
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false;
			return;
		}
		if (
			currentProjectId != null &&
			lastPersistedWorkspaceIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board
		) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			const requestId = latestPersistRequestIdRef.current + 1;
			latestPersistRequestIdRef.current = requestId;
			const persistWorkspaceId = currentProjectId;
			if (!persistWorkspaceId) {
				return;
			}
			const payload: RuntimeProjectStateSaveRequest = {
				board,
				sessions: sessionsRef.current,
				expectedRevision: projectRevision,
			};
			void (async () => {
				persistInFlightRef.current = true;
				try {
					const saved = await persistWorkspaceState({
						projectId: persistWorkspaceId,
						payload,
					});
					if (
						requestId !== latestPersistRequestIdRef.current ||
						currentProjectIdRef.current !== persistWorkspaceId
					) {
						return;
					}
					lastPersistedWorkspaceIdRef.current = persistWorkspaceId;
					lastPersistedBoardRef.current = board;
					onWorkspaceRevisionChange(saved.revision);
				} catch (error) {
					if (error instanceof ProjectStateConflictError) {
						if (
							requestId === latestPersistRequestIdRef.current &&
							currentProjectIdRef.current === persistWorkspaceId
						) {
							onWorkspaceRevisionChange(error.currentRevision);
							onWorkspaceStateConflict?.({
								projectId: persistWorkspaceId,
								currentRevision: error.currentRevision,
							});
						}
						if (currentProjectIdRef.current !== persistWorkspaceId) {
							return;
						}
						await refetchWorkspaceState();
						return;
					}
					// Keep the UI usable even if persistence is temporarily unavailable.
				} finally {
					persistInFlightRef.current = false;
					if (persistQueuedRef.current) {
						persistQueuedRef.current = false;
						setPersistCycle((current) => current + 1);
					}
				}
			})();
		}, WORKSPACE_STATE_PERSIST_DEBOUNCE_MS);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [
		board,
		canPersistProjectState,
		currentProjectId,
		isDocumentVisible,
		isProjectStateRefreshing,
		onWorkspaceRevisionChange,
		persistCycle,
		persistWorkspaceState,
		refetchWorkspaceState,
		onWorkspaceStateConflict,
		projectRevision,
	]);
}
