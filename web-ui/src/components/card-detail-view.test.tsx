import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const mockUseRuntimeWorkspaceChanges = vi.fn();
const { mockAgentTerminalPanel, mockDiffViewerPanel } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
	mockDiffViewerPanel: vi.fn((..._args: unknown[]) => null),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: unknown) => {
		mockDiffViewerPanel(props);
		return <div data-testid="diff-viewer-panel" />;
	},
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: () => <div data-testid="file-tree-panel" />,
}));

vi.mock("@/components/detail-panels/detail-toolbar", () => ({
	DetailToolbar: () => <div data-testid="detail-toolbar" />,
	TOOLBAR_WIDTH: 40,
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

function requireDetailDiffSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize detail diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a detail diff resize separator.");
	}
	return separator;
}

function requireDetailDiffFileTreePanel(container: HTMLElement): HTMLElement {
	const separator = requireDetailDiffSeparator(container);
	const panel = separator.previousElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected a detail diff file tree panel element.");
	}
	return panel;
}

function renderWithProviders(root: Root, ui: ReactNode): void {
	root.render(<TooltipProvider>{ui}</TooltipProvider>);
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
		mockDiffViewerPanel.mockClear();
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
		mockDiffViewerPanel.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("collapses the expanded diff on Escape without closing the detail view", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expandButton.click();
		});

		const toolbarButtons = Array.from(container.querySelectorAll("button"));
		expect(toolbarButtons[0]?.getAttribute("aria-label")).toBe("Collapse expanded diff view");
		expect(toolbarButtons[1]?.textContent?.trim()).toBe("All Changes");
		expect(toolbarButtons[2]?.textContent?.trim()).toBe("Last Turn");
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeNull();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(container.querySelector('button[aria-label="Collapse expanded diff view"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("clears stale diff content when switching from all changes to last turn", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastTurnButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Last Turn",
		);
		expect(lastTurnButton).toBeInstanceOf(HTMLButtonElement);
		if (!(lastTurnButton instanceof HTMLButtonElement)) {
			throw new Error("Expected a Last Turn button.");
		}

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		const lastCall = mockUseRuntimeWorkspaceChanges.mock.calls.at(-1);
		expect(lastCall?.[3]).toBe("last_turn");
		expect(lastCall?.[7]).toBe(true);
	});

	it("closes git history before handling other Escape behavior", async () => {
		const onCloseGitHistory = vi.fn();

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					gitHistoryPanel={<div data-testid="git-history-panel">Git history</div>}
					onCloseGitHistory={onCloseGitHistory}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(onCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});

	it("loads the saved side panel ratio from local storage", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidePanelRatio, "0.30");

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireSidePanel(container).style.flex).toBe("0 0 30%");
	});

	it("persists the resized side panel ratio globally", async () => {
		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
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

		const savedRatioRaw = window.localStorage.getItem(LocalStorageKey.DetailSidePanelRatio);
		expect(savedRatioRaw).not.toBeNull();
		const savedRatio = Number(savedRatioRaw);
		expect(savedRatio).toBeGreaterThan(0.25);
		expect(savedRatio).toBeLessThanOrEqual(0.45);
	});

	it("keeps the saved side panel position after leaving and reopening task detail", async () => {
		const renderDetail = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<CardDetailView
						selection={createSelection()}
						currentProjectId="workspace-1"
						sessionSummary={null}
						taskSessions={{}}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
		};

		await renderDetail();

		const separator = requireSidePanelSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 420 }));
		});

		const expectedRatio = window.localStorage.getItem(LocalStorageKey.DetailSidePanelRatio);
		expect(expectedRatio).not.toBeNull();

		await act(async () => {
			root.unmount();
			root = createRoot(container);
		});

		await renderDetail();

		const restoredFlex = requireSidePanel(container).style.flex;
		const restoredRatio = Number.parseFloat(restoredFlex.split(" ").pop() ?? "") / 100;
		expect(restoredRatio).toBeCloseTo(Number(expectedRatio), 2);
	});

	it("uses separate file-tree ratios for collapsed and expanded diff layouts", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");
		window.localStorage.setItem(LocalStorageKey.DetailDiffFileTreePanelRatio, "0.42");
		window.localStorage.setItem(LocalStorageKey.DetailExpandedDiffFileTreePanelRatio, "0.18");

		await act(async () => {
			renderWithProviders(
				root,
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 42%");

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.click();
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 18%");
	});
});
