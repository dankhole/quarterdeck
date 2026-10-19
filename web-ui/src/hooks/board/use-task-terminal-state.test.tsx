import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingTaskLifecycleOperation } from "@/hooks/board/use-task-lifecycle-operations";
import { type TaskTerminalState, useTaskTerminalState } from "@/hooks/board/use-task-terminal-state";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { CardSelection } from "@/types";

const { useBoardContextMock, restartSession } = vi.hoisted(() => ({
	useBoardContextMock: vi.fn(),
	restartSession: vi.fn(),
}));
vi.mock("@/providers/board-provider", () => ({ useBoardContext: useBoardContextMock }));
vi.mock("@/providers/interactions-provider", () => ({
	useInteractionsContext: () => ({ handleRestartTaskSession: restartSession }),
}));

function createSelection(columnId: "review" | "in_progress" | "trash" = "review", unstarted = false): CardSelection {
	const card = {
		id: "task-1",
		title: "Saved chat",
		prompt: "Task",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		unstarted,
	};
	const column = { id: columnId, title: columnId, cards: [card] };
	return { card, column, allColumns: [column] };
}

function Harness({
	selection,
	onState,
}: {
	selection: CardSelection;
	onState: (state: TaskTerminalState) => void;
}): null {
	onState(useTaskTerminalState(selection));
	return null;
}

describe("useTaskTerminalState", () => {
	let container: HTMLDivElement;
	let root: Root;
	let state: TaskTerminalState;
	let previousActEnvironment: boolean | undefined;
	let summary: RuntimeTaskSessionSummary;
	let pending: Record<string, PendingTaskLifecycleOperation>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		root = createRoot(container);
		restartSession.mockReset();
		summary = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			resumeSessionId: "saved-session",
		});
		pending = {};
		useBoardContextMock.mockImplementation(() => ({
			sessions: { "task-1": summary },
			upsertSession: vi.fn(),
			taskLifecycle: { pendingTaskLifecycleById: pending },
		}));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined)
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		else
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
	});

	async function render(selection = createSelection()): Promise<void> {
		await act(async () =>
			root.render(
				<Harness
					selection={selection}
					onState={(next) => {
						state = next;
					}}
				/>,
			),
		);
	}

	it("opens a saved Review chat without launching and resumes only on explicit action", async () => {
		await render();
		expect(state.isSessionProcessless).toBe(true);
		expect(restartSession).not.toHaveBeenCalled();
		act(() => state.onResumeSession());
		expect(restartSession).toHaveBeenCalledExactlyOnceWith("task-1");
		expect(summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			resumeSessionId: "saved-session",
		});
	});

	it("blocks resume only while an actual lifecycle operation is pending", async () => {
		pending["task-1"] = { operationId: "restart-1", kind: "restart", label: "Preparing worktree" };
		await render();
		expect(state.pendingSessionLabel).toBe("Preparing worktree");
		act(() => state.onResumeSession());
		expect(restartSession).not.toHaveBeenCalled();
		pending = {};
		summary = { ...summary, startupRecoveryRequired: true };
		await render();
		expect(state.pendingSessionLabel).toBeNull();
		act(() => state.onResumeSession());
		expect(restartSession).toHaveBeenCalledExactlyOnceWith("task-1");
	});

	it("does not infer a processless session from a missing summary", async () => {
		useBoardContextMock.mockReturnValueOnce({
			sessions: {},
			upsertSession: vi.fn(),
			taskLifecycle: { pendingTaskLifecycleById: {} },
		});
		await render();
		expect(state.isTaskTerminalEnabled).toBe(true);
		expect(state.isSessionProcessless).toBe(false);
		act(() => state.onResumeSession());
		expect(restartSession).not.toHaveBeenCalled();
	});

	it("keeps a live Review session on its terminal and does not replace it", async () => {
		summary = { ...summary, pid: 1234 };
		await render();
		expect(state.isTaskTerminalEnabled).toBe(true);
		expect(state.isSessionProcessless).toBe(false);
		act(() => state.onResumeSession());
		expect(restartSession).not.toHaveBeenCalled();
	});

	it.each([createSelection("review", true), createSelection("trash")])(
		"does not resume a terminal-disabled task",
		async (selection) => {
			await render(selection);
			expect(state.isTaskTerminalEnabled).toBe(false);
			expect(state.isSessionProcessless).toBe(false);
			act(() => state.onResumeSession());
			expect(restartSession).not.toHaveBeenCalled();
		},
	);
});
