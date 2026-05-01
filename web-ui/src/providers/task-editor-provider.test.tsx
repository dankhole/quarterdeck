import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardContext, type BoardContextValue } from "@/providers/board-provider";
import {
	ProjectNavigationContext,
	type ProjectNavigationContextValue,
	ProjectSyncContext,
	type ProjectSyncContextValue,
} from "@/providers/project-provider";
import { ProjectRuntimeContext, type ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import {
	type TaskEditorContextValue,
	TaskEditorProvider,
	useTaskEditorContext,
} from "@/providers/task-editor-provider";

const mockUseTaskEditor = vi.fn();
const mockUseTaskBranchOptions = vi.fn();

vi.mock("@/hooks/board/use-task-editor", () => ({
	useTaskEditor: (...args: unknown[]) => mockUseTaskEditor(...args),
}));

vi.mock("@/hooks/git/use-task-branch-options", () => ({
	useTaskBranchOptions: (...args: unknown[]) => mockUseTaskBranchOptions(...args),
}));

function HookHarness({ onValue }: { onValue: (value: TaskEditorContextValue) => void }): null {
	const value = useTaskEditorContext();
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

function createBoardContextValue(overrides: Partial<BoardContextValue> = {}): BoardContextValue {
	return {
		board: { columns: [], dependencies: [] },
		setBoard: () => {},
		setSelectedTaskId: () => {},
		...overrides,
	} as unknown as BoardContextValue;
}

function createProjectNavigationContextValue(
	overrides: Partial<ProjectNavigationContextValue> = {},
): ProjectNavigationContextValue {
	return {
		currentProjectId: "project-1",
		...overrides,
	} as unknown as ProjectNavigationContextValue;
}

function createProjectSyncContextValue(overrides: Partial<ProjectSyncContextValue> = {}): ProjectSyncContextValue {
	return {
		projectGit: {
			currentBranch: "feature/current",
			defaultBranch: "main",
			branches: [],
		},
		...overrides,
	} as unknown as ProjectSyncContextValue;
}

function createProjectRuntimeContextValue(
	overrides: Partial<ProjectRuntimeContextValue> = {},
): ProjectRuntimeContextValue {
	return {
		configDefaultBaseRef: "main",
		...overrides,
	} as unknown as ProjectRuntimeContextValue;
}

describe("TaskEditorProvider", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestValue: TaskEditorContextValue;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestValue = null as unknown as TaskEditorContextValue;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		mockUseTaskEditor.mockReset();
		mockUseTaskBranchOptions.mockReset();
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
		projectSync = {},
		projectRuntime = {},
	}: {
		board?: Partial<BoardContextValue>;
		project?: Partial<ProjectNavigationContextValue>;
		projectSync?: Partial<ProjectSyncContextValue>;
		projectRuntime?: Partial<ProjectRuntimeContextValue>;
	} = {}): void {
		act(() => {
			root.render(
				createElement(
					ProjectNavigationContext.Provider,
					{ value: createProjectNavigationContextValue(project) },
					createElement(
						ProjectSyncContext.Provider,
						{ value: createProjectSyncContextValue(projectSync) },
						createElement(
							ProjectRuntimeContext.Provider,
							{ value: createProjectRuntimeContextValue(projectRuntime) },
							createElement(
								BoardContext.Provider,
								{ value: createBoardContextValue(board) },
								createElement(
									TaskEditorProvider,
									null,
									createElement(HookHarness, { onValue: (value) => (latestValue = value) }),
								),
							),
						),
					),
				),
			);
		});
	}

	it("owns branch-option derivation and editor wiring outside BoardContext", () => {
		const mockTaskEditor = {
			handleCancelCreateTask: () => {},
			resetTaskEditorState: () => {},
			handleOpenCreateTask: () => {},
		};
		mockUseTaskBranchOptions.mockReturnValue({
			createTaskBranchOptions: [
				{ value: "main", label: "main (default)" },
				{ value: "release", label: "release" },
			],
			defaultTaskBranchRef: "main",
			isConfigDefaultBaseRef: true,
		});
		mockUseTaskEditor.mockReturnValue(mockTaskEditor);

		renderProvider();

		expect(mockUseTaskBranchOptions).toHaveBeenCalledWith({
			projectGit: expect.objectContaining({
				currentBranch: "feature/current",
				defaultBranch: "main",
			}),
			configDefaultBaseRef: "main",
		});
		expect(mockUseTaskEditor).toHaveBeenCalledWith(
			expect.objectContaining({
				currentProjectId: "project-1",
				createTaskBranchOptions: [
					{ value: "main", label: "main (default)" },
					{ value: "release", label: "release" },
				],
				defaultTaskBranchRef: "main",
			}),
		);
		expect(latestValue.createTaskBranchOptions).toEqual([
			{ value: "main", label: "main (default)" },
			{ value: "release", label: "release" },
		]);
		expect(latestValue.taskEditor).toBe(mockTaskEditor);
	});

	it("clears the edit-start bridge when resetting the task editor workflow", () => {
		const mockResetTaskEditorState = vi.fn();
		let queueTaskStartAfterEdit: ((taskId: string) => void) | undefined;

		mockUseTaskBranchOptions.mockReturnValue({
			createTaskBranchOptions: [{ value: "main", label: "main" }],
			defaultTaskBranchRef: "main",
			isConfigDefaultBaseRef: true,
		});
		mockUseTaskEditor.mockImplementation((input: { queueTaskStartAfterEdit?: (taskId: string) => void }) => {
			queueTaskStartAfterEdit = input.queueTaskStartAfterEdit;
			return {
				handleCancelCreateTask: () => {},
				resetTaskEditorState: mockResetTaskEditorState,
				handleOpenCreateTask: () => {},
			};
		});

		renderProvider();

		act(() => {
			queueTaskStartAfterEdit?.("task-123");
		});

		expect(latestValue.pendingTaskStartAfterEditId).toBe("task-123");

		act(() => {
			latestValue.resetTaskEditorWorkflow();
		});

		expect(mockResetTaskEditorState).toHaveBeenCalledTimes(1);
		expect(latestValue.pendingTaskStartAfterEditId).toBeNull();
	});

	it("keeps resetTaskEditorWorkflow stable when the task editor object rerenders", () => {
		const mockResetTaskEditorState = vi.fn();
		const mockHandleOpenCreateTask = vi.fn();

		mockUseTaskBranchOptions.mockReturnValue({
			createTaskBranchOptions: [{ value: "main", label: "main" }],
			defaultTaskBranchRef: "main",
			isConfigDefaultBaseRef: true,
		});
		mockUseTaskEditor.mockImplementation(() => ({
			handleCancelCreateTask: () => {},
			resetTaskEditorState: mockResetTaskEditorState,
			handleOpenCreateTask: mockHandleOpenCreateTask,
		}));

		renderProvider();
		const firstResetTaskEditorWorkflow = latestValue.resetTaskEditorWorkflow;

		renderProvider();

		expect(mockUseTaskEditor).toHaveBeenCalledTimes(2);
		expect(latestValue.resetTaskEditorWorkflow).toBe(firstResetTaskEditorWorkflow);
	});
});
