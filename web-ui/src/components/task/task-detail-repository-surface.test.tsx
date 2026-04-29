import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDetailRepositorySurface } from "@/components/task/task-detail-repository-surface";
import type { TaskDetailRepositoryProps } from "@/components/task/task-detail-screen";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CardDetailViewLayoutState, CardDetailViewRepositoryState } from "@/hooks/board/use-card-detail-view";
import type { UseBranchActionsResult } from "@/hooks/git/use-branch-actions";
import type { UseFileBrowserDataResult } from "@/hooks/git/use-file-browser-data";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const { mockGitView, mockFilesView, mockBranchPillTrigger, mockBranchSelectorPopover, mockScopeBar } = vi.hoisted(
	() => ({
		mockGitView: vi.fn(),
		mockFilesView: vi.fn(),
		mockBranchPillTrigger: vi.fn(),
		mockBranchSelectorPopover: vi.fn(),
		mockScopeBar: vi.fn(),
	}),
);

vi.mock("@/components/app/top-bar", () => ({
	GitBranchStatusControl: ({ branchLabel }: { branchLabel: string }) => (
		<div data-testid="git-branch-status">{branchLabel}</div>
	),
}));

vi.mock("@/components/git", () => ({
	GitView: ({ branchStatusSlot, ...props }: { branchStatusSlot?: ReactNode }) => {
		mockGitView(props);
		return <div data-testid="git-view">{branchStatusSlot}</div>;
	},
	FilesView: ({ scopeBar, ...props }: { scopeBar: ReactNode }) => {
		mockFilesView(props);
		return <div data-testid="files-view">{scopeBar}</div>;
	},
}));

vi.mock("@/components/git/panels", () => ({
	BranchPillTrigger: (props: {
		label: string;
		detachedWorktreeBaseRef?: string | null;
		detachedWorktreeHeadCommit?: string | null;
	}) => {
		mockBranchPillTrigger(props);
		return <div data-testid="branch-pill-trigger">{props.label}</div>;
	},
	BranchSelectorPopover: ({
		trigger,
		...props
	}: {
		trigger: ReactNode;
		detachedWorktreeBaseRef?: string | null;
		detachedWorktreeHeadCommit?: string | null;
	}) => {
		mockBranchSelectorPopover(props);
		return <div data-testid="branch-selector">{trigger}</div>;
	},
	ScopeBar: ({
		branchPillSlot,
		...props
	}: {
		branchPillSlot?: ReactNode;
		taskIsDetached?: boolean;
		isDetachedHead?: boolean;
	}) => {
		mockScopeBar(props);
		return <div data-testid="scope-bar">{branchPillSlot}</div>;
	},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: "Task detail",
		prompt: `Task ${id}`,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		branch: "feature/task-detail",
		workingDirectory: "/tmp/task-detail",
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{ id: "in_progress", title: "In Progress", cards: [card] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "trash", title: "Trash", cards: [] },
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createBranchActions(): UseBranchActionsResult {
	return {
		isBranchPopoverOpen: false,
		setBranchPopoverOpen: () => {},
		branches: null,
		isLoadingBranches: false,
		requestBranches: () => {},
		refetchBranches: async () => null,
		currentBranch: "feature/task-detail",
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
	};
}

function createFileBrowserData(): UseFileBrowserDataResult {
	return {
		files: null,
		selectedPath: null,
		onSelectPath: () => {},
		fileContent: null,
		isContentLoading: false,
		isContentError: false,
		onCloseFile: () => {},
		getFileContent: async () => null,
	};
}

function createRepositoryState(): CardDetailViewRepositoryState {
	return {
		board: { columns: [], dependencies: [] },
		taskRepositoryInfo: null,
		taskWorktreeSnapshot: null,
		homeGitSummary: null,
		taskScopeMode: "contextual",
		taskResolvedScope: null,
		taskReturnToContextual: () => {},
		taskBranchActions: createBranchActions(),
		fileBrowserData: createFileBrowserData(),
		pillBranchLabel: "feature/task-detail",
		isGitHistoryOpen: false,
		onToggleGitHistory: () => {},
		pendingCompareNavigation: null,
		onCompareNavigationConsumed: () => {},
		onOpenGitCompare: () => {},
		pendingFileNavigation: null,
		onFileNavigationConsumed: () => {},
		navigateToFile: () => {},
		navigateToGitView: () => {},
		runGitAction: async () => {},
		handleAddToTerminal: async () => {},
		handleSendToTerminal: async () => {},
	};
}

function createLayoutState(): CardDetailViewLayoutState {
	return {
		detailLayoutRef: { current: null },
		mainRowRef: { current: null },
		handleSidePanelSeparatorMouseDown: () => {},
		sidePanelPercent: "25%",
		isTaskSidePanelOpen: true,
	};
}

function createRepositoryProps(): TaskDetailRepositoryProps {
	return {
		gitHistoryPanel: <div data-testid="git-history-panel" />,
		pinnedBranches: ["main"],
		onTogglePinBranch: () => {},
		skipTaskCheckoutConfirmation: false,
		skipHomeCheckoutConfirmation: false,
		onDeselectTask: () => {},
	};
}

describe("TaskDetailRepositorySurface", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockGitView.mockClear();
		mockFilesView.mockClear();
		mockBranchPillTrigger.mockClear();
		mockBranchSelectorPopover.mockClear();
		mockScopeBar.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockGitView.mockClear();
		mockFilesView.mockClear();
		mockBranchPillTrigger.mockClear();
		mockBranchSelectorPopover.mockClear();
		mockScopeBar.mockClear();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("routes the git view through the repository-owned surface", async () => {
		const selection = createSelection();
		const repositoryProps = createRepositoryProps();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={createRepositoryState()}
						repositoryProps={repositoryProps}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="git"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[data-testid="git-view"]')).not.toBeNull();
		expect(mockGitView).toHaveBeenCalledWith(
			expect.objectContaining({
				currentProjectId: "project-1",
				selectedCard: selection,
				gitHistoryPanel: repositoryProps.gitHistoryPanel,
				pinnedBranches: repositoryProps.pinnedBranches,
				onTogglePinBranch: repositoryProps.onTogglePinBranch,
			}),
		);
	});

	it("routes the files view through the repository-owned surface", async () => {
		const selection = createSelection();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={createRepositoryState()}
						repositoryProps={createRepositoryProps()}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="files"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[data-testid="files-view"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="scope-bar"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="branch-selector"]')).not.toBeNull();
		expect(mockFilesView).toHaveBeenCalledWith(
			expect.objectContaining({
				rootPath: "/tmp/task-detail",
				scopeKey: "task-1-contextual",
			}),
		);
	});

	it("uses assigned metadata identity for detached task file roots", async () => {
		const selection = createSelection();
		const repositoryState = createRepositoryState();
		repositoryState.taskRepositoryInfo = {
			taskId: selection.card.id,
			path: "/tmp/assigned-worktree",
			exists: true,
			baseRef: selection.card.baseRef,
			branch: null,
			isDetached: true,
			headCommit: "deadbeef12345678",
		};

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={repositoryState}
						repositoryProps={createRepositoryProps()}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="files"
					/>
				</TooltipProvider>,
			);
		});

		expect(mockFilesView).toHaveBeenCalledWith(
			expect.objectContaining({
				rootPath: "/tmp/assigned-worktree",
			}),
		);
	});

	it("uses assigned metadata identity for detached git branch labels", async () => {
		const selection = createSelection();
		const repositoryState = createRepositoryState();
		repositoryState.taskRepositoryInfo = {
			taskId: selection.card.id,
			path: "/tmp/assigned-worktree",
			exists: true,
			baseRef: selection.card.baseRef,
			branch: null,
			isDetached: true,
			headCommit: "deadbeef12345678",
		};

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={repositoryState}
						repositoryProps={createRepositoryProps()}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="git"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[data-testid="git-branch-status"]')?.textContent).toContain("deadbeef");
		expect(container.textContent).toContain("detached from main");
	});

	it("does not call shared checkout detached HEAD an independent task worktree", async () => {
		const selection = createSelection();
		selection.card = {
			...selection.card,
			branch: null,
			useWorktree: false,
			workingDirectory: null,
		};
		const repositoryState = createRepositoryState();
		repositoryState.homeGitSummary = {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		};
		repositoryState.pillBranchLabel = "detached HEAD";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={repositoryState}
						repositoryProps={createRepositoryProps()}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="files"
					/>
				</TooltipProvider>,
			);
		});

		expect(mockScopeBar).toHaveBeenCalledWith(expect.objectContaining({ taskIsDetached: false }));
		expect(mockBranchSelectorPopover).toHaveBeenCalledWith(
			expect.objectContaining({ detachedWorktreeBaseRef: undefined }),
		);
		expect(mockBranchPillTrigger).toHaveBeenCalledWith(
			expect.objectContaining({ detachedWorktreeBaseRef: undefined }),
		);
	});

	it("keeps detached task tooltip off branch-view pill labels", async () => {
		const selection = createSelection();
		const repositoryState = createRepositoryState();
		repositoryState.taskResolvedScope = { type: "branch_view", ref: "origin/main", projectId: "project-1" };
		repositoryState.taskScopeMode = "branch_view";
		repositoryState.pillBranchLabel = "origin/main";
		repositoryState.taskRepositoryInfo = {
			taskId: selection.card.id,
			path: "/tmp/assigned-worktree",
			exists: true,
			baseRef: selection.card.baseRef,
			branch: null,
			isDetached: true,
			headCommit: "deadbeef12345678",
		};

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskDetailRepositorySurface
						detailLayout={createLayoutState()}
						repositoryState={repositoryState}
						repositoryProps={createRepositoryProps()}
						selection={selection}
						currentProjectId="project-1"
						sessionSummary={null}
						mainView="files"
					/>
				</TooltipProvider>,
			);
		});

		expect(mockBranchSelectorPopover).toHaveBeenCalledWith(
			expect.objectContaining({
				detachedWorktreeBaseRef: "main",
				detachedWorktreeHeadCommit: "deadbeef12345678",
			}),
		);
		expect(mockBranchPillTrigger).toHaveBeenCalledWith(
			expect.objectContaining({
				label: "origin/main",
				detachedWorktreeBaseRef: undefined,
				detachedWorktreeHeadCommit: undefined,
			}),
		);
	});
});
