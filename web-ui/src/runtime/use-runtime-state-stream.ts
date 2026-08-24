import { useEffect, useReducer, useRef } from "react";
import { handleBrowserDiagnosticsStreamMessage } from "@/diagnostics";
import { consumeProjectPreload } from "@/runtime/project-preload-cache";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import {
	createInitialRuntimeStateStreamStore,
	type RuntimeStateStreamDomainAction,
	runtimeStateStreamReducer,
	type TaskBaseRefUpdate,
	type TaskTitleUpdate,
} from "@/runtime/runtime-state-stream-store";
import {
	type RuntimeStateStreamTransport,
	startRuntimeStateStreamTransport,
} from "@/runtime/runtime-state-stream-transport";
import { resolveStreamMessage } from "@/runtime/runtime-stream-dispatch";
import type {
	RuntimeProjectMetadata,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamTaskReadyForReviewMessage,
} from "@/runtime/types";

export type { TaskBaseRefUpdate, TaskTitleUpdate } from "@/runtime/runtime-state-stream-store";

export interface UseRuntimeStateStreamResult {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	projectState: RuntimeProjectStateResponse | null;
	projectMetadata: RuntimeProjectMetadata | null;
	notificationProjects: RuntimeProjectNotificationStateMap;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	latestTaskTitleUpdate: TaskTitleUpdate | null;
	latestTaskBaseRefUpdate: TaskBaseRefUpdate | null;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

export function useRuntimeStateStream(requestedProjectId: string | null): UseRuntimeStateStreamResult {
	const streamGenerationRef = useRef(0);
	const [state, dispatch] = useReducer(
		runtimeStateStreamReducer,
		requestedProjectId,
		createInitialRuntimeStateStreamStore,
	);

	useEffect(() => {
		const streamGeneration = streamGenerationRef.current + 1;
		streamGenerationRef.current = streamGeneration;
		let activeProjectId = requestedProjectId;
		let transport: RuntimeStateStreamTransport | null = null;
		const dispatchStreamAction = (action: RuntimeStateStreamDomainAction): void => {
			dispatch({ type: "stream_action", streamGeneration, action });
		};

		dispatch({
			type: "stream_generation_changed",
			streamGeneration,
			preloadedProjectState: requestedProjectId ? consumeProjectPreload(requestedProjectId) : null,
			requestedProjectId,
		});

		transport = startRuntimeStateStreamTransport(requestedProjectId, {
			onConnected: () => {
				dispatchStreamAction({ type: "stream_connected" });
			},
			onDisconnected: (message) => {
				dispatchStreamAction({
					type: "stream_disconnected",
					message,
				});
			},
			onMessage: (payload) => {
				if (handleBrowserDiagnosticsStreamMessage(payload)) {
					return;
				}
				const result = resolveStreamMessage(payload, {
					activeProjectId,
				});
				activeProjectId = result.nextActiveProjectId;
				for (const action of result.actions) {
					dispatchStreamAction(action);
				}
				if (result.reconnectProjectId) {
					dispatchStreamAction({
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
		streamError: state.streamError,
		isRuntimeDisconnected: state.isRuntimeDisconnected,
		hasReceivedSnapshot: state.hasReceivedSnapshot,
	};
}
