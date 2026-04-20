import { describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

import { projectBoardWithSessionColumns, resolveSessionColumnProjectionMove } from "./session-column-sync";

function createBoardWithTask(columnId: "backlog" | "in_progress" | "review" | "trash", taskId: string) {
	const board = createInitialBoardData();
	for (const column of board.columns) {
		column.cards = [];
	}
	const column = board.columns.find((entry) => entry.id === columnId);
	if (!column) {
		throw new Error(`Missing column ${columnId}.`);
	}
	column.cards.push({
		id: taskId,
		title: null,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	});
	return board;
}

function createSummary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		projectPath: "/tmp/project",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

describe("resolveSessionColumnProjectionMove", () => {
	it("moves in-progress cards to review when runtime state awaits review", () => {
		const board = createBoardWithTask("in_progress", "task-1");

		expect(resolveSessionColumnProjectionMove(board, createSummary("task-1", "awaiting_review"))).toEqual({
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			skipKickoff: false,
		});
	});

	it("moves review cards back to in-progress when runtime state resumes running", () => {
		const board = createBoardWithTask("review", "task-1");

		expect(resolveSessionColumnProjectionMove(board, createSummary("task-1", "running"))).toEqual({
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			skipKickoff: true,
		});
	});

	it("does not project backlog or trash cards", () => {
		expect(
			resolveSessionColumnProjectionMove(
				createBoardWithTask("backlog", "task-1"),
				createSummary("task-1", "awaiting_review"),
			),
		).toBeNull();
		expect(
			resolveSessionColumnProjectionMove(createBoardWithTask("trash", "task-1"), createSummary("task-1", "running")),
		).toBeNull();
	});
});

describe("projectBoardWithSessionColumns", () => {
	it("projects authoritative board state to runtime-owned review column placement", () => {
		const board = createBoardWithTask("in_progress", "task-1");

		const result = projectBoardWithSessionColumns(board, [createSummary("task-1", "awaiting_review")]);

		expect(result.changed).toBe(true);
		expect(result.moves).toHaveLength(1);
		expect(result.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
		expect(result.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");
	});

	it("leaves already-aligned board state untouched", () => {
		const board = createBoardWithTask("review", "task-1");

		const result = projectBoardWithSessionColumns(board, [createSummary("task-1", "awaiting_review")]);

		expect(result.changed).toBe(false);
		expect(result.board).toBe(board);
		expect(result.moves).toEqual([]);
	});
});
