import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColumnContextPanel } from "@/components/terminal/column-context-panel";
import { CardActionsProvider, type ReactiveCardState, type StableCardActions } from "@/state/card-actions-context";
import type { BoardColumn, CardSelection } from "@/types";

const noopStableActions: StableCardActions = {};
const noopReactiveState: ReactiveCardState = {
	moveToTrashLoadingById: {},
	isLlmGenerationDisabled: false,
	showSummaryOnCards: false,
	uncommittedChangesOnCardsEnabled: false,
};

vi.mock("@/components/board/board-card", () => ({
	BoardCard: ({
		card,
		selected,
	}: {
		card: { id: string; prompt: string };
		selected?: boolean;
	}): React.ReactElement => {
		return (
			<div data-task-id={card.id} data-selected={selected ? "true" : "false"}>
				{card.prompt}
			</div>
		);
	},
}));

vi.mock("@/state/sort-column-cards", () => ({
	sortColumnCards: (cards: unknown[]) => cards,
}));

function createCard(id: string, prompt: string) {
	return {
		id,
		title: null,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(columns: BoardColumn[], taskId: string): CardSelection {
	for (const column of columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: columns,
			};
		}
	}
	throw new Error(`Could not find task ${taskId}.`);
}

describe("ColumnContextPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		scrollIntoViewMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoViewMock,
		});
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("centers the selected detail card when the selection changes", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Backlog task")] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("task-2", "In progress task")] },
			{ id: "review", title: "Review", cards: [createCard("task-3", "Review task")] },
			{ id: "trash", title: "Trash", cards: [] },
		];

		await act(async () => {
			root.render(
				<CardActionsProvider stable={noopStableActions} reactive={noopReactiveState}>
					<ColumnContextPanel
						selection={createSelection(columns, "task-2")}
						onCardSelect={() => {}}
						taskSessions={{}}
					/>
				</CardActionsProvider>,
			);
		});

		expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
		expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
			block: "center",
			inline: "nearest",
		});

		await act(async () => {
			root.render(
				<CardActionsProvider stable={noopStableActions} reactive={noopReactiveState}>
					<ColumnContextPanel
						selection={createSelection(columns, "task-3")}
						onCardSelect={() => {}}
						taskSessions={{}}
					/>
				</CardActionsProvider>,
			);
		});

		expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
		expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
			block: "center",
			inline: "nearest",
		});
	});
});
