import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { TaskTrashWarningViewModel } from "@/components/task";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import type { BoardCard, BoardColumnId } from "@/types";

import {
	createBoard,
	HookHarness,
	type HookSnapshot,
	requireSnapshot,
	useTestEnvironment,
} from "./linked-backlog-actions-test-harness";

describe("useLinkedBacklogTaskActions", () => {
	const ctx = useTestEnvironment();

	it("creates a dependency link between tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			ctx.root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateDependency("task-1", "task-2");
		});

		expect(requireSnapshot(latestSnapshot).board.dependencies).toEqual([
			expect.objectContaining({ fromTaskId: "task-1", toTaskId: "task-2" }),
		]);
	});

	it("trashes through one server-owned lifecycle command while keeping the optimistic move", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);
		await act(async () => {
			ctx.root.render(
				<HookHarness
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		const initial = requireSnapshot(latestSnapshot);
		const reviewTask = initial.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initial.confirmMoveTaskToTrash(reviewTask, initial.board, "review");
		});

		expect(executeTaskLifecycle).toHaveBeenCalledOnce();
		expect(executeTaskLifecycle).toHaveBeenCalledWith({
			kind: "trash",
			taskId: reviewTask.id,
			taskCreatedAt: reviewTask.createdAt,
			sourceColumnId: "review",
		});
		const next = requireSnapshot(latestSnapshot).board;
		expect(next.columns.find((column) => column.id === "review")?.cards).toEqual([]);
		expect(next.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe(reviewTask.id);
	});

	it("sends only the parent trash intent when dependencies become unblocked", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);
		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		const initial = requireSnapshot(latestSnapshot);
		const reviewTask = initial.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initial.confirmMoveTaskToTrash(reviewTask, initial.board, "review");
		});

		// Linked-child discovery and starts are part of the same durable server
		// operation. React must not launch child sessions independently.
		expect(executeTaskLifecycle).toHaveBeenCalledOnce();
		expect(executeTaskLifecycle.mock.calls[0]?.[0]).toMatchObject({
			kind: "trash",
			taskId: "task-2",
		});
	});

	it("routes a direct request through the same lifecycle boundary", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);
		await act(async () => {
			ctx.root.render(
				<HookHarness
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).requestMoveTaskToTrash("task-2", "review");
		});

		expect(executeTaskLifecycle).toHaveBeenCalledWith({
			kind: "trash",
			taskId: "task-2",
			taskCreatedAt: 2,
			sourceColumnId: "review",
		});
	});

	it("defers the durable command until the trash confirmation is accepted", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		let requestedCard: BoardCard | null = null;
		let requestedSource: BoardColumnId | null = null;
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);
		const onRequestTrashConfirmation = vi.fn(
			(_viewModel: TaskTrashWarningViewModel, card: BoardCard, fromColumnId: BoardColumnId) => {
				requestedCard = card;
				requestedSource = fromColumnId;
			},
		);
		await act(async () => {
			ctx.root.render(
				<HookHarness
					executeTaskLifecycle={executeTaskLifecycle}
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		const initial = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initial.requestMoveTaskToTrash("task-2", "review");
		});
		expect(onRequestTrashConfirmation).toHaveBeenCalledOnce();
		expect(executeTaskLifecycle).not.toHaveBeenCalled();
		if (!requestedCard || requestedSource === "trash") {
			throw new Error("Expected a confirmed non-trash task.");
		}
		const confirmedCard = requestedCard as BoardCard;
		const confirmedSource = requestedSource as unknown as Exclude<BoardColumnId, "trash">;

		await act(async () => {
			await requireSnapshot(latestSnapshot).confirmMoveTaskToTrash(confirmedCard, initial.board, confirmedSource);
		});
		expect(executeTaskLifecycle).toHaveBeenCalledOnce();
	});

	it("keeps the original source identity for an already-optimistic drag", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		let confirmation: { card: BoardCard; source: BoardColumnId; optimisticMoveApplied: boolean } | undefined;
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);
		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={() => {
						const board = createBoard();
						const review = board.columns.find((column) => column.id === "review");
						const trash = board.columns.find((column) => column.id === "trash");
						if (review && trash) {
							trash.cards = review.cards;
							review.cards = [];
						}
						return board;
					}}
					executeTaskLifecycle={executeTaskLifecycle}
					onRequestTrashConfirmation={(_viewModel, card, source, optimisticMoveApplied) => {
						confirmation = { card, source, optimisticMoveApplied };
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).requestMoveTaskToTrash("task-2", "review", {
				optimisticMoveApplied: true,
			});
		});
		expect(confirmation).toMatchObject({ source: "review", optimisticMoveApplied: true });
		if (!confirmation || confirmation.source === "trash") {
			throw new Error("Expected an optimistic trash confirmation.");
		}
		const confirmed = confirmation as {
			card: BoardCard;
			source: Exclude<BoardColumnId, "trash">;
			optimisticMoveApplied: boolean;
		};
		await act(async () => {
			await requireSnapshot(latestSnapshot).confirmMoveTaskToTrash(
				confirmed.card,
				requireSnapshot(latestSnapshot).board,
				confirmed.source,
			);
		});
		expect(executeTaskLifecycle).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "trash", sourceColumnId: "review" }),
		);
	});
});
