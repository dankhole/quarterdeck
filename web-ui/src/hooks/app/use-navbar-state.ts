import { useMemo } from "react";
import { getTaskAgentNavbarHint } from "@/runtime/native-agent";
import type { RuntimeConfigResponse, RuntimeTaskWorktreeInfoResponse } from "@/runtime/types";
import type { CardSelection, ReviewTaskProjectSnapshot } from "@/types";

interface UseNavbarStateInput {
	selectedCard: CardSelection | null;
	selectedTaskWorktreeInfo: RuntimeTaskWorktreeInfoResponse | null;
	selectedTaskProjectSnapshot: ReviewTaskProjectSnapshot | null;
	projectPath: string | null;
	shouldUseNavigationPath: boolean;
	navigationProjectPath: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	isAwaitingProjectSnapshot: boolean;
	isProjectMetadataPending: boolean;
}

interface UseNavbarStateResult {
	activeProjectPath: string | undefined;
	activeProjectHint: string | undefined;
	navbarProjectPath: string | undefined;
	navbarProjectHint: string | undefined;
	navbarRuntimeHint: string | undefined;
	shouldHideProjectDependentTopBarActions: boolean;
}

/**
 * Derives top-bar display values from the current selection state, project
 * info, and project configuration.
 */
export function useNavbarState({
	selectedCard,
	selectedTaskWorktreeInfo,
	selectedTaskProjectSnapshot,
	projectPath,
	shouldUseNavigationPath,
	navigationProjectPath,
	runtimeProjectConfig,
	hasNoProjects,
	isProjectSwitching,
	isAwaitingProjectSnapshot,
	isProjectMetadataPending,
}: UseNavbarStateInput): UseNavbarStateResult {
	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeProjectPath = selectedCard
		? (selectedTaskWorktreeInfo?.path ?? selectedTaskProjectSnapshot?.path ?? projectPath ?? undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (projectPath ?? undefined);

	const activeProjectHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		if (!selectedTaskWorktreeInfo) {
			return undefined;
		}
		if (!selectedTaskWorktreeInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task worktree deleted" : "Task worktree not created yet";
		}
		return undefined;
	}, [selectedCard, selectedTaskWorktreeInfo]);

	const navbarProjectPath = hasNoProjects ? undefined : activeProjectPath;
	const navbarProjectHint = hasNoProjects ? undefined : activeProjectHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		!selectedCard && (isProjectSwitching || isAwaitingProjectSnapshot || isProjectMetadataPending);

	return {
		activeProjectPath,
		activeProjectHint,
		navbarProjectPath,
		navbarProjectHint,
		navbarRuntimeHint,
		shouldHideProjectDependentTopBarActions,
	};
}
