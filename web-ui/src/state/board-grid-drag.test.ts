import { describe, expect, it } from "vitest";
import { resolveBoardGridDrop } from "@/state/board-grid-drag";
import type { BoardData } from "@/types";

const card = (id: string, unstarted = false) => ({
	id,
	unstarted,
	title: id,
	prompt: id,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
});
const board: BoardData = {
	columns: [
		{ id: "in_progress", title: "In Progress", cards: [card("working")] },
		{ id: "review", title: "Review", cards: [card("ready"), card("draft", true)] },
		{ id: "trash", title: "Trash", cards: [card("archived")] },
	],
};
describe("grid drag lifecycle intent", () => {
	it("resolves the task identity and collapsed section independently of rendered positions", () => {
		expect(resolveBoardGridDrop(board, "draft", "trash")).toMatchObject({
			draggableId: "draft",
			source: { droppableId: "review", index: 1 },
			destination: { droppableId: "trash", index: 1 },
		});
	});
	it("preserves lifecycle restrictions, including when dropping onto a card", () => {
		expect(resolveBoardGridDrop(board, "working", "ready")).toBeNull();
		expect(resolveBoardGridDrop(board, "ready", "working")).toBeNull();
		expect(resolveBoardGridDrop(board, "draft", "working")?.destination?.droppableId).toBe("in_progress");
		expect(resolveBoardGridDrop(board, "archived", "ready")?.destination?.droppableId).toBe("review");
		expect(resolveBoardGridDrop(board, "missing", "review")).toBeNull();
	});
	it("carries programmatic top insertion through the same lifecycle path", () => {
		expect(
			resolveBoardGridDrop(board, "working", "review", {
				taskId: "working",
				fromColumnId: "in_progress",
				toColumnId: "review",
				insertAtTop: true,
			})?.destination,
		).toEqual({ droppableId: "review", index: 0 });
	});
});
