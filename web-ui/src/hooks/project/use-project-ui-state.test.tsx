import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useProjectUiState } from "@/hooks/project/use-project-ui-state";

type ProjectUiStateResult = ReturnType<typeof useProjectUiState>;
type ProjectUiStateInput = Parameters<typeof useProjectUiState>[0];

const PROJECTS: ProjectUiStateInput["projects"] = [
	{
		id: "project-a",
		name: "project-a",
		path: "/tmp/project-a",
		boardRevision: 0,
		taskCounts: { backlog: 1, in_progress: 0, review: 1, trash: 0 },
	},
	{
		id: "project-b",
		name: "project-b",
		path: "/tmp/project-b",
		boardRevision: 0,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
	},
];

function createInput(overrides: Partial<ProjectUiStateInput> = {}): ProjectUiStateInput {
	return {
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

	it("keeps revisioned streamed pill counts during a cached project switch", async () => {
		let latestResult: ProjectUiStateResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({
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
			backlog: 0,
			in_progress: 0,
			review: 0,
			trash: 0,
		});
		expect(result.displayedProjects).toBe(PROJECTS);
	});

	it("keeps streamed pill counts while no project snapshot is displayed", async () => {
		let latestResult: ProjectUiStateResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({
						isAwaitingProjectSnapshot: true,
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
