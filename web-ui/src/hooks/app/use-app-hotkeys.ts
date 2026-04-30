import { useHotkeys } from "react-hotkeys-hook";

import type { CardSelection } from "@/types";

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	canUseCreateTaskShortcut: boolean;
	currentProjectId: string | null;
	handleToggleDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleOpenCreateTask: () => void;
	handleOpenSettings: () => void;
	onStartAllTasks: () => void;
	handleToggleDebugLogPanel?: () => void;
	handleToggleFileFinder: () => void;
	handleToggleTextSearch: () => void;
}

export function useAppHotkeys({
	selectedCard,
	canUseCreateTaskShortcut,
	currentProjectId,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleOpenCreateTask,
	handleOpenSettings,
	onStartAllTasks,
	handleToggleDebugLogPanel,
	handleToggleFileFinder,
	handleToggleTextSearch,
}: UseAppHotkeysInput): void {
	useHotkeys(
		"mod+j",
		() => {
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
		[handleToggleDetailTerminal, handleToggleHomeTerminal, selectedCard],
	);

	useHotkeys(
		"mod+b",
		onStartAllTasks,
		{
			enableOnContentEditable: false,
			enableOnFormTags: false,
			preventDefault: true,
		},
		[onStartAllTasks],
	);

	useHotkeys(
		"c",
		() => {
			if (!canUseCreateTaskShortcut) {
				return;
			}
			handleOpenCreateTask();
		},
		{ preventDefault: true },
		[canUseCreateTaskShortcut, handleOpenCreateTask],
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
			handleToggleDebugLogPanel?.();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleDebugLogPanel],
	);

	useHotkeys(
		"mod+p",
		() => {
			if (!currentProjectId) return;
			handleToggleFileFinder();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[currentProjectId, handleToggleFileFinder],
	);

	useHotkeys(
		"mod+shift+f",
		() => {
			if (!currentProjectId) return;
			handleToggleTextSearch();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[currentProjectId, handleToggleTextSearch],
	);
}
