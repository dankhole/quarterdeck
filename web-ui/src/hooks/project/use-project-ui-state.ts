import type { ComponentProps } from "react";
import { useMemo } from "react";
import type { ProjectNavigationPanel } from "@/components/app";

type ProjectSummaries = ComponentProps<typeof ProjectNavigationPanel>["projects"];

interface UseProjectUiStateInput {
	projects: ProjectSummaries;
	navigationCurrentProjectId: string | null;
	selectedTaskId: string | null;
	streamError: string | null;
	isProjectSwitching: boolean;
	isInitialRuntimeLoad: boolean;
	isAwaitingProjectSnapshot: boolean;
	isProjectMetadataPending: boolean;
	isServedFromBoardCache: boolean;
	hasReceivedSnapshot: boolean;
}

interface UseProjectUiStateResult {
	displayedProjects: ProjectSummaries;
	navigationProjectPath: string | null;
	shouldShowProjectLoadingState: boolean;
	isProjectListLoading: boolean;
	shouldUseNavigationPath: boolean;
}

export function useProjectUiState({
	projects,
	navigationCurrentProjectId,
	selectedTaskId,
	streamError,
	isProjectSwitching,
	isInitialRuntimeLoad,
	isAwaitingProjectSnapshot,
	isProjectMetadataPending,
	isServedFromBoardCache,
	hasReceivedSnapshot,
}: UseProjectUiStateInput): UseProjectUiStateResult {
	const displayedProjects = projects;

	const navigationProjectPath = useMemo(() => {
		if (!navigationCurrentProjectId) {
			return null;
		}
		return projects.find((project) => project.id === navigationCurrentProjectId)?.path ?? null;
	}, [navigationCurrentProjectId, projects]);

	const shouldShowProjectLoadingState =
		selectedTaskId === null &&
		!streamError &&
		!isServedFromBoardCache &&
		(isProjectSwitching || isInitialRuntimeLoad || isAwaitingProjectSnapshot || isProjectMetadataPending);
	const isProjectListLoading = !hasReceivedSnapshot && !streamError;
	const shouldUseNavigationPath = isProjectSwitching || isAwaitingProjectSnapshot || isProjectMetadataPending;

	return {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	};
}
