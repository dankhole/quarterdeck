import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { TooltipProvider } from "@/components/ui/tooltip";
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
	board: { columns: [], dependencies: [] },
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
};

function renderWithProviders(root: Root, ui: ReactNode): void {
	root.render(
		<CardActionsProvider stable={noopStableActions} reactive={noopReactiveState}>
			<TooltipProvider>{ui}</TooltipProvider>
		</CardActionsProvider>,
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
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
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
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
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
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
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
