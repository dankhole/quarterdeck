import type { DropResult } from "@hello-pangea/dnd";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type UseProjectNavigationPanelResult,
	useProjectNavigationPanel,
} from "@/hooks/project/use-project-navigation-panel";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";

function makeProject(id: string, name = id): RuntimeProjectSummary {
	return {
		id,
		name,
		path: `/tmp/${id}`,
		taskCounts: {
			backlog: 1,
			in_progress: 2,
			review: 3,
			trash: 4,
		},
	};
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		projectPath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createDropResult(sourceIndex: number, destinationIndex: number): DropResult {
	return {
		draggableId: "project-1",
		type: "DEFAULT",
		source: {
			droppableId: "project-list",
			index: sourceIndex,
		},
		destination: {
			droppableId: "project-list",
			index: destinationIndex,
		},
		reason: "DROP",
		mode: "FLUID",
		combine: null,
	};
}

function HookHarness({
	props,
	onValue,
}: {
	props: Parameters<typeof useProjectNavigationPanel>[0];
	onValue: (result: UseProjectNavigationPanelResult) => void;
}): null {
	const value = useProjectNavigationPanel(props);
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

describe("useProjectNavigationPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestValue: UseProjectNavigationPanelResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestValue = null as unknown as UseProjectNavigationPanelResult;
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

	function renderHook(props: Parameters<typeof useProjectNavigationPanel>[0]): void {
		act(() => {
			root.render(createElement(HookHarness, { props, onValue: (value) => (latestValue = value) }));
		});
	}

	it("counts only approval-state sessions by project", () => {
		renderHook({
			projects: [makeProject("project-1"), makeProject("project-2")],
			removingProjectId: null,
			onRemoveProject: vi.fn(async () => true),
			notificationProjectIds: {
				"task-1": "project-1",
				"task-2": "project-1",
				"task-3": "project-2",
			},
			notificationSessions: {
				"task-1": makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "permissionRequest",
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
				"task-2": makeSummary({ state: "running" }),
				"task-3": makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: "Waiting for approval",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: null,
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			},
		});

		expect(latestValue.needsInputByProject).toEqual({
			"project-1": 1,
			"project-2": 1,
		});
	});

	it("reorders projects optimistically and resets when the project list changes", () => {
		const onReorderProjects = vi.fn(async () => {});
		const projects = [makeProject("project-1"), makeProject("project-2"), makeProject("project-3")];

		renderHook({
			projects,
			removingProjectId: null,
			onRemoveProject: vi.fn(async () => true),
			onReorderProjects,
			notificationSessions: {},
			notificationProjectIds: {},
		});

		act(() => {
			latestValue.handleDragEnd(createDropResult(0, 2));
		});

		expect(latestValue.displayedProjects.map((project) => project.id)).toEqual([
			"project-2",
			"project-3",
			"project-1",
		]);
		expect(onReorderProjects).toHaveBeenCalledWith(["project-2", "project-3", "project-1"]);

		renderHook({
			projects: [projects[0]!, projects[1]!, makeProject("project-4")],
			removingProjectId: null,
			onRemoveProject: vi.fn(async () => true),
			onReorderProjects,
			notificationSessions: {},
			notificationProjectIds: {},
		});

		expect(latestValue.displayedProjects.map((project) => project.id)).toEqual([
			"project-1",
			"project-2",
			"project-4",
		]);
	});

	it("tracks removal dialog state and confirms project removal", async () => {
		const onRemoveProject = vi.fn(async () => true);

		renderHook({
			projects: [makeProject("project-1"), makeProject("project-2")],
			removingProjectId: null,
			onRemoveProject,
			notificationSessions: {},
			notificationProjectIds: {},
		});

		act(() => {
			latestValue.requestProjectRemoval("project-2");
		});

		expect(latestValue.pendingProjectRemoval?.id).toBe("project-2");
		expect(latestValue.pendingProjectTaskCount).toBe(10);

		await act(async () => {
			await latestValue.confirmProjectRemoval();
		});

		expect(onRemoveProject).toHaveBeenCalledWith("project-2");
		expect(latestValue.pendingProjectRemoval).toBeNull();
	});
});
