import { createContext, useContext } from "react";

import type { RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import type { UseDebugLoggingResult } from "@/hooks/use-debug-logging";

// ---------------------------------------------------------------------------
// Context value — dialog open/close state, debug tools, and debug logging.
//
// The value is constructed in App.tsx and provided inline via
// <DialogContext.Provider>. This file owns the context shape and consumer
// hook so child components can read dialog state without prop drilling.
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
	isResetAllStatePending: boolean;
	handleOpenDebugDialog: () => void;
	handleShowStartupOnboardingDialog: () => void;
	handleDebugDialogOpenChange: (nextOpen: boolean) => void;
	handleResetAllState: () => void;

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
