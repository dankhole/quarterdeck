import { createContext, useContext } from "react";

import type { UseProjectNavigationResult } from "@/hooks/use-project-navigation";
import type { UseStartupOnboardingResult } from "@/hooks/use-startup-onboarding";
import type { RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Context value — project-level state: navigation, runtime config, onboarding,
// access gate, and config-derived values + mutation callbacks.
//
// The value is constructed in App.tsx and provided inline via
// <ProjectContext.Provider>. This file owns the context shape and consumer
// hook so child components can read project state without prop drilling.
// ---------------------------------------------------------------------------

export interface ProjectContextValue {
	// --- useProjectNavigation ---
	currentProjectId: UseProjectNavigationResult["currentProjectId"];
	projects: UseProjectNavigationResult["projects"];
	streamedWorkspaceState: UseProjectNavigationResult["workspaceState"];
	workspaceMetadata: UseProjectNavigationResult["workspaceMetadata"];
	notificationSessions: UseProjectNavigationResult["notificationSessions"];
	notificationWorkspaceIds: UseProjectNavigationResult["notificationWorkspaceIds"];
	latestTaskReadyForReview: UseProjectNavigationResult["latestTaskReadyForReview"];
	latestTaskTitleUpdate: UseProjectNavigationResult["latestTaskTitleUpdate"];
	logLevel: UseProjectNavigationResult["logLevel"];
	debugLogEntries: UseProjectNavigationResult["debugLogEntries"];
	streamError: UseProjectNavigationResult["streamError"];
	isRuntimeDisconnected: UseProjectNavigationResult["isRuntimeDisconnected"];
	hasReceivedSnapshot: UseProjectNavigationResult["hasReceivedSnapshot"];
	navigationCurrentProjectId: UseProjectNavigationResult["navigationCurrentProjectId"];
	removingProjectId: UseProjectNavigationResult["removingProjectId"];
	hasNoProjects: UseProjectNavigationResult["hasNoProjects"];
	isProjectSwitching: UseProjectNavigationResult["isProjectSwitching"];
	handleSelectProject: UseProjectNavigationResult["handleSelectProject"];
	handlePreloadProject: UseProjectNavigationResult["handlePreloadProject"];
	handleAddProject: UseProjectNavigationResult["handleAddProject"];
	handleConfirmInitializeGitProject: UseProjectNavigationResult["handleConfirmInitializeGitProject"];
	handleCancelInitializeGitProject: UseProjectNavigationResult["handleCancelInitializeGitProject"];
	handleRemoveProject: UseProjectNavigationResult["handleRemoveProject"];
	handleReorderProjects: UseProjectNavigationResult["handleReorderProjects"];
	pendingGitInitializationPath: UseProjectNavigationResult["pendingGitInitializationPath"];
	isInitializingGitProject: UseProjectNavigationResult["isInitializingGitProject"];
	resetProjectNavigationState: UseProjectNavigationResult["resetProjectNavigationState"];

	// --- Runtime project config (current project) ---
	runtimeProjectConfig: RuntimeConfigResponse | null;
	isRuntimeProjectConfigLoading: boolean;
	refreshRuntimeProjectConfig: () => void;

	// --- Runtime project config (settings scope — may differ during project switch) ---
	settingsRuntimeProjectConfig: RuntimeConfigResponse | null;
	refreshSettingsRuntimeProjectConfig: () => void;

	// --- useStartupOnboarding ---
	isStartupOnboardingDialogOpen: UseStartupOnboardingResult["isStartupOnboardingDialogOpen"];
	handleOpenStartupOnboardingDialog: UseStartupOnboardingResult["handleOpenStartupOnboardingDialog"];
	handleCloseStartupOnboardingDialog: UseStartupOnboardingResult["handleCloseStartupOnboardingDialog"];
	handleSelectOnboardingAgent: UseStartupOnboardingResult["handleSelectOnboardingAgent"];

	// --- useQuarterdeckAccessGate ---
	isQuarterdeckAccessBlocked: boolean;

	// --- Derived values from config ---
	isTaskAgentReady: boolean | null;
	settingsWorkspaceId: string | null;
	llmConfigured: boolean;
	isLlmGenerationDisabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	selectedShortcutLabel: string | null;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	skipCherryPickConfirmation: boolean;
	pinnedBranches: string[];
	showTrashWorktreeNotice: boolean;
	unmergedChangesIndicatorEnabled: boolean;
	behindBaseIndicatorEnabled: boolean;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: { permission: boolean; review: boolean; failure: boolean };
	audibleNotificationsOnlyWhenHidden: boolean;
	audibleNotificationSuppressCurrentProject: { permission: boolean; review: boolean; failure: boolean };
	terminalFontWeight: number;
	terminalWebGLRenderer: boolean;
	agentCommand: string | null;
	configDefaultBaseRef: string;

	// --- Config mutation callbacks ---
	handleTogglePinBranch: (branchName: string) => void;
	handleSkipTaskCheckoutConfirmationChange: (skip: boolean) => void;
	handleSetDefaultBaseRef: (value: string | null) => Promise<void>;
	saveTrashWorktreeNoticeDismissed: () => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
	const ctx = useContext(ProjectContext);
	if (!ctx) {
		throw new Error("useProjectContext must be used within a ProjectContext.Provider");
	}
	return ctx;
}
