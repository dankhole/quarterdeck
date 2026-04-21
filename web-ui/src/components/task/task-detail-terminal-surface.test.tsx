import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailTerminalProps } from "@/components/task/task-detail-screen";
import { TaskDetailTerminalSurface } from "@/components/task/task-detail-terminal-surface";
import type { CardDetailViewLayoutState, CardDetailViewTerminalState } from "@/hooks/board/use-card-detail-view";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const { mockAgentTerminalPanel, mockShellTerminalPanel } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn(),
	mockShellTerminalPanel: vi.fn(),
}));

vi.mock("@/components/terminal", () => ({
	AgentTerminalPanel: (props: object) => {
		mockAgentTerminalPanel(props);
		return <div data-testid="agent-terminal-panel" />;
	},
	ShellTerminalPanel: (props: object) => {
		mockShellTerminalPanel(props);
		return <div data-testid="shell-terminal-panel" />;
	},
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => (
		<div data-testid="bottom-terminal-pane">{children}</div>
	),
}));

function createCard(id: string, autoReviewEnabled = false): BoardCard {
	return {
		id,
		title: "Task detail",
		prompt: `Task ${id}`,
		startInPlanMode: false,
		autoReviewEnabled,
		autoReviewMode: "move_to_trash",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(autoReviewEnabled = false): CardSelection {
	const card = createCard("task-1", autoReviewEnabled);
	const columns: BoardColumn[] = [{ id: "review", title: "Review", cards: [card] }];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createLayoutState(): Pick<CardDetailViewLayoutState, "mainRowRef"> {
	return {
		mainRowRef: { current: null },
	};
}

function createTerminalState(): CardDetailViewTerminalState {
	return {
		onSessionSummary: () => {},
		onCancelAutomaticTaskAction: () => {},
		isTaskTerminalEnabled: true,
	};
}

function createTerminalProps(bottomTerminalOpen = false): TaskDetailTerminalProps {
	return {
		bottomTerminalOpen,
		bottomTerminalTaskId: bottomTerminalOpen ? "task-1" : null,
		bottomTerminalSummary: null,
		onBottomTerminalClose: () => {},
		onBottomTerminalCollapse: () => {},
		bottomTerminalPaneHeight: 240,
		onBottomTerminalPaneHeightChange: () => {},
		onBottomTerminalConnectionReady: () => {},
		bottomTerminalAgentCommand: "npm test",
		onBottomTerminalSendAgentCommand: () => {},
		isBottomTerminalExpanded: false,
		onBottomTerminalToggleExpand: () => {},
		onBottomTerminalRestart: () => {},
		onBottomTerminalExit: () => {},
	};
}

describe("TaskDetailTerminalSurface", () => {
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
		mockAgentTerminalPanel.mockClear();
		mockShellTerminalPanel.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		mockAgentTerminalPanel.mockClear();
		mockShellTerminalPanel.mockClear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders the task agent terminal with the detail terminal styling and auto-review action", async () => {
		await act(async () => {
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection(true)}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={createTerminalState()}
					sessionSummary={null}
					terminalProps={createTerminalProps(false)}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).not.toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				projectId: "project-1",
				panelBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
				terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
				cancelAutomaticActionLabel: "Cancel Auto-trash",
			}),
		);
	});

	it("renders the bottom shell pane only when the detail shell is open", async () => {
		await act(async () => {
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={createTerminalState()}
					sessionSummary={null}
					terminalProps={createTerminalProps(true)}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="bottom-terminal-pane"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="shell-terminal-panel"]')).not.toBeNull();
		expect(mockShellTerminalPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				projectId: "project-1",
				panelBackgroundColor: TERMINAL_THEME_COLORS.surfaceRaised,
				terminalBackgroundColor: TERMINAL_THEME_COLORS.surfaceRaised,
			}),
		);
	});
});
