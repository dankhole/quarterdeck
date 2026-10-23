import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

import { showAppToast } from "@/components/app-toaster";
import { type UseStartupOnboardingResult, useQuarterdeckAccessGate, useStartupOnboarding } from "@/hooks/project";
import { isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";

// Intentionally broad only for runtime config, onboarding, and access-gate
// state. New project navigation/sync/stream state belongs in the narrower
// project contexts from project-provider.tsx instead of here.
export interface ProjectRuntimeContextValue {
	runtimeProjectConfig: RuntimeConfigResponse | null;
	isRuntimeProjectConfigLoading: boolean;
	refreshRuntimeProjectConfig: () => void;
	settingsRuntimeProjectConfig: RuntimeConfigResponse | null;
	refreshSettingsRuntimeProjectConfig: () => void;
	isStartupOnboardingDialogOpen: UseStartupOnboardingResult["isStartupOnboardingDialogOpen"];
	handleOpenStartupOnboardingDialog: UseStartupOnboardingResult["handleOpenStartupOnboardingDialog"];
	handleCloseStartupOnboardingDialog: UseStartupOnboardingResult["handleCloseStartupOnboardingDialog"];
	handleSelectOnboardingAgent: UseStartupOnboardingResult["handleSelectOnboardingAgent"];
	isQuarterdeckAccessBlocked: boolean;
	isTaskAgentReady: boolean | null;
	settingsProjectId: string | null;
	llmConfigured: boolean;
	isLlmGenerationDisabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	selectedShortcutLabel: string | null;
	pinnedBranches: string[];
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: { permission: boolean; review: boolean; failure: boolean };
	audibleNotificationsOnlyWhenHidden: boolean;
	audibleNotificationSuppressCurrentProject: { permission: boolean; review: boolean; failure: boolean };
	terminalFontWeight: number;
	agentCommand: string | null;
	configDefaultBaseRef: string;
	handleTogglePinBranch: (branchName: string) => void;
	handleSetDefaultBaseRef: (value: string | null) => Promise<void>;
}

export const ProjectRuntimeContext = createContext<ProjectRuntimeContextValue | null>(null);

export function useProjectRuntimeContext(): ProjectRuntimeContextValue {
	const ctx = useContext(ProjectRuntimeContext);
	if (!ctx) {
		throw new Error("useProjectRuntimeContext must be used within a ProjectRuntimeContext.Provider");
	}
	return ctx;
}

export interface ProjectRuntimeProviderProps {
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	children?: ReactNode;
}

export function ProjectRuntimeProvider({
	currentProjectId,
	navigationCurrentProjectId,
	children,
}: ProjectRuntimeProviderProps): ReactNode {
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(currentProjectId);

	const { isBlocked: isQuarterdeckAccessBlocked } = useQuarterdeckAccessGate({
		projectId: currentProjectId,
	});

	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsProjectId = navigationCurrentProjectId ?? currentProjectId;

	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsProjectId);

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

	const llmConfigured = runtimeProjectConfig?.llmConfigured ?? false;
	const isLlmGenerationDisabled = !(runtimeProjectConfig?.textGenerationAvailable ?? false);
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

	const handleSetDefaultBaseRef = useCallback(
		async (value: string | null) => {
			if (!currentProjectId) return;
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

	const value = useMemo<ProjectRuntimeContextValue>(
		() => ({
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
			settingsProjectId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			pinnedBranches,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			agentCommand,
			configDefaultBaseRef,
			handleTogglePinBranch,
			handleSetDefaultBaseRef,
		}),
		[
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
			settingsProjectId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			pinnedBranches,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			agentCommand,
			configDefaultBaseRef,
			handleTogglePinBranch,
			handleSetDefaultBaseRef,
		],
	);

	return <ProjectRuntimeContext.Provider value={value}>{children}</ProjectRuntimeContext.Provider>;
}
