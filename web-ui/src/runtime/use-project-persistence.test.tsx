import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeProjectStateResponse, RuntimeProjectStateSaveRequest } from "@/runtime/types";
import { useProjectPersistence } from "@/runtime/use-project-persistence";
import type { BoardData } from "@/types";

function createBoard(taskId: string): BoardData {
	const board = createInitialBoardData();
	const backlogColumn = board.columns.find((column) => column.id === "backlog");
	if (!backlogColumn) {
		throw new Error("Missing backlog column.");
	}
	backlogColumn.cards.push({
		id: taskId,
		title: null,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	});
	return board;
}

function createPersistResponse(board: BoardData): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.quarterdeck",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board,
		sessions: {},
		revision: 2,
	};
}

function HookHarness({
	board,
	hydrationNonce,
	shouldSkipPersistOnHydration,
	canPersistProjectState = true,
	persistProjectState,
}: {
	board: BoardData;
	hydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	canPersistProjectState?: boolean;
	persistProjectState: (input: {
		projectId: string;
		payload: RuntimeProjectStateSaveRequest;
	}) => Promise<RuntimeProjectStateResponse>;
}): null {
	useProjectPersistence({
		board,
		currentProjectId: "project-a",
		projectRevision: 1,
		hydrationNonce,
		shouldSkipPersistOnHydration,
		canPersistProjectState,
		isDocumentVisible: true,
		isProjectStateRefreshing: false,
		persistProjectState,
		refetchProjectState: vi.fn(async () => undefined),
		onProjectRevisionChange: vi.fn(),
	});
	return null;
}

describe("useProjectPersistence", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("skips the immediate persist after a pure authoritative hydration", async () => {
		const board = createBoard("task-1");
		const persistProjectState = vi.fn(async () => createPersistResponse(board));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					hydrationNonce={0}
					shouldSkipPersistOnHydration
					canPersistProjectState={false}
					persistProjectState={persistProjectState}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					hydrationNonce={1}
					shouldSkipPersistOnHydration
					canPersistProjectState={true}
					persistProjectState={persistProjectState}
				/>,
			);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(150);
		});

		expect(persistProjectState).not.toHaveBeenCalled();
	});

	it("persists the first hydration when runtime projection changed the board", async () => {
		const board = createBoard("task-1");
		const persistProjectState = vi.fn(async () => createPersistResponse(board));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					hydrationNonce={0}
					shouldSkipPersistOnHydration
					canPersistProjectState={false}
					persistProjectState={persistProjectState}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					hydrationNonce={1}
					shouldSkipPersistOnHydration={false}
					canPersistProjectState={true}
					persistProjectState={persistProjectState}
				/>,
			);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(150);
		});

		expect(persistProjectState).toHaveBeenCalledTimes(1);
		expect(persistProjectState).toHaveBeenCalledWith({
			projectId: "project-a",
			payload: {
				board,
				expectedRevision: 1,
			},
		});
	});
});
