import { useMemo } from "react";
import { getTaskAgentNavbarHint } from "@/runtime/native-agent";
import type { RuntimeConfigResponse, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import type { CardSelection, ReviewTaskWorkspaceSnapshot } from "@/types";

interface UseNavbarStateInput {
	selectedCard: CardSelection | null;
	selectedTaskWorkspaceInfo: RuntimeTaskWorkspaceInfoResponse | null;
	selectedTaskWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | null;
	workspacePath: string | null;
	shouldUseNavigationPath: boolean;
	navigationProjectPath: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	isAwaitingWorkspaceSnapshot: boolean;
	isWorkspaceMetadataPending: boolean;
}

interface UseNavbarStateResult {
	activeWorkspacePath: string | undefined;
	activeWorkspaceHint: string | undefined;
	navbarWorkspacePath: string | undefined;
	navbarWorkspaceHint: string | undefined;
	navbarRuntimeHint: string | undefined;
	shouldHideProjectDependentTopBarActions: boolean;
}

/**
 * Derives top-bar display values from the current selection state, workspace
 * info, and project configuration.
 */
export function useNavbarState({
	selectedCard,
	selectedTaskWorkspaceInfo,
	selectedTaskWorkspaceSnapshot,
	workspacePath,
	shouldUseNavigationPath,
	navigationProjectPath,
	runtimeProjectConfig,
	hasNoProjects,
	isProjectSwitching,
	isAwaitingWorkspaceSnapshot,
	isWorkspaceMetadataPending,
}: UseNavbarStateInput): UseNavbarStateResult {
	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeWorkspacePath = selectedCard
		? (selectedTaskWorkspaceInfo?.path ?? selectedTaskWorkspaceSnapshot?.path ?? workspacePath ?? undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (workspacePath ?? undefined);

	const activeWorkspaceHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		if (!selectedTaskWorkspaceInfo) {
			return undefined;
		}
		if (!selectedTaskWorkspaceInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task workspace deleted" : "Task workspace not created yet";
		}
		return undefined;
	}, [selectedCard, selectedTaskWorkspaceInfo]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending);

	return {
		activeWorkspacePath,
		activeWorkspaceHint,
		navbarWorkspacePath,
		navbarWorkspaceHint,
		navbarRuntimeHint,
		shouldHideProjectDependentTopBarActions,
	};
}
