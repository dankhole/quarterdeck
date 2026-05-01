import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BoardContext, type BoardContextValue } from "@/providers/board-provider";
import { ProjectContext, type ProjectContextValue } from "@/providers/project-provider";
import {
	type SurfaceNavigationContextValue,
	SurfaceNavigationProvider,
	useSurfaceNavigationContext,
} from "@/providers/surface-navigation-provider";

function HookHarness({ onValue }: { onValue: (result: SurfaceNavigationContextValue) => void }): null {
	const value = useSurfaceNavigationContext();
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

function createBoardContextValue(overrides: Partial<BoardContextValue> = {}): BoardContextValue {
	return {
		selectedTaskId: null,
		setSelectedTaskId: () => {},
		...overrides,
	} as unknown as BoardContextValue;
}

function createProjectContextValue(overrides: Partial<ProjectContextValue> = {}): ProjectContextValue {
	return {
		hasNoProjects: false,
		isProjectSwitching: false,
		...overrides,
	} as unknown as ProjectContextValue;
}

describe("SurfaceNavigationProvider", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestValue: SurfaceNavigationContextValue;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestValue = null as unknown as SurfaceNavigationContextValue;
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

	function renderProvider({
		board = {},
		project = {},
	}: {
		board?: Partial<BoardContextValue>;
		project?: Partial<ProjectContextValue>;
	} = {}): void {
		act(() => {
			root.render(
				createElement(
					ProjectContext.Provider,
					{ value: createProjectContextValue(project) },
					createElement(
						BoardContext.Provider,
						{ value: createBoardContextValue(board) },
						createElement(
							SurfaceNavigationProvider,
							null,
							createElement(HookHarness, { onValue: (value) => (latestValue = value) }),
						),
					),
				),
			);
		});
	}

	it("opens git history through the surface seam and switches to the git view", () => {
		renderProvider();

		expect(latestValue.mainView).toBe("home");
		expect(latestValue.isGitHistoryOpen).toBe(false);

		act(() => {
			latestValue.handleToggleGitHistory();
		});

		expect(latestValue.isGitHistoryOpen).toBe(true);
		expect(latestValue.mainView).toBe("git");
	});

	it("routes file navigation through the surface seam without going through GitContext", () => {
		renderProvider();

		act(() => {
			latestValue.navigateToFile({ targetView: "files", filePath: "src/app.tsx", lineNumber: 12 });
		});

		expect(latestValue.mainView).toBe("files");
		expect(latestValue.pendingFileNavigation).toEqual({
			targetView: "files",
			filePath: "src/app.tsx",
			lineNumber: 12,
		});
	});

	it("stores the active file search scope for global search overlays", () => {
		renderProvider();

		expect(latestValue.activeFileSearchScope).toEqual({ taskId: null });

		act(() => {
			latestValue.setActiveFileSearchScope({ taskId: "task-1", baseRef: "main" });
		});

		expect(latestValue.activeFileSearchScope).toEqual({ taskId: "task-1", baseRef: "main" });
	});

	it("keeps git history closed when no project is available", () => {
		renderProvider({ project: { hasNoProjects: true } });

		act(() => {
			latestValue.handleToggleGitHistory();
		});

		expect(latestValue.isGitHistoryOpen).toBe(false);
		expect(latestValue.mainView).toBe("home");
	});
});
