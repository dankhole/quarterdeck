import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailSidePanelProps } from "@/components/task/task-detail-screen";
import { TaskDetailSidePanelSurface } from "@/components/task/task-detail-side-panel";
import type { CardDetailViewLayoutState, CardDetailViewSidePanelState } from "@/hooks/board/use-card-detail-view";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const { mockCommitPanel, mockColumnContextPanel } = vi.hoisted(() => ({
	mockCommitPanel: vi.fn(),
	mockColumnContextPanel: vi.fn(),
}));

vi.mock("@/components/git/panels", () => ({
	CommitPanel: (props: object) => {
		mockCommitPanel(props);
		return <div data-testid="commit-panel" />;
	},
}));

vi.mock("@/components/terminal", () => ({
	ColumnContextPanel: (props: object) => {
		mockColumnContextPanel(props);
		return <div data-testid="column-context-panel" />;
	},
}));

vi.mock("@/resize/resize-handle", () => ({
	ResizeHandle: () => <div data-testid="side-panel-resize-handle" />,
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: "Task detail",
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
	const columns: BoardColumn[] = [{ id: "in_progress", title: "In Progress", cards: [card] }];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
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

function createSidePanelState(): CardDetailViewSidePanelState {
	return {
		taskSessions: {},
	};
}

function createSidePanelProps(): TaskDetailSidePanelProps {
	return {
		navigateToFile: () => {},
		onCardSelect: () => {},
		onCardDoubleClick: () => {},
		onCreateTask: () => {},
		onStartAllTasks: () => {},
		onClearTrash: () => {},
		onEditTask: () => {},
	};
}

describe("TaskDetailSidePanelSurface", () => {
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
		mockCommitPanel.mockClear();
		mockColumnContextPanel.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		mockCommitPanel.mockClear();
		mockColumnContextPanel.mockClear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders the commit panel when the task sidebar is in commit mode", async () => {
		await act(async () => {
			root.render(
				<TaskDetailSidePanelSurface
					selection={createSelection()}
					currentProjectId="project-1"
					sidebar="commit"
					layoutState={createLayoutState()}
					sidePanelState={createSidePanelState()}
					sidePanelProps={createSidePanelProps()}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="commit-panel"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="side-panel-resize-handle"]')).not.toBeNull();
		expect(mockCommitPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				taskId: "task-1",
				baseRef: "main",
			}),
		);
	});

	it("renders the column context panel when the task sidebar is in board mode", async () => {
		await act(async () => {
			root.render(
				<TaskDetailSidePanelSurface
					selection={createSelection()}
					currentProjectId="project-1"
					sidebar="task_column"
					layoutState={createLayoutState()}
					sidePanelState={createSidePanelState()}
					sidePanelProps={createSidePanelProps()}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="column-context-panel"]')).not.toBeNull();
		expect(mockColumnContextPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				panelWidth: "100%",
				taskSessions: {},
			}),
		);
	});
});
