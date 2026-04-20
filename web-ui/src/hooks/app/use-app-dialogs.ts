import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import type { RuntimeSettingsSection } from "@/components/settings";

interface UseAppDialogsInput {
	handleCancelCreateTask: () => void;
}

export interface UseAppDialogsResult {
	isSettingsOpen: boolean;
	setIsSettingsOpen: Dispatch<SetStateAction<boolean>>;
	settingsInitialSection: RuntimeSettingsSection | null;
	setSettingsInitialSection: Dispatch<SetStateAction<RuntimeSettingsSection | null>>;
	promptShortcutEditorOpen: boolean;
	setPromptShortcutEditorOpen: Dispatch<SetStateAction<boolean>>;
	handleOpenSettings: (section?: RuntimeSettingsSection) => void;
	handleCreateDialogOpenChange: (open: boolean) => void;
}

/**
 * Manages open/close state for top-level dialogs that don't belong to a
 * specific feature hook (settings, prompt shortcut editor, task create dialog).
 */
export function useAppDialogs({ handleCancelCreateTask }: UseAppDialogsInput): UseAppDialogsResult {
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [promptShortcutEditorOpen, setPromptShortcutEditorOpen] = useState(false);

	const handleOpenSettings = useCallback((section?: RuntimeSettingsSection) => {
		setSettingsInitialSection(section ?? null);
		setIsSettingsOpen(true);
	}, []);

	const handleCreateDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				handleCancelCreateTask();
			}
		},
		[handleCancelCreateTask],
	);

	return {
		isSettingsOpen,
		setIsSettingsOpen,
		settingsInitialSection,
		setSettingsInitialSection,
		promptShortcutEditorOpen,
		setPromptShortcutEditorOpen,
		handleOpenSettings,
		handleCreateDialogOpenChange,
	};
}
