import { useCallback, useEffect, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import {
	isDirectoryPickerUnavailableErrorMessage,
	promptForManualProjectPath,
} from "@/hooks/project/project-navigation";
import { preloadProjectState } from "@/runtime/project-preload-cache";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDebugLogEntry,
	RuntimeProjectMetadata,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type {
	TaskBaseRefUpdate,
	TaskTitleUpdate,
	TaskWorkingDirectoryUpdate,
} from "@/runtime/use-runtime-state-stream";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { buildProjectPathname, parseProjectIdFromPathname } from "@/utils/app-utils";
import { useWindowEvent } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";

export {
	isDirectoryPickerUnavailableErrorMessage,
	parseRemovedProjectPathFromStreamError,
} from "@/hooks/project/project-navigation";

interface UseProjectNavigationInput {
	onProjectSwitchStart: () => void;
}

export interface UseProjectNavigationResult {
	requestedProjectId: string | null;
	navigationCurrentProjectId: string | null;
	removingProjectId: string | null;
	pendingGitInitializationPath: string | null;
	isInitializingGitProject: boolean;
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	projectState: RuntimeProjectStateResponse | null;
	projectMetadata: RuntimeProjectMetadata | null;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	latestTaskTitleUpdate: TaskTitleUpdate | null;
	latestTaskBaseRefUpdate: TaskBaseRefUpdate | null;
	latestTaskWorkingDirectoryUpdate: TaskWorkingDirectoryUpdate | null;
	logLevel: "debug" | "info" | "warn" | "error";
	debugLogEntries: RuntimeDebugLogEntry[];
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	notificationWorkspaceIds: Record<string, string>;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	handleSelectProject: (projectId: string) => void;
	handlePreloadProject: (projectId: string) => void;
	handleAddProject: () => Promise<void>;
	handleConfirmInitializeGitProject: () => Promise<void>;
	handleCancelInitializeGitProject: () => void;
	handleRemoveProject: (projectId: string) => Promise<boolean>;
	handleReorderProjects: (projectOrder: string[]) => Promise<void>;
	resetProjectNavigationState: () => void;
}

export function useProjectNavigation({ onProjectSwitchStart }: UseProjectNavigationInput): UseProjectNavigationResult {
	const [requestedProjectId, setRequestedProjectId] = useState<string | null>(() => {
		if (typeof window === "undefined") {
			return null;
		}
		return parseProjectIdFromPathname(window.location.pathname);
	});
	const [pendingAddedProjectId, setPendingAddedProjectId] = useState<string | null>(null);
	const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
	const [pendingGitInitializationPath, setPendingGitInitializationPath] = useState<string | null>(null);
	const [isInitializingGitProject, setIsInitializingGitProject] = useState(false);

	const {
		currentProjectId,
		projects,
		projectState,
		projectMetadata,
		notificationSessions,
		notificationWorkspaceIds,
		latestTaskReadyForReview,
		latestTaskTitleUpdate,
		latestTaskBaseRefUpdate,
		latestTaskWorkingDirectoryUpdate,
		logLevel,
		debugLogEntries,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
	} = useRuntimeStateStream(requestedProjectId);

	const hasNoProjects = hasReceivedSnapshot && projects.length === 0 && currentProjectId === null;
	const isProjectSwitching = requestedProjectId !== null && requestedProjectId !== currentProjectId && !hasNoProjects;
	const navigationCurrentProjectId = requestedProjectId ?? currentProjectId;

	const handleSelectProject = useCallback(
		(projectId: string) => {
			if (!projectId || projectId === currentProjectId) {
				return;
			}
			onProjectSwitchStart();
			setRequestedProjectId(projectId);
		},
		[currentProjectId, onProjectSwitchStart],
	);

	const handlePreloadProject = useCallback(
		(projectId: string) => {
			if (!projectId || projectId === currentProjectId) {
				return;
			}
			preloadProjectState(projectId);
		},
		[currentProjectId],
	);

	const addProjectByPath = useCallback(
		async (path: string, initializeGit = false) => {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const added = await trpcClient.projects.add.mutate({
				path,
				initializeGit,
			});
			if (!added.ok || !added.project) {
				if (added.requiresGitInitialization) {
					setPendingGitInitializationPath(path);
					return;
				}
				throw new Error(added.error ?? "Could not add project.");
			}
			setPendingGitInitializationPath(null);
			setPendingAddedProjectId(added.project.id);
			handleSelectProject(added.project.id);
		},
		[currentProjectId, handleSelectProject],
	);

	const handleAddProject = useCallback(async () => {
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const picked = await trpcClient.projects.pickDirectory.mutate();

			let projectPath: string | null = null;
			if (picked.ok && picked.path) {
				projectPath = picked.path;
			} else if (!picked.ok && picked.error === "No directory was selected.") {
				return;
			} else if (!picked.ok && isDirectoryPickerUnavailableErrorMessage(picked.error)) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "Directory picker unavailable on this runtime. Enter the project path manually.",
					timeout: 5000,
				});
				projectPath = promptForManualProjectPath();
				if (!projectPath) {
					return;
				}
			} else {
				throw new Error(picked.error ?? "Could not pick project directory.");
			}
			if (!projectPath) {
				return;
			}
			await addProjectByPath(projectPath);
		} catch (error) {
			const message = toErrorMessage(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		}
	}, [addProjectByPath, currentProjectId]);

	const handleConfirmInitializeGitProject = useCallback(async () => {
		if (!pendingGitInitializationPath || isInitializingGitProject) {
			return;
		}
		setIsInitializingGitProject(true);
		try {
			await addProjectByPath(pendingGitInitializationPath, true);
		} catch (error) {
			const message = toErrorMessage(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		} finally {
			setIsInitializingGitProject(false);
		}
	}, [addProjectByPath, isInitializingGitProject, pendingGitInitializationPath]);

	const handleCancelInitializeGitProject = useCallback(() => {
		if (isInitializingGitProject) {
			return;
		}
		setPendingGitInitializationPath(null);
	}, [isInitializingGitProject]);

	const handleRemoveProject = useCallback(
		async (projectId: string): Promise<boolean> => {
			if (removingProjectId) {
				return false;
			}
			setRemovingProjectId(projectId);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.projects.remove.mutate({ projectId });
				if (!payload.ok) {
					throw new Error(payload.error ?? "Could not remove project.");
				}
				if (currentProjectId === projectId) {
					onProjectSwitchStart();
					setRequestedProjectId(null);
				}
				return true;
			} catch (error) {
				const message = toErrorMessage(error);
				notifyError(message);
				return false;
			} finally {
				setRemovingProjectId((current) => (current === projectId ? null : current));
			}
		},
		[currentProjectId, onProjectSwitchStart, removingProjectId],
	);

	const handlePopState = useCallback(() => {
		if (typeof window === "undefined") {
			return;
		}
		const nextProjectId = parseProjectIdFromPathname(window.location.pathname);
		setRequestedProjectId(nextProjectId);
	}, []);
	useWindowEvent("popstate", handlePopState);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!currentProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		const nextPathname = buildProjectPathname(currentProjectId);
		if (nextUrl.pathname === nextPathname) {
			return;
		}
		window.history.replaceState({}, "", `${nextPathname}${nextUrl.search}${nextUrl.hash}`);
	}, [currentProjectId]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!hasNoProjects || !requestedProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		if (nextUrl.pathname !== "/") {
			window.history.replaceState({}, "", `/${nextUrl.search}${nextUrl.hash}`);
		}
		setRequestedProjectId(null);
	}, [hasNoProjects, requestedProjectId]);

	useEffect(() => {
		if (!pendingAddedProjectId) {
			return;
		}
		const projectExists = projects.some((project) => project.id === pendingAddedProjectId);
		if (!projectExists && currentProjectId !== pendingAddedProjectId) {
			return;
		}
		setPendingAddedProjectId(null);
	}, [currentProjectId, pendingAddedProjectId, projects]);

	useEffect(() => {
		if (!requestedProjectId || !currentProjectId) {
			return;
		}
		if (pendingAddedProjectId && requestedProjectId === pendingAddedProjectId) {
			return;
		}
		const requestedStillExists = projects.some((project) => project.id === requestedProjectId);
		if (requestedStillExists) {
			return;
		}
		setRequestedProjectId(currentProjectId);
	}, [currentProjectId, pendingAddedProjectId, projects, requestedProjectId]);

	const handleReorderProjects = useCallback(
		async (projectOrder: string[]) => {
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.projects.reorder.mutate({ projectOrder });
				if (!result.ok) {
					throw new Error(result.error ?? "Could not reorder projects.");
				}
			} catch (error) {
				const message = toErrorMessage(error);
				notifyError(message);
			}
		},
		[currentProjectId],
	);

	const resetProjectNavigationState = useCallback(() => {
		setRemovingProjectId(null);
		setPendingGitInitializationPath(null);
		setIsInitializingGitProject(false);
	}, []);

	return {
		requestedProjectId,
		navigationCurrentProjectId,
		removingProjectId,
		pendingGitInitializationPath,
		isInitializingGitProject,
		currentProjectId,
		projects,
		projectState,
		projectMetadata,
		latestTaskReadyForReview,
		latestTaskTitleUpdate,
		latestTaskBaseRefUpdate,
		latestTaskWorkingDirectoryUpdate,
		logLevel,
		debugLogEntries,
		notificationSessions,
		notificationWorkspaceIds,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handlePreloadProject,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		handleReorderProjects,
		resetProjectNavigationState,
	};
}
