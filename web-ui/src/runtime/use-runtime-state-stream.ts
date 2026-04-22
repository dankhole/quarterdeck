import { useEffect, useReducer } from "react";
import { consumeProjectPreload } from "@/runtime/project-preload-cache";
import { resolveStreamMessage } from "@/runtime/runtime-stream-dispatch";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import {
	createInitialRuntimeStateStreamStore,
	runtimeStateStreamReducer,
	type TaskBaseRefUpdate,
	type TaskTitleUpdate,
	type TaskWorkingDirectoryUpdate,
} from "@/runtime/runtime-state-stream-store";
import {
	startRuntimeStateStreamTransport,
	type RuntimeStateStreamTransport,
} from "@/runtime/runtime-state-stream-transport";
import type {
	RuntimeDebugLogEntry,
	RuntimeProjectMetadata,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamTaskReadyForReviewMessage,
} from "@/runtime/types";

export type { TaskBaseRefUpdate, TaskTitleUpdate, TaskWorkingDirectoryUpdate } from "@/runtime/runtime-state-stream-store";

export interface UseRuntimeStateStreamResult {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	projectState: RuntimeProjectStateResponse | null;
	projectMetadata: RuntimeProjectMetadata | null;
	notificationProjects: RuntimeProjectNotificationStateMap;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	latestTaskTitleUpdate: TaskTitleUpdate | null;
	latestTaskBaseRefUpdate: TaskBaseRefUpdate | null;
	latestTaskWorkingDirectoryUpdate: TaskWorkingDirectoryUpdate | null;
	logLevel: "debug" | "info" | "warn" | "error";
	debugLogEntries: RuntimeDebugLogEntry[];
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

export function useRuntimeStateStream(requestedProjectId: string | null): UseRuntimeStateStreamResult {
	const [state, dispatch] = useReducer(
		runtimeStateStreamReducer,
		requestedProjectId,
		createInitialRuntimeStateStreamStore,
	);

	useEffect(() => {
		let activeProjectId = requestedProjectId;
		let transport: RuntimeStateStreamTransport | null = null;

		dispatch({
			type: "requested_project_changed",
			preloadedProjectState: requestedProjectId ? consumeProjectPreload(requestedProjectId) : null,
			requestedProjectId,
		});

		transport = startRuntimeStateStreamTransport(requestedProjectId, {
			onConnected: () => {
				dispatch({ type: "stream_connected" });
			},
			onDisconnected: (message) => {
				dispatch({
					type: "stream_disconnected",
					message,
				});
			},
			onMessage: (payload) => {
				const result = resolveStreamMessage(payload, {
					activeProjectId,
				});
				activeProjectId = result.nextActiveProjectId;
				for (const action of result.actions) {
					dispatch(action);
				}
				if (result.reconnectProjectId) {
					dispatch({
						type: "requested_project_changed",
						preloadedProjectState: null,
						requestedProjectId: result.reconnectProjectId,
					});
					transport?.switchProject(result.reconnectProjectId);
				}
			},
		});

		return () => {
			transport?.dispose();
		};
	}, [requestedProjectId]);

	return {
		currentProjectId: state.currentProjectId,
		projects: state.projects,
		projectState: state.projectState,
		projectMetadata: state.projectMetadata,
		notificationProjects: state.notificationMemory.projects,
		latestTaskReadyForReview: state.latestTaskReadyForReview,
		latestTaskTitleUpdate: state.latestTaskTitleUpdate,
		latestTaskBaseRefUpdate: state.latestTaskBaseRefUpdate,
		latestTaskWorkingDirectoryUpdate: state.latestTaskWorkingDirectoryUpdate,
		logLevel: state.logLevel,
		debugLogEntries: state.debugLogEntries,
		streamError: state.streamError,
		isRuntimeDisconnected: state.isRuntimeDisconnected,
		hasReceivedSnapshot: state.hasReceivedSnapshot,
	};
}
