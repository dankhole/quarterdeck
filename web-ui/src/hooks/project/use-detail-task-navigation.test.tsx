import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	type UseDetailTaskNavigationResult,
	useDetailTaskNavigation,
} from "@/hooks/project/use-detail-task-navigation";
import type { BoardData } from "@/types";

interface HookInput {
	board: BoardData;
	currentProjectId: string | null;
	boardProjectId: string | null;
	hasReceivedSnapshot: boolean;
	isProjectMetadataPending: boolean;
}

function createBoardWithTask(taskId: string): BoardData {
	const board = createInitialBoardData();
	const reviewColumn = board.columns.find((column) => column.id === "review");
	if (!reviewColumn) {
		throw new Error("Expected the review column.");
	}
	reviewColumn.cards.push({
		id: taskId,
		title: "Deep-linked task",
		prompt: "Deep-linked task",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	});
	return board;
}

function HookHarness({
	input,
	onResult,
}: {
	input: HookInput;
	onResult: (result: UseDetailTaskNavigationResult) => void;
}): null {
	const result = useDetailTaskNavigation(input);
	useEffect(() => {
		onResult(result);
	}, [onResult, result]);
	return null;
}

describe("useDetailTaskNavigation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestResult: UseDetailTaskNavigationResult | null;
	let previousActEnvironment: boolean | undefined;
	const onResult = (result: UseDetailTaskNavigationResult): void => {
		latestResult = result;
	};

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.history.replaceState(null, "", "/project");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestResult = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		window.history.replaceState(null, "", "/");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(input: HookInput): void {
		act(() => {
			root.render(<HookHarness input={input} onResult={onResult} />);
		});
	}

	it("preserves a task deep link while the initial project hydrates", () => {
		window.history.replaceState(null, "", "/project?task=task-1");
		render({
			board: createInitialBoardData(),
			currentProjectId: null,
			boardProjectId: null,
			hasReceivedSnapshot: false,
			isProjectMetadataPending: false,
		});

		render({
			board: createBoardWithTask("task-1"),
			currentProjectId: "project",
			boardProjectId: "project",
			hasReceivedSnapshot: true,
			isProjectMetadataPending: false,
		});

		expect(latestResult?.selectedTaskId).toBe("task-1");
		expect(latestResult?.selectedCard?.card.id).toBe("task-1");
		expect(window.location.search).toBe("?task=task-1");
	});

	it("keeps a deep link while the global snapshot precedes the project board", () => {
		window.history.replaceState(null, "", "/project?task=task-1");
		render({
			board: createInitialBoardData(),
			currentProjectId: "project",
			boardProjectId: null,
			hasReceivedSnapshot: true,
			isProjectMetadataPending: true,
		});

		expect(latestResult?.selectedTaskId).toBe("task-1");
		expect(window.location.search).toBe("?task=task-1");

		render({
			board: createBoardWithTask("task-1"),
			currentProjectId: "project",
			boardProjectId: "project",
			hasReceivedSnapshot: true,
			isProjectMetadataPending: false,
		});

		expect(latestResult?.selectedCard?.card.id).toBe("task-1");
		expect(window.location.search).toBe("?task=task-1");
	});

	it("clears task selection when switching between resolved projects", () => {
		window.history.replaceState(null, "", "/project-a?task=task-1");
		const board = createBoardWithTask("task-1");
		render({
			board,
			currentProjectId: "project-a",
			boardProjectId: "project-a",
			hasReceivedSnapshot: true,
			isProjectMetadataPending: false,
		});

		render({
			board,
			currentProjectId: "project-b",
			boardProjectId: "project-a",
			hasReceivedSnapshot: true,
			isProjectMetadataPending: true,
		});

		expect(latestResult?.selectedTaskId).toBeNull();
		expect(window.location.search).toBe("");
	});
});
