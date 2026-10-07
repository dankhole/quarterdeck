import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "@runtime-contract";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { handleBrowserDiagnosticsStreamMessage, recordBrowserEvent } from "@/diagnostics";
import { invalidateProjectBoardCache } from "@/runtime/project-board-cache";
import { consumeProjectPreload, invalidateProjectPreload } from "@/runtime/project-preload-cache";
import { applyRuntimeNotificationPresentation } from "@/runtime/runtime-notification-presentation";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import { resolveRuntimeProtocolCompatibility } from "@/runtime/runtime-protocol-compatibility";
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
	ProjectOrganization,
	RuntimeProjectMetadata,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamTaskReadyForReviewMessage,
} from "@/runtime/types";

export type { TaskBaseRefUpdate, TaskTitleUpdate } from "@/runtime/runtime-state-stream-store";

export interface UseRuntimeStateStreamResult {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	organization: ProjectOrganization | null;
	applyOrganization: (organization: ProjectOrganization) => void;
	applyProjectManagementResult: (project: RuntimeProjectSummary, state?: RuntimeProjectStateResponse) => void;
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
	const previousProjects = useRef<RuntimeProjectSummary[]>([]);
	useLayoutEffect(() => {
		const previousById = new Map(previousProjects.current.map((project) => [project.id, project]));
		for (const project of state.projects) {
			const previous = previousById.get(project.id);
			if (
				previous &&
				(previous.path !== project.path ||
					(previous.availability?.status ?? "available") !== (project.availability?.status ?? "available"))
			) {
				invalidateProjectPreload(project.id);
				invalidateProjectBoardCache(project.id);
			}
		}
		previousProjects.current = state.projects;
	}, [state.projects]);

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
				if (payload.type === "snapshot") {
					const compatibility = resolveRuntimeProtocolCompatibility(
						payload.runtimeProtocolVersion,
						QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
						() => sessionStorage,
					);
					if (compatibility !== "compatible") {
						recordBrowserEvent(
							"browser.runtime_protocol_mismatch",
							{
								action: compatibility,
								browserBuildId: __QUARTERDECK_BUILD_ID__,
								runtimeBuildId: payload.runtimeBuildId ?? null,
								browserProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
								runtimeProtocolVersion: payload.runtimeProtocolVersion ?? null,
							},
							{},
							{ level: compatibility === "reload" ? "warn" : "error", essential: true },
						);
						transport?.dispose();
						dispatchStreamAction({
							type: "stream_disconnected",
							message:
								compatibility === "reload"
									? "Quarterdeck's browser and runtime are incompatible. Reloading this page to load a compatible browser application."
									: "Quarterdeck's browser and runtime are incompatible. Restart Quarterdeck and refresh this page.",
						});
						if (compatibility === "reload") {
							window.location.reload();
						}
						return;
					}
					transport?.acceptCurrentConnection();
					applyRuntimeNotificationPresentation(payload.notificationPresentation);
				}
				if (payload.type === "notification_presentation") {
					applyRuntimeNotificationPresentation(payload.state);
					return;
				}
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

	const applyOrganization = useCallback(
		(organization: ProjectOrganization) => dispatch({ type: "organization_updated", organization }),
		[],
	);
	const applyProjectManagementResult = useCallback(
		(project: RuntimeProjectSummary, projectState?: RuntimeProjectStateResponse) => {
			dispatch({ type: "project_management_updated", project, projectState });
		},
		[],
	);
	return {
		currentProjectId: state.currentProjectId,
		projects: state.projects,
		organization: state.organization,
		applyOrganization,
		applyProjectManagementResult,
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
