import { useHotkeys } from "react-hotkeys-hook";

import type { CardSelection } from "@/types";

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	isDetailTerminalOpen: boolean;
	isHomeTerminalOpen: boolean;
	canUseCreateTaskShortcut: boolean;
	currentProjectId: string | null;
	handleToggleDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleToggleExpandDetailTerminal: () => void;
	handleToggleExpandHomeTerminal: () => void;
	handleOpenCreateTask: () => void;
	handleOpenSettings: () => void;
	handleToggleGitHistory: () => void;
	onStartAllTasks: () => void;
	handleToggleDebugLogPanel?: () => void;
	handleToggleFileFinder: () => void;
	handleToggleTextSearch: () => void;
}

export function useAppHotkeys({
	selectedCard,
	isDetailTerminalOpen,
	isHomeTerminalOpen,
	canUseCreateTaskShortcut,
	currentProjectId,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleToggleExpandDetailTerminal,
	handleToggleExpandHomeTerminal,
	handleOpenCreateTask,
	handleOpenSettings,
	handleToggleGitHistory,
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
		"mod+m",
		() => {
			if (selectedCard) {
				if (isDetailTerminalOpen) {
					handleToggleExpandDetailTerminal();
				}
				return;
			}
			if (isHomeTerminalOpen) {
				handleToggleExpandHomeTerminal();
			}
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[
			handleToggleExpandDetailTerminal,
			handleToggleExpandHomeTerminal,
			isDetailTerminalOpen,
			isHomeTerminalOpen,
			selectedCard,
		],
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
		"mod+g",
		() => {
			handleToggleGitHistory();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleGitHistory],
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
