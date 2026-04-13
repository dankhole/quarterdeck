import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import type { RuntimeSettingsSection } from "@/components/runtime-settings-dialog";

interface UseAppDialogsInput {
	handleCancelCreateTask: () => void;
}

interface UseAppDialogsResult {
	isSettingsOpen: boolean;
	setIsSettingsOpen: Dispatch<SetStateAction<boolean>>;
	settingsInitialSection: RuntimeSettingsSection | null;
	setSettingsInitialSection: Dispatch<SetStateAction<RuntimeSettingsSection | null>>;
	isClearTrashDialogOpen: boolean;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	promptShortcutEditorOpen: boolean;
	setPromptShortcutEditorOpen: Dispatch<SetStateAction<boolean>>;
	handleOpenSettings: (section?: RuntimeSettingsSection) => void;
	handleCreateDialogOpenChange: (open: boolean) => void;
}

/**
 * Manages open/close state for top-level dialogs that don't belong to a
 * specific feature hook (settings, clear trash, prompt shortcut editor,
 * task create dialog).
 */
export function useAppDialogs({ handleCancelCreateTask }: UseAppDialogsInput): UseAppDialogsResult {
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
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
		isClearTrashDialogOpen,
		setIsClearTrashDialogOpen,
		promptShortcutEditorOpen,
		setPromptShortcutEditorOpen,
		handleOpenSettings,
		handleCreateDialogOpenChange,
	};
}
