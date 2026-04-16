import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BoardContext, type BoardContextValue } from "@/providers/board-provider";
import { GitContext, type GitContextValue } from "@/providers/git-provider";
import { CardActionsProvider, type ReactiveCardState, type StableCardActions } from "@/state/card-actions-context";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const mockUseRuntimeWorkspaceChanges = vi.fn();
const { mockAgentTerminalPanel } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/components/conflict-banner", () => ({
	ConflictBanner: () => null,
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: () => <div data-testid="diff-viewer-panel" />,
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: () => <div data-testid="file-tree-panel" />,
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/runtime/use-runtime-workspace-changes", () => ({
	useRuntimeWorkspaceChanges: (...args: unknown[]) => mockUseRuntimeWorkspaceChanges(...args),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceStateVersionValue: () => 0,
	useTaskWorkspaceInfoValue: () => null,
	useTaskWorkspaceSnapshotValue: () => null,
	useHomeGitSummaryValue: () => null,
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: null,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{
			id: "backlog",
			title: "Backlog",
			cards: [card],
		},
		{
			id: "in_progress",
			title: "In Progress",
			cards: [],
		},
		{
			id: "review",
			title: "Review",
			cards: [],
		},
		{
			id: "trash",
			title: "Trash",
			cards: [],
		},
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

/** Default new required props for CardDetailView */
const newRequiredProps = {
	mainView: "terminal" as const,
	sidebar: "task_column" as const,
	topBar: <div data-testid="top-bar" />,
	sidePanelRatio: 0.25,
	setSidePanelRatio: () => {},
	skipTaskCheckoutConfirmation: false,
	skipHomeCheckoutConfirmation: false,
	onDeselectTask: () => {},
};

function requireSidePanelSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize side panel"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a side panel resize separator.");
	}
	return separator;
}

function requireSidePanel(container: HTMLElement): HTMLElement {
	const separator = requireSidePanelSeparator(container);
	const panel = separator.previousElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected a side panel element.");
	}
	return panel;
}

const noopStableActions: StableCardActions = {};
const noopReactiveState: ReactiveCardState = {
	moveToTrashLoadingById: {},
	migratingTaskId: null,
	isLlmGenerationDisabled: false,
	showSummaryOnCards: false,
	uncommittedChangesOnCardsEnabled: false,
	showRunningTaskEmergencyActions: false,
};

const noopTaskEditor = {
	isInlineTaskCreateOpen: false,
	newTaskPrompt: "",
	setNewTaskPrompt: () => {},
	newTaskImages: [],
	setNewTaskImages: () => {},
	newTaskStartInPlanMode: false,
	setNewTaskStartInPlanMode: () => {},
	newTaskAutoReviewEnabled: false,
	setNewTaskAutoReviewEnabled: () => {},
	newTaskAutoReviewMode: "move_to_trash" as const,
	setNewTaskAutoReviewMode: () => {},
	isNewTaskStartInPlanModeDisabled: false,
	newTaskUseWorktree: true,
	setNewTaskUseWorktree: () => {},
	createFeatureBranch: false,
	setCreateFeatureBranch: () => {},
	branchName: "",
	handleBranchNameEdit: () => {},
	generateBranchNameFromPrompt: async () => {},
	isGeneratingBranchName: false,
	newTaskBranchRef: "",
	setNewTaskBranchRef: () => {},
	editingTaskId: null,
	editTaskPrompt: "",
	setEditTaskPrompt: () => {},
	editTaskImages: [],
	setEditTaskImages: () => {},
	editTaskStartInPlanMode: false,
	setEditTaskStartInPlanMode: () => {},
	editTaskAutoReviewEnabled: false,
	setEditTaskAutoReviewEnabled: () => {},
	editTaskAutoReviewMode: "move_to_trash" as const,
	setEditTaskAutoReviewMode: () => {},
	isEditTaskStartInPlanModeDisabled: false,
	editTaskBranchRef: "",
	setEditTaskBranchRef: () => {},
	handleOpenCreateTask: () => {},
	handleCancelCreateTask: () => {},
	handleOpenEditTask: () => {},
	handleCancelEditTask: () => {},
	handleSaveEditedTask: () => null,
	handleSaveAndStartEditedTask: () => {},
	handleCreateTask: () => null,
	handleCreateTasks: () => [],
	resetTaskEditorState: () => {},
};

const noopBoardContext: BoardContextValue = {
	board: { columns: [], dependencies: [] },
	setBoard: () => {},
	sessions: {},
	upsertSession: () => {},
	selectedTaskId: null,
	selectedCard: null,
	setSelectedTaskId: () => {},
	setSessions: () => {},
	ensureTaskWorkspace: async () => ({ ok: false }),
	startTaskSession: async () => ({ ok: false }),
	cleanupTaskWorkspace: async () => null,
	fetchTaskWorkspaceInfo: async () => null,
	sendTaskSessionInput: async () => ({ ok: true }),
	stopTaskSession: async () => {},
	taskEditor: noopTaskEditor,
	handleCreateTask: () => null,
	handleCreateTasks: () => [],
	handleCancelCreateTask: () => {},
	createTaskBranchOptions: [],
	isInitialRuntimeLoad: false,
	isAwaitingWorkspaceSnapshot: false,
};

const noopGitContext: GitContextValue = {
	runningGitAction: null,
	gitActionError: null,
	gitActionErrorTitle: "",
	clearGitActionError: () => {},
	gitHistory: {
		viewMode: "commit",
		refs: [],
		activeRef: null,
		refsErrorMessage: null,
		isRefsLoading: false,
		workingCopyFileCount: 0,
		hasWorkingCopy: false,
		commits: [],
		totalCommitCount: 0,
		selectedCommitHash: null,
		selectedCommit: null,
		isLogLoading: false,
		isLoadingMoreCommits: false,
		logErrorMessage: null,
		diffSource: null,
		isDiffLoading: false,
		diffErrorMessage: null,
		selectedDiffPath: null,
		selectWorkingCopy: () => {},
		selectRef: () => {},
		selectCommit: () => {},
		selectDiffPath: () => {},
		loadMoreCommits: () => {},
		refresh: () => {},
	},
	gitHistoryTaskScope: null,
	runGitAction: async () => {},
	switchHomeBranch: async () => {},
	resetGitActionState: () => {},
	taskGitActionLoadingByTaskId: {},
	runAutoReviewGitAction: async () => false,
	onStashAndRetry: undefined,
	isStashAndRetryingPull: false,
	isGitHistoryOpen: false,
	setIsGitHistoryOpen: () => {},
	handleToggleGitHistory: () => {},
	pendingCompareNavigation: null,
	pendingFileNavigation: null,
	openGitCompare: () => {},
	clearPendingCompareNavigation: () => {},
	navigateToFile: () => {},
	clearPendingFileNavigation: () => {},
	navigateToGitView: () => {},
	fileBrowserScopeMode: "contextual",
	fileBrowserResolvedScope: null,
	fileBrowserSwitchToHome: () => {},
	fileBrowserReturnToContextual: () => {},
	fileBrowserSelectBranchView: () => {},
	gitSyncTaskScope: undefined,
	fileBrowserBranchActions: {
		isBranchPopoverOpen: false,
		setBranchPopoverOpen: () => {},
		branches: null,
		currentBranch: null,
		worktreeBranches: new Map(),
		checkoutDialogState: { type: "closed" },
		closeCheckoutDialog: () => {},
		createBranchDialogState: { type: "closed" },
		handleCreateBranchFrom: () => {},
		closeCreateBranchDialog: () => {},
		handleBranchCreated: () => {},
		handleSelectBranchView: () => {},
		handleCheckoutBranch: () => {},
		handleConfirmCheckout: () => {},
		handleStashAndCheckout: () => {},
		isStashingAndCheckingOut: false,
		mergeBranchDialogState: { type: "closed" },
		handleMergeBranch: () => {},
		handleConfirmMergeBranch: () => {},
		closeMergeBranchDialog: () => {},
		deleteBranchDialogState: { type: "closed" },
		handleDeleteBranch: () => {},
		handleConfirmDeleteBranch: () => {},
		closeDeleteBranchDialog: () => {},
		rebaseBranchDialogState: { type: "closed" },
		handleRebaseBranch: () => {},
		handleConfirmRebaseBranch: () => {},
		closeRebaseBranchDialog: () => {},
		renameBranchDialogState: { type: "closed" },
		handleRenameBranch: () => {},
		handleConfirmRenameBranch: () => {},
		closeRenameBranchDialog: () => {},
		resetToRefDialogState: { type: "closed" },
		handleResetToRef: () => {},
		handleConfirmResetToRef: () => {},
		closeResetToRefDialog: () => {},
	},
	topbarBranchActions: {
		isBranchPopoverOpen: false,
		setBranchPopoverOpen: () => {},
		branches: null,
		currentBranch: null,
		worktreeBranches: new Map(),
		checkoutDialogState: { type: "closed" },
		closeCheckoutDialog: () => {},
		createBranchDialogState: { type: "closed" },
		handleCreateBranchFrom: () => {},
		closeCreateBranchDialog: () => {},
		handleBranchCreated: () => {},
		handleSelectBranchView: () => {},
		handleCheckoutBranch: () => {},
		handleConfirmCheckout: () => {},
		handleStashAndCheckout: () => {},
		isStashingAndCheckingOut: false,
		mergeBranchDialogState: { type: "closed" },
		handleMergeBranch: () => {},
		handleConfirmMergeBranch: () => {},
		closeMergeBranchDialog: () => {},
		deleteBranchDialogState: { type: "closed" },
		handleDeleteBranch: () => {},
		handleConfirmDeleteBranch: () => {},
		closeDeleteBranchDialog: () => {},
		rebaseBranchDialogState: { type: "closed" },
		handleRebaseBranch: () => {},
		handleConfirmRebaseBranch: () => {},
		closeRebaseBranchDialog: () => {},
		renameBranchDialogState: { type: "closed" },
		handleRenameBranch: () => {},
		handleConfirmRenameBranch: () => {},
		closeRenameBranchDialog: () => {},
		resetToRefDialogState: { type: "closed" },
		handleResetToRef: () => {},
		handleConfirmResetToRef: () => {},
		closeResetToRefDialog: () => {},
	},
	topbarBranchLabel: null,
	homeFileBrowserData: {
		files: null,
		selectedPath: null,
		onSelectPath: () => {},
		fileContent: null,
		isContentLoading: false,
		isContentError: false,
		onCloseFile: () => {},
		getFileContent: async () => null,
	},
	mainView: "home",
	sidebar: null,
	setMainView: () => {},
	toggleSidebar: () => {},
	sidebarPinned: false,
	toggleSidebarPinned: () => {},
	visualMainView: "home",
	visualSidebar: null,
	sidePanelRatio: 0.15,
	setSidePanelRatio: () => {},
	resetCardDetailLayoutToDefaults: () => {},
	navigateToGitViewRef: { current: null },
};

function renderWithProviders(root: Root, ui: ReactNode): void {
	root.render(
		<BoardContext.Provider value={noopBoardContext}>
			<GitContext.Provider value={noopGitContext}>
				<CardActionsProvider stable={noopStableActions} reactive={noopReactiveState}>
					<TooltipProvider>{ui}</TooltipProvider>
				</CardActionsProvider>
			</GitContext.Provider>
		</BoardContext.Provider>,
	);
}

describe("CardDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: {
				files: [
					{
						path: "src/example.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						oldText: "before\n",
						newText: "after\n",
					},
				],
			},
			isRuntimeAvailable: true,
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockUseRuntimeWorkspaceChanges.mockReset();
		mockAgentTerminalPanel.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					onCardSelect={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
					{...newRequiredProps}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});

	it("renders the side panel at the given ratio", async () => {
		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					onCardSelect={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
					{...newRequiredProps}
					sidePanelRatio={0.3}
				/>,
			);
		});

		// Browser normalizes "30.0%" to "30%"
		expect(requireSidePanel(container).style.flex).toBe("0 0 30%");
	});

	it("fires setSidePanelRatio on resize drag", async () => {
		const setSidePanelRatio = vi.fn();

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					onCardSelect={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
					{...newRequiredProps}
					setSidePanelRatio={setSidePanelRatio}
				/>,
			);
		});

		const separator = requireSidePanelSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 160 }));
		});
		await act(async () => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320 }));
		});

		expect(setSidePanelRatio).toHaveBeenCalled();
	});
});
