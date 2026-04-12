import { describe, expect, it } from "vitest";

import {
	findCardColumnId,
	isAllowedCrossColumnCardMove,
	isCardDropDisabled,
	type ProgrammaticCardMoveInFlight,
} from "@/state/drag-rules";
import type { BoardCard, BoardColumn } from "@/types";

describe("isAllowedCrossColumnCardMove", () => {
	it("allows backlog -> in_progress", () => {
		expect(isAllowedCrossColumnCardMove("backlog", "in_progress")).toBe(true);
	});

	it("allows any column -> trash (except trash itself)", () => {
		expect(isAllowedCrossColumnCardMove("backlog", "trash")).toBe(true);
		expect(isAllowedCrossColumnCardMove("in_progress", "trash")).toBe(true);
		expect(isAllowedCrossColumnCardMove("review", "trash")).toBe(true);
	});

	it("disallows trash -> trash", () => {
		expect(isAllowedCrossColumnCardMove("trash", "trash")).toBe(false);
	});

	it("allows trash -> review", () => {
		expect(isAllowedCrossColumnCardMove("trash", "review")).toBe(true);
	});

	it("disallows in_progress -> review without programmatic move", () => {
		expect(isAllowedCrossColumnCardMove("in_progress", "review")).toBe(false);
	});

	it("disallows review -> in_progress without programmatic move", () => {
		expect(isAllowedCrossColumnCardMove("review", "in_progress")).toBe(false);
	});

	it("allows in_progress -> review with matching programmatic move", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};
		expect(
			isAllowedCrossColumnCardMove("in_progress", "review", {
				taskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("rejects in_progress -> review with mismatched task id", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};
		expect(
			isAllowedCrossColumnCardMove("in_progress", "review", {
				taskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
	});

	it("allows review -> in_progress with matching programmatic move", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};
		expect(
			isAllowedCrossColumnCardMove("review", "in_progress", {
				taskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("rejects in_progress -> review with null taskId", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};
		expect(
			isAllowedCrossColumnCardMove("in_progress", "review", {
				taskId: null,
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
	});

	it("disallows backlog -> review", () => {
		expect(isAllowedCrossColumnCardMove("backlog", "review")).toBe(false);
	});

	it("disallows review -> backlog", () => {
		expect(isAllowedCrossColumnCardMove("review", "backlog")).toBe(false);
	});

	it("disallows in_progress -> backlog", () => {
		expect(isAllowedCrossColumnCardMove("in_progress", "backlog")).toBe(false);
	});

	it("disallows trash -> in_progress", () => {
		expect(isAllowedCrossColumnCardMove("trash", "in_progress")).toBe(false);
	});

	it("disallows trash -> backlog", () => {
		expect(isAllowedCrossColumnCardMove("trash", "backlog")).toBe(false);
	});
});

describe("findCardColumnId", () => {
	const card = (id: string, title: string): BoardCard => ({
		id,
		title,
		prompt: "",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	});

	const columns: BoardColumn[] = [
		{ id: "backlog", title: "Backlog", cards: [card("task-1", "A")] },
		{ id: "in_progress", title: "In Progress", cards: [card("task-2", "B")] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "trash", title: "Trash", cards: [card("task-3", "C")] },
	];

	it("finds task in backlog", () => {
		expect(findCardColumnId(columns, "task-1")).toBe("backlog");
	});

	it("finds task in in_progress", () => {
		expect(findCardColumnId(columns, "task-2")).toBe("in_progress");
	});

	it("finds task in trash", () => {
		expect(findCardColumnId(columns, "task-3")).toBe("trash");
	});

	it("returns null when task not found", () => {
		expect(findCardColumnId(columns, "task-999")).toBeNull();
	});

	it("returns null for empty columns", () => {
		expect(findCardColumnId([], "task-1")).toBeNull();
	});
});

describe("isCardDropDisabled", () => {
	it("allows drop when no active drag source", () => {
		expect(isCardDropDisabled("backlog", null)).toBe(false);
	});

	it("keeps manual in-progress to review drops disabled", () => {
		expect(isCardDropDisabled("review", "in_progress")).toBe(true);
	});

	it("allows the matching programmatic in-progress to review drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("allows the matching programmatic review to in-progress drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: {
					...move,
					toColumnId: "review",
				},
			}),
		).toBe(true);
	});

	it("allows manual trash to review drops", () => {
		expect(isCardDropDisabled("review", "trash")).toBe(false);
	});

	it("disables drop on backlog from non-backlog source", () => {
		expect(isCardDropDisabled("backlog", "in_progress")).toBe(true);
		expect(isCardDropDisabled("backlog", "review")).toBe(true);
		expect(isCardDropDisabled("backlog", "trash")).toBe(true);
	});

	it("allows reordering within backlog", () => {
		expect(isCardDropDisabled("backlog", "backlog")).toBe(false);
	});

	it("allows backlog -> in_progress", () => {
		expect(isCardDropDisabled("in_progress", "backlog")).toBe(false);
	});

	it("allows reordering within in_progress", () => {
		expect(isCardDropDisabled("in_progress", "in_progress")).toBe(false);
	});

	it("disables trash -> trash (no reordering in trash)", () => {
		expect(isCardDropDisabled("trash", "trash")).toBe(true);
	});

	it("allows any column -> trash except trash itself", () => {
		expect(isCardDropDisabled("trash", "backlog")).toBe(false);
		expect(isCardDropDisabled("trash", "in_progress")).toBe(false);
		expect(isCardDropDisabled("trash", "review")).toBe(false);
	});
});
