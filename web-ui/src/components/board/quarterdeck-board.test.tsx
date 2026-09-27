import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuarterdeckBoard, type RequestProgrammaticCardMove } from "@/components/board/quarterdeck-board";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CardActionsProvider, type ReactiveCardState } from "@/state/card-actions-context";
import type { BoardData } from "@/types";

const reactive: ReactiveCardState = {
	moveToTrashLoadingById: {},
	isLlmGenerationDisabled: false,
	showSummaryOnCards: false,
	showSummaryOnHover: true,
	uncommittedChangesOnCardsEnabled: false,
};
const card = (id: string, unstarted = false) => ({
	id,
	unstarted,
	title: id,
	prompt: `Prompt for ${id}`,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
});
const data: BoardData = {
	columns: [
		{ id: "in_progress", title: "In Progress", cards: [card("working")] },
		{ id: "review", title: "Review", cards: [card("draft", true)] },
		{ id: "trash", title: "Trash", cards: [card("archived")] },
	],
};

describe("QuarterdeckBoard grid", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});
	it("puts creation first and keeps Trash visible without mounting its cards until expanded", async () => {
		const create = vi.fn();
		await act(async () =>
			root.render(
				<TooltipProvider>
					<CardActionsProvider stable={{}} reactive={reactive}>
						<QuarterdeckBoard
							data={data}
							taskSessions={{}}
							onCardSelect={() => {}}
							onCreateTask={create}
							onDragEnd={() => {}}
						/>
					</CardActionsProvider>
				</TooltipProvider>,
			),
		);
		const createButton = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
		expect(
			createButton.compareDocumentPosition(container.querySelector('[data-column-id="in_progress"]')!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await act(async () => createButton.click());
		expect(create).toHaveBeenCalledOnce();
		expect(container.querySelector('[data-task-id="archived"]')).toBeNull();
		const trash = container.querySelector<HTMLButtonElement>('[aria-controls="board-trash-cards"]')!;
		expect(trash.textContent).toContain("Trash");
		expect(trash.getAttribute("aria-expanded")).toBe("false");
		await act(async () => trash.click());
		expect(container.querySelector('[data-task-id="archived"]')).not.toBeNull();
		expect(container.querySelectorAll(".kb-board-grid")).toHaveLength(3);
	});
	it("forwards programmatic moves through the existing lifecycle callback and unregisters on unmount", async () => {
		let request: RequestProgrammaticCardMove | null = null;
		const ready = (value: RequestProgrammaticCardMove | null) => {
			request = value;
		};
		const onDrop = vi.fn();
		await act(async () =>
			root.render(
				<TooltipProvider>
					<CardActionsProvider stable={{}} reactive={reactive}>
						<QuarterdeckBoard
							data={data}
							taskSessions={{}}
							onCardSelect={() => {}}
							onCreateTask={() => {}}
							onDragEnd={onDrop}
							onRequestProgrammaticCardMoveReady={ready}
						/>
					</CardActionsProvider>
				</TooltipProvider>,
			),
		);
		await act(async () =>
			expect(
				request?.({ taskId: "working", fromColumnId: "in_progress", toColumnId: "review", insertAtTop: true }),
			).toBe(true),
		);
		expect(onDrop).toHaveBeenCalledWith(
			expect.objectContaining({ draggableId: "working", destination: { droppableId: "review", index: 0 } }),
		);
		await act(async () => root.render(null));
		expect(request).toBeNull();
	});
});
