import { createContext, useContext } from "react";

import type { UseTerminalPanelsResult } from "@/hooks/use-terminal-panels";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { UseTerminalConnectionReadyResult } from "@/runtime/use-terminal-connection-ready";

// ---------------------------------------------------------------------------
// Context value — terminal panel state, connection readiness, and
// home/detail terminal metadata.
//
// The value is constructed in App.tsx and provided inline via
// <TerminalContext.Provider>. This file owns the context shape and consumer
// hook so child components can read terminal state without prop drilling.
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
