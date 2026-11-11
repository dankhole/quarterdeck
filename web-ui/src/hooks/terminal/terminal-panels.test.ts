import { describe, expect, it } from "vitest";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import {
	computeTerminalPaneHeight,
	EXPANDED_TERMINAL_PANE_HEIGHT,
	estimateShellTerminalCols,
	getUnexpectedShellExitInstance,
	MIN_TERMINAL_COLS,
} from "./terminal-panels";

// ---------------------------------------------------------------------------
// estimateShellTerminalCols
// ---------------------------------------------------------------------------

describe("estimateShellTerminalCols", () => {
	it("returns at least MIN_TERMINAL_COLS", () => {
		const cols = estimateShellTerminalCols();
		expect(cols).toBeGreaterThanOrEqual(MIN_TERMINAL_COLS);
	});

	it("returns a positive integer", () => {
		const cols = estimateShellTerminalCols();
		expect(Number.isInteger(cols)).toBe(true);
		expect(cols).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// computeTerminalPaneHeight
// ---------------------------------------------------------------------------

describe("computeTerminalPaneHeight", () => {
	it("returns expanded sentinel when expanded", () => {
		expect(computeTerminalPaneHeight(true, 300)).toBe(EXPANDED_TERMINAL_PANE_HEIGHT);
	});

	it("returns persisted height when not expanded", () => {
		expect(computeTerminalPaneHeight(false, 400)).toBe(400);
	});

	it("returns undefined when not expanded and no persisted height", () => {
		expect(computeTerminalPaneHeight(false, undefined)).toBeUndefined();
	});
});

describe("getUnexpectedShellExitInstance", () => {
	const exited = createTestTaskSessionSummary({
		taskId: "__home_terminal__",
		agentId: null,
		sessionInstanceId: "exited-instance",
		pid: null,
		state: "idle",
		reviewReason: null,
		exitCode: 1,
	});
	it("requires a positively identified unexpected shell exit", () => {
		expect(getUnexpectedShellExitInstance(exited)).toBe("exited-instance");
		expect(getUnexpectedShellExitInstance(null)).toBeNull();
	});
	it.each([
		{ sessionInstanceId: null },
		{ agentId: "codex" as const },
		{ pid: 123 },
		{ state: "running" as const },
		{ state: "awaiting_review" as const, reviewReason: "interrupted" as const },
		{ reviewReason: "interrupted" as const },
		{ exitCode: null },
		{ exitCode: 0 },
	])("rejects intentional, live, ambiguous, and successful exits: %j", (overrides) => {
		expect(getUnexpectedShellExitInstance({ ...exited, ...overrides })).toBeNull();
	});
});
