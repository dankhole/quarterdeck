import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

import type { RuntimeSettingsSection } from "@/components/settings";
import { useAppDialogs } from "@/hooks/app";
import { type UseDebugLoggingResult, useDebugLogging, useDebugTools } from "@/hooks/debug";
import { useInteractionsContext } from "@/providers/interactions-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useTaskEditorContext } from "@/providers/task-editor-provider";

// ---------------------------------------------------------------------------
// Context value — dialog open/close state, debug tools, and debug logging.
// ---------------------------------------------------------------------------

export interface DialogContextValue {
	// Settings dialog
	isSettingsOpen: boolean;
	setIsSettingsOpen: (open: boolean) => void;
	settingsInitialSection: RuntimeSettingsSection | null;
	setSettingsInitialSection: (section: RuntimeSettingsSection | null) => void;
	handleOpenSettings: (section?: RuntimeSettingsSection) => void;

	// Clear trash dialog
	isClearTrashDialogOpen: boolean;
	setIsClearTrashDialogOpen: (open: boolean) => void;

	// Prompt shortcut editor
	promptShortcutEditorOpen: boolean;
	setPromptShortcutEditorOpen: (open: boolean) => void;

	// Task create dialog
	handleCreateDialogOpenChange: (open: boolean) => void;

	// Debug tools
	debugModeEnabled: boolean;
	isDebugDialogOpen: boolean;
	handleOpenDebugDialog: () => void;
	handleShowStartupOnboardingDialog: () => void;
	handleDebugDialogOpenChange: (nextOpen: boolean) => void;

	// Debug logging
	debugLogging: UseDebugLoggingResult;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogContext(): DialogContextValue {
	const ctx = useContext(DialogContext);
	if (!ctx) {
		throw new Error("useDialogContext must be used within a DialogContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// Provider component — calls useAppDialogs, useDebugTools, useDebugLogging
// and exposes the combined value via DialogContext.
//
// Reads project-level inputs (config, log entries, onboarding handler) from
// ProjectContext. Clear-trash dialog state is read from InteractionsContext
// (owned by InteractionsProvider which must render above DialogProvider).
// ---------------------------------------------------------------------------

export interface DialogProviderProps {
	children: ReactNode;
}

export function DialogProvider({ children }: DialogProviderProps): ReactNode {
	const project = useProjectContext();
	const projectRuntime = useProjectRuntimeContext();
	const { taskEditor } = useTaskEditorContext();
	const { isClearTrashDialogOpen, setIsClearTrashDialogOpen } = useInteractionsContext();

	const {
		isSettingsOpen,
		setIsSettingsOpen,
		settingsInitialSection,
		setSettingsInitialSection,
		promptShortcutEditorOpen,
		setPromptShortcutEditorOpen,
		handleOpenSettings,
		handleCreateDialogOpenChange,
	} = useAppDialogs({ handleCancelCreateTask: taskEditor.handleCancelCreateTask });

	const {
		debugModeEnabled,
		isDebugDialogOpen,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
	} = useDebugTools({
		runtimeProjectConfig: projectRuntime.runtimeProjectConfig,
		settingsRuntimeProjectConfig: projectRuntime.settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: projectRuntime.handleOpenStartupOnboardingDialog,
	});

	const debugLogging = useDebugLogging({
		currentProjectId: project.currentProjectId,
		logLevel: project.logLevel,
		debugLogEntries: project.debugLogEntries,
	});

	const value = useMemo<DialogContextValue>(
		() => ({
			isSettingsOpen,
			setIsSettingsOpen,
			settingsInitialSection,
			setSettingsInitialSection,
			handleOpenSettings,
			isClearTrashDialogOpen,
			setIsClearTrashDialogOpen,
			promptShortcutEditorOpen,
			setPromptShortcutEditorOpen,
			handleCreateDialogOpenChange,
			debugModeEnabled,
			isDebugDialogOpen,
			handleOpenDebugDialog,
			handleShowStartupOnboardingDialog,
			handleDebugDialogOpenChange,
			debugLogging,
		}),
		[
			isSettingsOpen,
			setIsSettingsOpen,
			settingsInitialSection,
			setSettingsInitialSection,
			handleOpenSettings,
			isClearTrashDialogOpen,
			setIsClearTrashDialogOpen,
			promptShortcutEditorOpen,
			setPromptShortcutEditorOpen,
			handleCreateDialogOpenChange,
			debugModeEnabled,
			isDebugDialogOpen,
			handleOpenDebugDialog,
			handleShowStartupOnboardingDialog,
			handleDebugDialogOpenChange,
			debugLogging,
		],
	);

	return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}
