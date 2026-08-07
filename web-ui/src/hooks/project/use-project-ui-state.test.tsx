import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useProjectUiState } from "@/hooks/project/use-project-ui-state";
import type { BoardData } from "@/types";

type ProjectUiStateResult = ReturnType<typeof useProjectUiState>;
type ProjectUiStateInput = Parameters<typeof useProjectUiState>[0];

function createBoard({ backlog = 0, review = 0 }: { backlog?: number; review?: number } = {}): BoardData {
	const createCards = (prefix: string, count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `${prefix}-${index}`,
			title: null,
			prompt: `${prefix} task ${index}`,
			baseRef: "main",
			createdAt: index,
			updatedAt: index,
		}));
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: createCards("backlog", backlog) },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: createCards("review", review) },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

const PROJECTS: ProjectUiStateInput["projects"] = [
	{
		id: "project-a",
		name: "project-a",
		path: "/tmp/project-a",
		taskCounts: { backlog: 1, in_progress: 0, review: 1, trash: 0 },
	},
	{
		id: "project-b",
		name: "project-b",
		path: "/tmp/project-b",
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
	},
];

function createInput(overrides: Partial<ProjectUiStateInput> = {}): ProjectUiStateInput {
	return {
		board: createBoard(),
		boardProjectId: "project-b",
		projects: PROJECTS,
		navigationCurrentProjectId: "project-b",
		selectedTaskId: null,
		streamError: null,
		isProjectSwitching: false,
		isInitialRuntimeLoad: false,
		isAwaitingProjectSnapshot: false,
		isProjectMetadataPending: true,
		isServedFromBoardCache: false,
		hasReceivedSnapshot: true,
		...overrides,
	};
}

function HookHarness({
	input,
	onResult,
}: {
	input: ProjectUiStateInput;
	onResult: (result: ProjectUiStateResult) => void;
}): null {
	const result = useProjectUiState(input);

	onResult(result);
	return null;
}

describe("useProjectUiState", () => {
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
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("keeps the project loading state visible while project metadata is still syncing", async () => {
		let latestResult: ProjectUiStateResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput()}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		if (latestResult === null) {
			throw new Error("Expected a hook result.");
		}
		const result: ProjectUiStateResult = latestResult;
		expect(result.shouldShowProjectLoadingState).toBe(true);
		expect(result.shouldUseNavigationPath).toBe(true);
	});

	it("uses the displayed cached board for the target project's task pills during a switch", async () => {
		let latestResult: ProjectUiStateResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({
						board: createBoard({ backlog: 2, review: 1 }),
						boardProjectId: "project-b",
						isProjectSwitching: true,
						isServedFromBoardCache: true,
					})}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		if (latestResult === null) {
			throw new Error("Expected a hook result.");
		}
		const result: ProjectUiStateResult = latestResult;
		expect(result.displayedProjects.find((project) => project.id === "project-a")?.taskCounts).toEqual({
			backlog: 1,
			in_progress: 0,
			review: 1,
			trash: 0,
		});
		expect(result.displayedProjects.find((project) => project.id === "project-b")?.taskCounts).toEqual({
			backlog: 2,
			in_progress: 0,
			review: 1,
			trash: 0,
		});
	});

	it("keeps streamed pill counts when no board project is displayed", async () => {
		let latestResult: ProjectUiStateResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({
						board: createBoard({ backlog: 2, review: 1 }),
						boardProjectId: null,
					})}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		if (latestResult === null) {
			throw new Error("Expected a hook result.");
		}
		const result: ProjectUiStateResult = latestResult;
		expect(result.displayedProjects).toBe(PROJECTS);
	});
});
