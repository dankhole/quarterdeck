import { useHotkeys } from "react-hotkeys-hook";

import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { CardSelection } from "@/types";
import { deriveAppCommandAvailability } from "./desktop-app";

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	canUseCreateTaskShortcut: boolean;
	canUseProjectActions?: boolean;
	currentProjectId: string | null;
	runtimeConnected?: boolean;
	onboarding?: boolean;
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
	runtimeConnected = true,
	onboarding = false,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleOpenCreateTask,
	handleOpenSettings,
	handleToggleDiagnosticsPanel,
	handleToggleFileFinder,
	handleToggleTextSearch,
}: UseAppHotkeysInput): void {
	// Electron menu accelerators deliver typed commands, independently of the focused input.
	// Keep a single owner even if a renderer key event also reaches React's hotkey listener.
	const nativeCommands =
		getRuntimeEnvironment().kind === "desktop" && typeof window.quarterdeckDesktop?.onCommand === "function";
	const commands = deriveAppCommandAvailability({
		runtimeConnected,
		onboarding,
		projectActionsEnabled: canUseProjectActions && currentProjectId !== null,
		selectedTask: selectedCard !== null,
	});
	const projectCommandsEnabled = commands.includes("toggle-shell");
	useHotkeys(
		"mod+j",
		() => {
			if (!projectCommandsEnabled) return;
			if (selectedCard) {
				handleToggleDetailTerminal();
				return;
			}
			handleToggleHomeTerminal();
		},
		{
			enabled: !nativeCommands,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[projectCommandsEnabled, currentProjectId, handleToggleDetailTerminal, handleToggleHomeTerminal, selectedCard],
	);

	useHotkeys(
		"c",
		() => {
			if (!commands.includes("new-task") || !canUseCreateTaskShortcut) {
				return;
			}
			handleOpenCreateTask();
		},
		{ preventDefault: true },
		[canUseCreateTaskShortcut, projectCommandsEnabled, handleOpenCreateTask],
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
			enabled: !nativeCommands,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleDiagnosticsPanel],
	);

	useHotkeys(
		"mod+p",
		() => {
			if (!projectCommandsEnabled) return;
			handleToggleFileFinder();
		},
		{
			enabled: !nativeCommands,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[projectCommandsEnabled, currentProjectId, handleToggleFileFinder],
	);

	useHotkeys(
		"mod+shift+f",
		() => {
			if (!projectCommandsEnabled) return;
			handleToggleTextSearch();
		},
		{
			enabled: !nativeCommands,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[projectCommandsEnabled, currentProjectId, handleToggleTextSearch],
	);
}
