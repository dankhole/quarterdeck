import type { ReactNode } from "react";
import type { MainViewId, SidebarId } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

export interface TaskDetailLayoutProps {
	mainView: MainViewId;
	sidebar: SidebarId | null;
	topBar: ReactNode;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
}

export interface TaskDetailSidePanelProps {
	navigateToFile: (nav: { targetView: "git" | "files"; filePath: string; lineNumber?: number }) => void;
	onCardSelect: (taskId: string) => void;
	onCardDoubleClick?: (taskId: string) => void;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
}

export interface TaskDetailRepositoryProps {
	gitHistoryPanel?: ReactNode;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	onSkipTaskCheckoutConfirmationChange?: (skip: boolean) => void;
	onDeselectTask: () => void;
}

export interface TaskDetailTerminalProps {
	bottomTerminalOpen: boolean;
	bottomTerminalTaskId: string | null;
	bottomTerminalSummary: RuntimeTaskSessionSummary | null;
	bottomTerminalSubtitle?: string | null;
	onBottomTerminalClose: () => void;
	onBottomTerminalCollapse?: () => void;
	bottomTerminalPaneHeight?: number;
	onBottomTerminalPaneHeightChange?: (height: number) => void;
	onBottomTerminalConnectionReady?: (taskId: string) => void;
	bottomTerminalAgentCommand?: string | null;
	onBottomTerminalSendAgentCommand?: () => void;
	isBottomTerminalExpanded?: boolean;
	onBottomTerminalToggleExpand?: () => void;
	onBottomTerminalRestart?: () => void;
	onBottomTerminalExit?: (taskId: string, exitCode: number | null) => void;
}
