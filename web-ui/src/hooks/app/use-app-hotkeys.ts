import { useHotkeys } from "react-hotkeys-hook";

import type { CardSelection } from "@/types";

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	canUseCreateTaskShortcut: boolean;
	canUseProjectActions?: boolean;
	currentProjectId: string | null;
	handleToggleDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleOpenCreateTask: () => void;
	handleOpenSettings: () => void;
	handleToggleDiagnosticsPanel?: () => void;
	handleToggleFileFinder: () => void;
	handleToggleTextSearch: () => void;
}

export function useAppHotkeys({
	selectedCard,
	canUseCreateTaskShortcut,
	canUseProjectActions = true,
	currentProjectId,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleOpenCreateTask,
	handleOpenSettings,
	handleToggleDiagnosticsPanel,
	handleToggleFileFinder,
	handleToggleTextSearch,
}: UseAppHotkeysInput): void {
	useHotkeys(
		"mod+j",
		() => {
			if (!canUseProjectActions || !currentProjectId) return;
			if (selectedCard) {
				handleToggleDetailTerminal();
				return;
			}
			handleToggleHomeTerminal();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[canUseProjectActions, currentProjectId, handleToggleDetailTerminal, handleToggleHomeTerminal, selectedCard],
	);

	useHotkeys(
		"c",
		() => {
			if (!canUseProjectActions || !canUseCreateTaskShortcut) {
				return;
			}
			handleOpenCreateTask();
		},
		{ preventDefault: true },
		[canUseCreateTaskShortcut, canUseProjectActions, handleOpenCreateTask],
	);

	useHotkeys(
		"mod+shift+s",
		() => {
			handleOpenSettings();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleOpenSettings],
	);

	useHotkeys(
		"mod+shift+d",
		() => {
			handleToggleDiagnosticsPanel?.();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleDiagnosticsPanel],
	);

	useHotkeys(
		"mod+p",
		() => {
			if (!canUseProjectActions || !currentProjectId) return;
			handleToggleFileFinder();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[canUseProjectActions, currentProjectId, handleToggleFileFinder],
	);

	useHotkeys(
		"mod+shift+f",
		() => {
			if (!canUseProjectActions || !currentProjectId) return;
			handleToggleTextSearch();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[canUseProjectActions, currentProjectId, handleToggleTextSearch],
	);
}
