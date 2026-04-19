import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";

import { type UseTerminalPanelsResult, useTerminalPanels } from "@/hooks/terminal";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectContext } from "@/providers/project-provider";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	type UseTerminalConnectionReadyResult,
	useTerminalConnectionReady,
} from "@/runtime/use-terminal-connection-ready";
import { findCardSelection } from "@/state/board-state";
import { useTaskWorktreeInfoValue, useTaskWorktreeSnapshotValue } from "@/stores/project-metadata-store";

// ---------------------------------------------------------------------------
// Context value — terminal panel state, connection readiness, and
// home/detail terminal metadata.
// ---------------------------------------------------------------------------

export interface TerminalContextValue {
	// --- useTerminalPanels ---
	homeTerminalTaskId: UseTerminalPanelsResult["homeTerminalTaskId"];
	isHomeTerminalOpen: UseTerminalPanelsResult["isHomeTerminalOpen"];
	isHomeTerminalStarting: UseTerminalPanelsResult["isHomeTerminalStarting"];
	homeTerminalShellBinary: UseTerminalPanelsResult["homeTerminalShellBinary"];
	homeTerminalPaneHeight: UseTerminalPanelsResult["homeTerminalPaneHeight"];
	isDetailTerminalOpen: UseTerminalPanelsResult["isDetailTerminalOpen"];
	detailTerminalTaskId: UseTerminalPanelsResult["detailTerminalTaskId"];
	isDetailTerminalStarting: UseTerminalPanelsResult["isDetailTerminalStarting"];
	detailTerminalPaneHeight: UseTerminalPanelsResult["detailTerminalPaneHeight"];
	isHomeTerminalExpanded: UseTerminalPanelsResult["isHomeTerminalExpanded"];
	isDetailTerminalExpanded: UseTerminalPanelsResult["isDetailTerminalExpanded"];
	setHomeTerminalPaneHeight: UseTerminalPanelsResult["setHomeTerminalPaneHeight"];
	setDetailTerminalPaneHeight: UseTerminalPanelsResult["setDetailTerminalPaneHeight"];
	handleToggleExpandHomeTerminal: UseTerminalPanelsResult["handleToggleExpandHomeTerminal"];
	handleToggleExpandDetailTerminal: UseTerminalPanelsResult["handleToggleExpandDetailTerminal"];
	handleToggleHomeTerminal: UseTerminalPanelsResult["handleToggleHomeTerminal"];
	handleToggleDetailTerminal: UseTerminalPanelsResult["handleToggleDetailTerminal"];
	handleSendAgentCommandToHomeTerminal: UseTerminalPanelsResult["handleSendAgentCommandToHomeTerminal"];
	handleSendAgentCommandToDetailTerminal: UseTerminalPanelsResult["handleSendAgentCommandToDetailTerminal"];
	handleRestartHomeTerminal: UseTerminalPanelsResult["handleRestartHomeTerminal"];
	handleRestartDetailTerminal: UseTerminalPanelsResult["handleRestartDetailTerminal"];
	prepareTerminalForShortcut: UseTerminalPanelsResult["prepareTerminalForShortcut"];
	resetBottomTerminalLayoutCustomizations: UseTerminalPanelsResult["resetBottomTerminalLayoutCustomizations"];
	collapseHomeTerminal: UseTerminalPanelsResult["collapseHomeTerminal"];
	collapseDetailTerminal: UseTerminalPanelsResult["collapseDetailTerminal"];
	closeHomeTerminal: UseTerminalPanelsResult["closeHomeTerminal"];
	closeDetailTerminal: UseTerminalPanelsResult["closeDetailTerminal"];
	resetTerminalPanelsState: UseTerminalPanelsResult["resetTerminalPanelsState"];
	handleShellExit: UseTerminalPanelsResult["handleShellExit"];
	cancelPendingRestart: UseTerminalPanelsResult["cancelPendingRestart"];

	// --- useTerminalConnectionReady ---
	markTerminalConnectionReady: UseTerminalConnectionReadyResult["markConnectionReady"];
	prepareWaitForTerminalConnectionReady: UseTerminalConnectionReadyResult["prepareWaitForConnection"];

	// --- Derived terminal metadata ---
	homeTerminalSummary: RuntimeTaskSessionSummary | null;
	homeTerminalSubtitle: string | null;
	showHomeBottomTerminal: boolean;
	detailTerminalSummary: RuntimeTaskSessionSummary | null;
	detailTerminalSubtitle: string | null;
}

export const TerminalContext = createContext<TerminalContextValue | null>(null);

export function useTerminalContext(): TerminalContextValue {
	const ctx = useContext(TerminalContext);
	if (!ctx) {
		throw new Error("useTerminalContext must be used within a TerminalContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// Provider component
// ---------------------------------------------------------------------------

interface TerminalProviderProps {
	children: ReactNode;
}

export function TerminalProvider({ children }: TerminalProviderProps): ReactNode {
	const {
		currentProjectId,
		projectGit,
		configDefaultBaseRef,
		agentCommand,
		runtimeProjectConfig,
		hasNoProjects,
		projectPath,
		projects,
		navigationCurrentProjectId,
	} = useProjectContext();

	const { board, selectedCard, sessions, upsertSession, sendTaskSessionInput } = useBoardContext();

	// Stable findCard callback — avoids re-creating on every board change.
	const boardRef = useRef(board);
	boardRef.current = board;
	const findCardStable = useCallback(
		(cardId: string) => findCardSelection(boardRef.current, cardId)?.card ?? null,
		[],
	);

	// Store subscriptions for detail terminal metadata.
	const selectedTaskWorktreeInfo = useTaskWorktreeInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorktreeSnapshot = useTaskWorktreeSnapshotValue(selectedCard?.card.id);

	// --- useTerminalConnectionReady ---
	const {
		markConnectionReady: markTerminalConnectionReady,
		prepareWaitForConnection: prepareWaitForTerminalConnectionReady,
	} = useTerminalConnectionReady();

	// --- useTerminalPanels ---
	const {
		homeTerminalTaskId,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalShellBinary,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		handleRestartHomeTerminal,
		handleRestartDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
		handleShellExit,
		cancelPendingRestart,
	} = useTerminalPanels({
		currentProjectId,
		selectedCard,
		projectGit,
		configDefaultBaseRef,
		agentCommand,
		shellAutoRestartEnabled: runtimeProjectConfig?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		findCard: findCardStable,
		upsertSession,
		sendTaskSessionInput,
	});

	// --- Derived terminal metadata ---
	const homeTerminalSummary = sessions[homeTerminalTaskId] ?? null;
	const showHomeBottomTerminal = !selectedCard && !hasNoProjects && isHomeTerminalOpen;
	const navigationProjectPath = useMemo(
		() =>
			navigationCurrentProjectId ? (projects.find((p) => p.id === navigationCurrentProjectId)?.path ?? null) : null,
		[navigationCurrentProjectId, projects],
	);
	const homeTerminalSubtitle = useMemo(
		() => projectPath ?? navigationProjectPath ?? null,
		[navigationProjectPath, projectPath],
	);

	const detailTerminalSummary = detailTerminalTaskId ? (sessions[detailTerminalTaskId] ?? null) : null;
	const detailTerminalSubtitle = selectedTaskWorktreeInfo?.path ?? selectedTaskWorktreeSnapshot?.path ?? null;

	// --- Context value ---
	const value = useMemo<TerminalContextValue>(
		() => ({
			homeTerminalTaskId,
			isHomeTerminalOpen,
			isHomeTerminalStarting,
			homeTerminalShellBinary,
			homeTerminalPaneHeight,
			isDetailTerminalOpen,
			detailTerminalTaskId,
			isDetailTerminalStarting,
			detailTerminalPaneHeight,
			isHomeTerminalExpanded,
			isDetailTerminalExpanded,
			setHomeTerminalPaneHeight,
			setDetailTerminalPaneHeight,
			handleToggleExpandHomeTerminal,
			handleToggleExpandDetailTerminal,
			handleToggleHomeTerminal,
			handleToggleDetailTerminal,
			handleSendAgentCommandToHomeTerminal,
			handleSendAgentCommandToDetailTerminal,
			handleRestartHomeTerminal,
			handleRestartDetailTerminal,
			prepareTerminalForShortcut,
			resetBottomTerminalLayoutCustomizations,
			collapseHomeTerminal,
			collapseDetailTerminal,
			closeHomeTerminal,
			closeDetailTerminal,
			resetTerminalPanelsState,
			handleShellExit,
			cancelPendingRestart,
			markTerminalConnectionReady,
			prepareWaitForTerminalConnectionReady,
			homeTerminalSummary,
			homeTerminalSubtitle,
			showHomeBottomTerminal,
			detailTerminalSummary,
			detailTerminalSubtitle,
		}),
		[
			homeTerminalTaskId,
			isHomeTerminalOpen,
			isHomeTerminalStarting,
			homeTerminalShellBinary,
			homeTerminalPaneHeight,
			isDetailTerminalOpen,
			detailTerminalTaskId,
			isDetailTerminalStarting,
			detailTerminalPaneHeight,
			isHomeTerminalExpanded,
			isDetailTerminalExpanded,
			setHomeTerminalPaneHeight,
			setDetailTerminalPaneHeight,
			handleToggleExpandHomeTerminal,
			handleToggleExpandDetailTerminal,
			handleToggleHomeTerminal,
			handleToggleDetailTerminal,
			handleSendAgentCommandToHomeTerminal,
			handleSendAgentCommandToDetailTerminal,
			handleRestartHomeTerminal,
			handleRestartDetailTerminal,
			prepareTerminalForShortcut,
			resetBottomTerminalLayoutCustomizations,
			collapseHomeTerminal,
			collapseDetailTerminal,
			closeHomeTerminal,
			closeDetailTerminal,
			resetTerminalPanelsState,
			handleShellExit,
			cancelPendingRestart,
			markTerminalConnectionReady,
			prepareWaitForTerminalConnectionReady,
			homeTerminalSummary,
			homeTerminalSubtitle,
			showHomeBottomTerminal,
			detailTerminalSummary,
			detailTerminalSubtitle,
		],
	);

	return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}
