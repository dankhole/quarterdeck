import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import { useDocumentVisibility } from "@/hooks/notifications/use-document-visibility";
import type { UseProjectNavigationResult } from "@/hooks/project/use-project-navigation";
import { useProjectNavigation } from "@/hooks/project/use-project-navigation";
import { useQuarterdeckAccessGate } from "@/hooks/project/use-quarterdeck-access-gate";
import type { UseStartupOnboardingResult } from "@/hooks/project/use-startup-onboarding";
import { useStartupOnboarding } from "@/hooks/project/use-startup-onboarding";
import { useWorkspaceSync } from "@/hooks/project/use-workspace-sync";
import { isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type {
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeProjectShortcut,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import type { BoardData } from "@/types";

// ---------------------------------------------------------------------------
// Context value — project-level state: navigation, runtime config, onboarding,
// access gate, config-derived values, mutation callbacks, and workspace sync.
//
// The value is constructed inside ProjectProvider, which owns all project-level
// hooks. Child components read project state via useProjectContext().
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
	latestTaskBaseRefUpdate: UseProjectNavigationResult["latestTaskBaseRefUpdate"];
	latestTaskWorkingDirectoryUpdate: UseProjectNavigationResult["latestTaskWorkingDirectoryUpdate"];
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
	agentCommand: string | null;
	configDefaultBaseRef: string;

	// --- useWorkspaceSync (subset exposed via context) ---
	workspacePath: string | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	refreshWorkspaceState: () => Promise<void>;

	// --- useWorkspaceSync (additional outputs needed by AppContent) ---
	workspaceRevision: number | null;
	setWorkspaceRevision: Dispatch<SetStateAction<number | null>>;
	workspaceHydrationNonce: number;
	isWorkspaceStateRefreshing: boolean;
	isWorkspaceMetadataPending: boolean;
	resetWorkspaceSyncState: (targetProjectId?: string | null) => void;

	// --- Document visibility ---
	isDocumentVisible: boolean;

	// --- Board-level state bridged through for downstream consumers ---
	canPersistWorkspaceState: boolean;
	isServedFromBoardCache: boolean;

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

// ---------------------------------------------------------------------------
// Provider component — calls all project-level hooks and exposes the combined
// value via ProjectContext. This is the foundation layer: it reads from nothing
// (no parent contexts), and all other providers depend on it.
//
// Props bridge values that are owned above the provider tree:
// - onProjectSwitchStart: cleanup callback defined in App
// - setBoard/setSessions/setCanPersistWorkspaceState: board-level state setters
//   needed by useWorkspaceSync (temporary — will clean up with BoardProvider)
// ---------------------------------------------------------------------------

export interface ProjectProviderProps {
	onProjectSwitchStart: () => void;
	boardRef: MutableRefObject<BoardData>;
	sessionsRef: MutableRefObject<Record<string, RuntimeTaskSessionSummary>>;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	canPersistWorkspaceState: boolean;
	setCanPersistWorkspaceState: Dispatch<SetStateAction<boolean>>;
	children: ReactNode;
}

export function ProjectProvider({
	onProjectSwitchStart,
	boardRef,
	sessionsRef,
	setBoard,
	setSessions,
	canPersistWorkspaceState,
	setCanPersistWorkspaceState,
	children,
}: ProjectProviderProps): ReactNode {
	// --- Core project navigation ---
	const {
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
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
		navigationCurrentProjectId,
		removingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handlePreloadProject,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		handleReorderProjects,
		pendingGitInitializationPath,
		isInitializingGitProject,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart,
	});

	// --- Document visibility ---
	const isDocumentVisible = useDocumentVisibility();

	// --- Runtime project config ---
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(currentProjectId);

	const { isBlocked: isQuarterdeckAccessBlocked } = useQuarterdeckAccessGate({
		workspaceId: currentProjectId,
	});

	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsWorkspaceId = navigationCurrentProjectId ?? currentProjectId;

	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsWorkspaceId);

	// --- Startup onboarding ---
	const {
		isStartupOnboardingDialogOpen,
		handleOpenStartupOnboardingDialog,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
	} = useStartupOnboarding({
		currentProjectId,
		runtimeProjectConfig,
		isRuntimeProjectConfigLoading,
		isTaskAgentReady,
		refreshRuntimeProjectConfig,
		refreshSettingsRuntimeProjectConfig,
	});

	// --- Workspace sync ---
	const {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		isServedFromBoardCache,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId,
		streamedWorkspaceState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		boardRef,
		sessionsRef,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});

	// --- Derived config values ---
	const llmConfigured = runtimeProjectConfig?.llmConfigured ?? false;
	const isLlmGenerationDisabled = !llmConfigured;
	const showTrashWorktreeNotice =
		runtimeProjectConfig?.showTrashWorktreeNotice ?? CONFIG_DEFAULTS.showTrashWorktreeNotice;
	const unmergedChangesIndicatorEnabled =
		runtimeProjectConfig?.unmergedChangesIndicatorEnabled ?? CONFIG_DEFAULTS.unmergedChangesIndicatorEnabled;
	const behindBaseIndicatorEnabled =
		runtimeProjectConfig?.behindBaseIndicatorEnabled ?? CONFIG_DEFAULTS.behindBaseIndicatorEnabled;
	const shortcuts = runtimeProjectConfig?.shortcuts ?? [];
	const selectedShortcutLabel = useMemo(() => {
		if (shortcuts.length === 0) {
			return null;
		}
		const configured = runtimeProjectConfig?.selectedShortcutLabel ?? null;
		if (configured && shortcuts.some((shortcut) => shortcut.label === configured)) {
			return configured;
		}
		return shortcuts[0]?.label ?? null;
	}, [runtimeProjectConfig?.selectedShortcutLabel, shortcuts]);
	const skipTaskCheckoutConfirmation = runtimeProjectConfig?.skipTaskCheckoutConfirmation ?? false;
	const skipHomeCheckoutConfirmation = runtimeProjectConfig?.skipHomeCheckoutConfirmation ?? false;
	const skipCherryPickConfirmation = runtimeProjectConfig?.skipCherryPickConfirmation ?? false;
	const pinnedBranches = runtimeProjectConfig?.pinnedBranches ?? [];
	const audibleNotificationsEnabled =
		runtimeProjectConfig?.audibleNotificationsEnabled ?? CONFIG_DEFAULTS.audibleNotificationsEnabled;
	const audibleNotificationVolume =
		runtimeProjectConfig?.audibleNotificationVolume ?? CONFIG_DEFAULTS.audibleNotificationVolume;
	const audibleNotificationEvents =
		runtimeProjectConfig?.audibleNotificationEvents ?? CONFIG_DEFAULTS.audibleNotificationEvents;
	const audibleNotificationsOnlyWhenHidden =
		runtimeProjectConfig?.audibleNotificationsOnlyWhenHidden ?? CONFIG_DEFAULTS.audibleNotificationsOnlyWhenHidden;
	const audibleNotificationSuppressCurrentProject =
		runtimeProjectConfig?.audibleNotificationSuppressCurrentProject ??
		CONFIG_DEFAULTS.audibleNotificationSuppressCurrentProject;
	const terminalFontWeight = runtimeProjectConfig?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight;
	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;
	const configDefaultBaseRef = runtimeProjectConfig?.defaultBaseRef ?? "";

	// --- Config mutation callbacks ---
	const handleTogglePinBranch = useCallback(
		(branchName: string) => {
			if (!currentProjectId) return;
			const current = runtimeProjectConfig?.pinnedBranches ?? [];
			const next = current.includes(branchName) ? current.filter((b) => b !== branchName) : [...current, branchName];
			void saveRuntimeConfig(currentProjectId, { pinnedBranches: next })
				.then(() => {
					refreshRuntimeProjectConfig();
				})
				.catch(() => {
					showAppToast({ intent: "danger", message: "Failed to update pinned branches" });
				});
		},
		[currentProjectId, runtimeProjectConfig?.pinnedBranches, refreshRuntimeProjectConfig],
	);

	const handleSkipTaskCheckoutConfirmationChange = useCallback(
		(skip: boolean) => {
			if (!currentProjectId) return;
			void saveRuntimeConfig(currentProjectId, { skipTaskCheckoutConfirmation: skip }).then(() => {
				refreshRuntimeProjectConfig();
			});
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);

	const handleSetDefaultBaseRef = useCallback(
		async (value: string | null) => {
			const nextValue = value ?? "";
			try {
				await saveRuntimeConfig(currentProjectId, { defaultBaseRef: nextValue });
				refreshRuntimeProjectConfig();
				showAppToast({
					intent: "success",
					message: nextValue ? `Default base ref set to ${nextValue}` : "Default base ref cleared",
					timeout: 2000,
				});
			} catch {
				showAppToast({ intent: "danger", message: "Failed to update default base ref" });
			}
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);

	const saveTrashWorktreeNoticeDismissed = useCallback(() => {
		void saveRuntimeConfig(currentProjectId, { showTrashWorktreeNotice: false }).then(() => {
			refreshRuntimeProjectConfig();
		});
	}, [currentProjectId, refreshRuntimeProjectConfig]);

	// --- Context value ---
	const value = useMemo<ProjectContextValue>(
		() => ({
			currentProjectId,
			projects,
			streamedWorkspaceState,
			workspaceMetadata,
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
			navigationCurrentProjectId,
			removingProjectId,
			hasNoProjects,
			isProjectSwitching,
			handleSelectProject,
			handlePreloadProject,
			handleAddProject,
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
			resetProjectNavigationState,
			runtimeProjectConfig,
			isRuntimeProjectConfigLoading,
			refreshRuntimeProjectConfig,
			settingsRuntimeProjectConfig,
			refreshSettingsRuntimeProjectConfig,
			isStartupOnboardingDialogOpen,
			handleOpenStartupOnboardingDialog,
			handleCloseStartupOnboardingDialog,
			handleSelectOnboardingAgent,
			isQuarterdeckAccessBlocked,
			isTaskAgentReady,
			settingsWorkspaceId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation,
			skipCherryPickConfirmation,
			pinnedBranches,
			showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled,
			behindBaseIndicatorEnabled,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			agentCommand,
			configDefaultBaseRef,
			workspacePath,
			workspaceGit,
			refreshWorkspaceState,
			workspaceRevision,
			setWorkspaceRevision,
			workspaceHydrationNonce,
			isWorkspaceStateRefreshing,
			isWorkspaceMetadataPending,
			resetWorkspaceSyncState,
			isDocumentVisible,
			canPersistWorkspaceState,
			isServedFromBoardCache,
			handleTogglePinBranch,
			handleSkipTaskCheckoutConfirmationChange,
			handleSetDefaultBaseRef,
			saveTrashWorktreeNoticeDismissed,
		}),
		[
			currentProjectId,
			projects,
			streamedWorkspaceState,
			workspaceMetadata,
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
			navigationCurrentProjectId,
			removingProjectId,
			hasNoProjects,
			isProjectSwitching,
			handleSelectProject,
			handlePreloadProject,
			handleAddProject,
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
			resetProjectNavigationState,
			runtimeProjectConfig,
			isRuntimeProjectConfigLoading,
			refreshRuntimeProjectConfig,
			settingsRuntimeProjectConfig,
			refreshSettingsRuntimeProjectConfig,
			isStartupOnboardingDialogOpen,
			handleOpenStartupOnboardingDialog,
			handleCloseStartupOnboardingDialog,
			handleSelectOnboardingAgent,
			isQuarterdeckAccessBlocked,
			isTaskAgentReady,
			settingsWorkspaceId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation,
			skipCherryPickConfirmation,
			pinnedBranches,
			showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled,
			behindBaseIndicatorEnabled,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			agentCommand,
			configDefaultBaseRef,
			workspacePath,
			workspaceGit,
			refreshWorkspaceState,
			workspaceRevision,
			setWorkspaceRevision,
			workspaceHydrationNonce,
			isWorkspaceStateRefreshing,
			isWorkspaceMetadataPending,
			resetWorkspaceSyncState,
			isDocumentVisible,
			canPersistWorkspaceState,
			isServedFromBoardCache,
			handleTogglePinBranch,
			handleSkipTaskCheckoutConfirmationChange,
			handleSetDefaultBaseRef,
			saveTrashWorktreeNoticeDismissed,
		],
	);

	return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
