import { normalizeDiagnosticErrorClass } from "@runtime-contract";
import { useEffect, useRef, useState } from "react";
import { recordBrowserEvent, updateBrowserSnapshotContext } from "@/diagnostics";
import { ProjectStateConflictError } from "@/runtime/project-state-query";
import type { RuntimeProjectStateResponse, RuntimeProjectStateSaveRequest } from "@/runtime/types";
import type { BoardData } from "@/types";

const PROJECT_STATE_PERSIST_DEBOUNCE_MS = 120;

export interface UseProjectPersistenceParams {
	board: BoardData;
	currentProjectId: string | null;
	projectRevision: number | null;
	hydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	canPersistProjectState: boolean;
	isDocumentVisible: boolean;
	isProjectStateRefreshing: boolean;
	persistProjectState: (input: {
		projectId: string;
		payload: RuntimeProjectStateSaveRequest;
	}) => Promise<RuntimeProjectStateResponse>;
	refetchProjectState: () => Promise<unknown>;
	onProjectRevisionChange: (revision: number) => void;
	onProjectStateConflict?: (input: { projectId: string; currentRevision: number }) => void;
}

export function useProjectPersistence({
	board,
	currentProjectId,
	projectRevision,
	hydrationNonce,
	shouldSkipPersistOnHydration,
	canPersistProjectState,
	isDocumentVisible,
	isProjectStateRefreshing,
	persistProjectState,
	refetchProjectState,
	onProjectRevisionChange,
	onProjectStateConflict,
}: UseProjectPersistenceParams): void {
	const [persistCycle, setPersistCycle] = useState(0);
	const skipNextPersistRef = useRef(false);
	const latestHydrationNonceRef = useRef(hydrationNonce);
	const latestPersistRequestIdRef = useRef(0);
	const persistInFlightRef = useRef(false);
	const persistQueuedRef = useRef(false);
	const currentProjectIdRef = useRef<string | null>(currentProjectId);
	const lastPersistedBoardRef = useRef<BoardData | null>(null);
	const lastPersistedProjectIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentProjectIdRef.current = currentProjectId;
		if (lastPersistedProjectIdRef.current !== currentProjectId) {
			lastPersistedProjectIdRef.current = currentProjectId;
			lastPersistedBoardRef.current = null;
		}
	}, [currentProjectId]);

	useEffect(() => {
		if (latestHydrationNonceRef.current === hydrationNonce) {
			return;
		}
		latestHydrationNonceRef.current = hydrationNonce;
		skipNextPersistRef.current = shouldSkipPersistOnHydration;
		lastPersistedProjectIdRef.current = currentProjectId;
		lastPersistedBoardRef.current = shouldSkipPersistOnHydration ? board : null;
	}, [board, currentProjectId, hydrationNonce, shouldSkipPersistOnHydration]);

	useEffect(() => {
		if (!canPersistProjectState || !isDocumentVisible || isProjectStateRefreshing || projectRevision == null) {
			return;
		}
		if (persistInFlightRef.current) {
			persistQueuedRef.current = true;
			recordBrowserEvent(
				"browser.project_persist_queued",
				{ expectedRevision: projectRevision },
				{ projectId: currentProjectId ?? undefined },
			);
			return;
		}
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false;
			return;
		}
		if (
			currentProjectId != null &&
			lastPersistedProjectIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board
		) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			const requestId = latestPersistRequestIdRef.current + 1;
			latestPersistRequestIdRef.current = requestId;
			const persistProjectId = currentProjectId;
			if (!persistProjectId) {
				return;
			}
			const payload: RuntimeProjectStateSaveRequest = {
				board,
				expectedRevision: projectRevision,
			};
			recordBrowserEvent(
				"browser.project_persist_started",
				{ expectedRevision: projectRevision },
				{ projectId: persistProjectId },
				{ essential: false },
			);
			void (async () => {
				persistInFlightRef.current = true;
				updateBrowserSnapshotContext({ pendingProjectPersistence: true });
				try {
					const saved = await persistProjectState({
						projectId: persistProjectId,
						payload,
					});
					if (
						requestId !== latestPersistRequestIdRef.current ||
						currentProjectIdRef.current !== persistProjectId
					) {
						return;
					}
					lastPersistedProjectIdRef.current = persistProjectId;
					lastPersistedBoardRef.current = board;
					onProjectRevisionChange(saved.revision);
					recordBrowserEvent(
						"browser.project_persist_completed",
						{ expectedRevision: projectRevision, savedRevision: saved.revision },
						{ projectId: persistProjectId },
						{ essential: false },
					);
				} catch (error) {
					if (error instanceof ProjectStateConflictError) {
						recordBrowserEvent(
							"browser.project_persist_conflict",
							{ expectedRevision: projectRevision, currentRevision: error.currentRevision },
							{ projectId: persistProjectId },
							{ level: "warn", essential: true },
						);
						if (
							requestId === latestPersistRequestIdRef.current &&
							currentProjectIdRef.current === persistProjectId
						) {
							onProjectRevisionChange(error.currentRevision);
							onProjectStateConflict?.({
								projectId: persistProjectId,
								currentRevision: error.currentRevision,
							});
						}
						if (currentProjectIdRef.current !== persistProjectId) {
							return;
						}
						await refetchProjectState();
						return;
					}
					recordBrowserEvent(
						"browser.project_persist_failed",
						{
							expectedRevision: projectRevision,
							errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						},
						{ projectId: persistProjectId },
						{ level: "warn", essential: true },
					);
					// Keep the UI usable even if persistence is temporarily unavailable.
				} finally {
					persistInFlightRef.current = false;
					updateBrowserSnapshotContext({ pendingProjectPersistence: false });
					if (persistQueuedRef.current) {
						persistQueuedRef.current = false;
						setPersistCycle((current) => current + 1);
					}
				}
			})();
		}, PROJECT_STATE_PERSIST_DEBOUNCE_MS);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [
		board,
		canPersistProjectState,
		currentProjectId,
		isDocumentVisible,
		isProjectStateRefreshing,
		onProjectRevisionChange,
		persistCycle,
		persistProjectState,
		refetchProjectState,
		onProjectStateConflict,
		projectRevision,
	]);
}
