import type { ComponentProps } from "react";
import { useMemo } from "react";
import type { ProjectNavigationPanel } from "@/components/app";
import type { BoardData } from "@/types";
import { countTasksByColumn } from "@/utils/app-utils";

type ProjectSummaries = ComponentProps<typeof ProjectNavigationPanel>["projects"];

interface UseProjectUiStateInput {
	board: BoardData;
	canPersistProjectState: boolean;
	currentProjectId: string | null;
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
	board,
	canPersistProjectState,
	currentProjectId,
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
	const displayedProjects = useMemo(() => {
		if (!canPersistProjectState || !currentProjectId) {
			return projects;
		}
		const localCounts = countTasksByColumn(board);
		return projects.map((project) =>
			project.id === currentProjectId
				? {
						...project,
						taskCounts: localCounts,
					}
				: project,
		);
	}, [board, canPersistProjectState, currentProjectId, projects]);

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
