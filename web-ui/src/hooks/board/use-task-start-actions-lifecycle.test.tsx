import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import type { PreparedTaskCreation } from "@/hooks/board/use-task-editor";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import { useTaskStartActions } from "@/hooks/board/use-task-start-actions";
import type { BoardCard, BoardData } from "@/types";

interface HookSnapshot {
	board: BoardData;
	handleCreateAndStartTask: ReturnType<typeof useTaskStartActions>["handleCreateAndStartTask"];
}

interface HookHarnessProps {
	prepareCreateTaskForLifecycle: () => PreparedTaskCreation | null;
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	onSnapshot: (snapshot: HookSnapshot) => void;
}

function HookHarness({ prepareCreateTaskForLifecycle, executeTaskLifecycle, onSnapshot }: HookHarnessProps): null {
	const [board, setBoard] = useState(createInitialBoardData);
	const actions = useTaskStartActions({
		presentLifecycleBoard: setBoard,
		prepareCreateTaskForLifecycle,
		executeTaskLifecycle,
		setSelectedTaskId: () => {},
	});
	useEffect(() => {
		onSnapshot({ board, ...actions });
	}, [actions, board, onSnapshot]);
	return null;
}

function createTask(id: string, createdAt: number, agentId: BoardCard["agentId"] = "codex"): BoardCard {
	return {
		id,
		title: null,
		prompt: `Prompt ${id}`,
		images: [],
		baseRef: "main",
		agentId,
		useWorktree: true,
		branch: `feature/${id}`,
		createdAt,
		updatedAt: createdAt,
	};
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

describe("useTaskStartActions lifecycle creation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestSnapshot: HookSnapshot | null;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		latestSnapshot = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("presents one optimistic card and sends one create-and-start command", async () => {
		const task = { ...createTask("task-1", 100), codexOptions: { model: "test-model", reasoningEffort: "high" } };
		const executeTaskLifecycle = vi.fn(async () => null);
		await act(async () => {
			root.render(
				<HookHarness
					prepareCreateTaskForLifecycle={() => ({ task })}
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		let taskId: string | null = null;
		await act(async () => {
			taskId = requireSnapshot(latestSnapshot).handleCreateAndStartTask();
		});

		expect(taskId).toBe("task-1");
		expect(
			requireSnapshot(latestSnapshot).board.columns.find((column) => column.id === "in_progress")?.cards,
		).toEqual([task]);
		expect(executeTaskLifecycle).toHaveBeenCalledWith({
			kind: "create_and_start",
			startedAt: 100,
			task: {
				taskId: "task-1",
				title: null,
				prompt: "Prompt task-1",
				images: [],
				baseRef: "main",
				agentId: "codex",
				codexOptions: task.codexOptions,
				useWorktree: true,
				branch: "feature/task-1",
				pinned: undefined,
				createdAt: 100,
			},
		});
	});

	it("preserves Pi ownership in create-and-start commands", async () => {
		const task = createTask("task-pi", 101, "pi");
		const executeTaskLifecycle = vi.fn(async () => null);
		await act(async () => {
			root.render(
				<HookHarness
					prepareCreateTaskForLifecycle={() => ({ task })}
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateAndStartTask();
		});

		expect(executeTaskLifecycle).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "create_and_start",
				task: expect.objectContaining({ taskId: "task-pi", agentId: "pi" }),
			}),
		);
	});
});
