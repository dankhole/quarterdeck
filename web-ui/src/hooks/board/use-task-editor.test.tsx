import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskEditor } from "@/hooks/board/use-task-editor";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard, BoardData, TaskImage } from "@/types";

function createTask(taskId: string, prompt: string, createdAt: number, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: null,
		prompt,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function createBoard(tasks: BoardCard[] = []): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: tasks },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

interface HookSnapshot {
	board: BoardData;
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	newTaskImages: TaskImage[];
	newTaskAgentId: "claude" | "codex" | "pi";
	newTaskBranchRef: string;
	editingTaskId: string | null;
	editTaskPrompt: string;
	handleOpenCreateTask: () => void;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskImages: (value: TaskImage[]) => void;
	setNewTaskAgentId: (value: "claude" | "codex" | "pi") => void;
	setNewTaskBranchRef: (value: string) => void;
	handleOpenEditTask: (task: BoardCard) => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	setEditTaskPrompt: (value: string) => void;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	initialBoard,
	onSnapshot,
	queueTaskStartAfterEdit,
	branchOptions = [{ value: "main", label: "main" }],
	defaultTaskBranchRef = "main",
	fallbackTaskAgentId = "claude",
	availableTaskAgentIds = ["claude", "codex", "pi"],
}: {
	initialBoard: BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	queueTaskStartAfterEdit?: (taskId: string) => void;
	branchOptions?: Array<{ value: string; label: string }>;
	defaultTaskBranchRef?: string;
	fallbackTaskAgentId?: "claude" | "codex" | "pi";
	availableTaskAgentIds?: Array<"claude" | "codex" | "pi"> | null;
}): null {
	const [board, setBoard] = useState<BoardData>(initialBoard);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		currentProjectId: "project-1",
		createTaskBranchOptions: branchOptions,
		defaultTaskBranchRef,
		fallbackTaskAgentId,
		availableTaskAgentIds,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		onSnapshot({
			board,
			isInlineTaskCreateOpen: editor.isInlineTaskCreateOpen,
			newTaskPrompt: editor.newTaskPrompt,
			newTaskImages: editor.newTaskImages,
			newTaskAgentId: editor.newTaskAgentId,
			newTaskBranchRef: editor.newTaskBranchRef,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			handleOpenCreateTask: editor.handleOpenCreateTask,
			handleCreateTask: editor.handleCreateTask,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskImages: editor.setNewTaskImages,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskBranchRef: editor.setNewTaskBranchRef,
			handleOpenEditTask: editor.handleOpenEditTask,
			handleSaveEditedTask: editor.handleSaveEditedTask,
			handleSaveAndStartEditedTask: editor.handleSaveAndStartEditedTask,
			setEditTaskPrompt: editor.setEditTaskPrompt,
		});
	}, [
		board,
		editor.handleCreateTask,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editingTaskId,
		editor.handleOpenEditTask,
		editor.handleSaveEditedTask,
		editor.handleSaveAndStartEditedTask,
		editor.isInlineTaskCreateOpen,
		editor.newTaskPrompt,
		editor.newTaskImages,
		editor.newTaskAgentId,
		editor.newTaskBranchRef,
		editor.setEditTaskPrompt,
		editor.setNewTaskAgentId,
		editor.setNewTaskBranchRef,
		editor.setNewTaskImages,
		editor.setNewTaskPrompt,
		onSnapshot,
	]);

	return null;
}

describe("useTaskEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
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
		localStorage.clear();
	});

	it("returns the edited task id when saving a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		requireSnapshot(latestSnapshot);

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		let savedTaskId: string | null = null;
		await act(async () => {
			savedTaskId = latestSnapshot?.handleSaveEditedTask() ?? null;
		});

		expect(savedTaskId).toBe("task-1");
		expect(requireSnapshot(latestSnapshot).editingTaskId).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("queues the saved task id when saving and starting an edited task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		await act(async () => {
			latestSnapshot?.handleSaveAndStartEditedTask();
		});

		expect(queueTaskStartAfterEdit).toHaveBeenCalledWith("task-1");
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("keeps the create dialog open when requested after creating a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create another task");
		});

		await act(async () => {});
		expect(requireSnapshot(latestSnapshot).newTaskPrompt).toBe("Create another task");
		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("main");

		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(createdTaskId).toBeTruthy();
		expect(snapshot.isInlineTaskCreateOpen).toBe(true);
		expect(snapshot.newTaskPrompt).toBe("");
		expect(snapshot.newTaskBranchRef).toBe("main");
		expect(snapshot.board.columns[0]?.cards.some((card) => card.prompt === "Create another task")).toBe(true);
	});

	it("resets the create dialog base ref back to the default instead of remembering the last used branch", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					branchOptions={[
						{ value: "main", label: "main" },
						{ value: "develop", label: "develop" },
					]}
					defaultTaskBranchRef="main"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create from develop");
			requireSnapshot(latestSnapshot).setNewTaskBranchRef("develop");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards[0]?.baseRef).toBe("develop");
		expect(snapshot.newTaskBranchRef).toBe("main");
	});

	it("persists the selected agent on created tasks and remembers it for the next task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					fallbackTaskAgentId="claude"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Use Codex for this");
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards[0]?.agentId).toBe("codex");
		expect(snapshot.newTaskAgentId).toBe("codex");
		expect(localStorage.getItem(LocalStorageKey.TaskCreateLastAgentId)).toBe("codex");
	});

	it("uses the remembered agent when opening the create dialog", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		localStorage.setItem(LocalStorageKey.TaskCreateLastAgentId, "codex");

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					fallbackTaskAgentId="claude"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskAgentId).toBe("codex");
	});

	it("does not store the fallback agent as last used before selection", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					fallbackTaskAgentId="claude"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskAgentId).toBe("claude");
		expect(localStorage.getItem(LocalStorageKey.TaskCreateLastAgentId)).toBeNull();
	});

	it("falls back to the fallback agent when the remembered agent is unavailable", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		localStorage.setItem(LocalStorageKey.TaskCreateLastAgentId, "codex");

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					fallbackTaskAgentId="claude"
					availableTaskAgentIds={["claude"]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskAgentId).toBe("claude");
	});

	it("copies attached images to each split task and clears the draft images", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			latestSnapshot?.setNewTaskImages([
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			]);
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = latestSnapshot?.handleCreateTasks(["First task", "Second task"]) ?? [];
		});

		expect(createdTaskIds).toHaveLength(2);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(2);
		expect(backlogCards.map((card) => card.images)).toEqual([
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
		]);
		expect(requireSnapshot(latestSnapshot).newTaskImages).toEqual([]);
	});
});
