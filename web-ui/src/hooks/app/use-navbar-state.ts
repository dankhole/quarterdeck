import { useMemo } from "react";
import { getTaskAgentNavbarHint } from "@/runtime/native-agent";
import type { RuntimeConfigResponse, RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { CardSelection, ReviewTaskWorktreeSnapshot } from "@/types";
import { resolveTaskIdentity } from "@/utils/task-identity";

interface UseNavbarStateInput {
	selectedCard: CardSelection | null;
	selectedTaskRepositoryInfo: RuntimeTaskRepositoryInfoResponse | null;
	selectedTaskWorktreeSnapshot: ReviewTaskWorktreeSnapshot | null;
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
	openProjectPath: string | undefined;
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
	selectedTaskRepositoryInfo,
	selectedTaskWorktreeSnapshot,
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

	const selectedTaskIdentity = useMemo(
		() =>
			selectedCard
				? resolveTaskIdentity({
						projectRootPath: projectPath,
						card: selectedCard.card,
						repositoryInfo: selectedTaskRepositoryInfo,
						worktreeSnapshot: selectedTaskWorktreeSnapshot,
					})
				: null,
		[selectedCard, projectPath, selectedTaskRepositoryInfo, selectedTaskWorktreeSnapshot],
	);

	const activeProjectPath = selectedCard
		? (selectedTaskIdentity?.assignedPath ?? projectPath ?? undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (projectPath ?? undefined);
	const openProjectPath = selectedCard
		? selectedCard.card.useWorktree === false
			? (projectPath ?? undefined)
			: selectedTaskRepositoryInfo?.exists === true
				? (selectedTaskIdentity?.assignedPath ?? undefined)
				: undefined
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (projectPath ?? undefined);

	const activeProjectHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		if (selectedCard.card.useWorktree === false) {
			return undefined;
		}
		if (!selectedTaskRepositoryInfo) {
			return undefined;
		}
		if (!selectedTaskRepositoryInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task worktree deleted" : "Task worktree not created yet";
		}
		return undefined;
	}, [selectedCard, selectedTaskRepositoryInfo]);

	const navbarProjectPath = hasNoProjects ? undefined : activeProjectPath;
	const navbarProjectHint = hasNoProjects ? undefined : activeProjectHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		!selectedCard && (isProjectSwitching || isAwaitingProjectSnapshot || isProjectMetadataPending);

	return {
		activeProjectPath,
		openProjectPath,
		activeProjectHint,
		navbarProjectPath,
		navbarProjectHint,
		navbarRuntimeHint,
		shouldHideProjectDependentTopBarActions,
	};
}
