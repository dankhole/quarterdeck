import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailTerminalProps } from "@/components/task/task-detail-screen";
import { TaskDetailTerminalSurface } from "@/components/task/task-detail-terminal-surface";
import type { CardDetailViewLayoutState, CardDetailViewTerminalState } from "@/hooks/board/use-card-detail-view";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const { mockAgentTerminalPanel, mockShellTerminalPanel, agentMount, agentUnmount } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn(),
	mockShellTerminalPanel: vi.fn(),
	agentMount: vi.fn(),
	agentUnmount: vi.fn(),
}));

vi.mock("@/components/terminal", () => ({
	AgentTerminalPanel: (props: object) => {
		mockAgentTerminalPanel(props);
		useEffect(() => {
			agentMount();
			return () => {
				agentUnmount();
			};
		}, []);
		return <div data-testid="agent-terminal-panel" />;
	},
	ShellTerminalPanel: (props: object) => {
		mockShellTerminalPanel(props);
		return <div data-testid="shell-terminal-panel" />;
	},
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => (
		<div data-testid="bottom-terminal-pane">{children}</div>
	),
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: "Task detail",
		prompt: `Task ${id}`,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [{ id: "review", title: "Review", cards: [card] }];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createLayoutState(): Pick<CardDetailViewLayoutState, "mainRowRef"> {
	return {
		mainRowRef: { current: null },
	};
}

function createTerminalState(): CardDetailViewTerminalState {
	return {
		onSessionSummary: () => {},
		isTaskTerminalEnabled: true,
		isSessionProcessless: false,
		pendingSessionLabel: null,
		onResumeSession: vi.fn(),
	};
}

function createTerminalProps(bottomTerminalOpen = false): TaskDetailTerminalProps {
	return {
		bottomTerminalOpen,
		bottomTerminalTaskId: bottomTerminalOpen ? "task-1" : null,
		bottomTerminalSummary: null,
		onBottomTerminalClose: () => {},
		onBottomTerminalCollapse: () => {},
		bottomTerminalPaneHeight: 240,
		onBottomTerminalPaneHeightChange: () => {},
		onBottomTerminalConnectionReady: () => {},
		bottomTerminalAgentCommand: "npm test",
		onBottomTerminalSendAgentCommand: () => {},
		isBottomTerminalExpanded: false,
		onBottomTerminalToggleExpand: () => {},
		onBottomTerminalRestart: () => {},
		onBottomTerminalExit: () => {},
	};
}

describe("TaskDetailTerminalSurface", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockShellTerminalPanel.mockClear();
		agentMount.mockClear();
		agentUnmount.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		mockAgentTerminalPanel.mockClear();
		mockShellTerminalPanel.mockClear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders the task agent terminal with the detail terminal styling", async () => {
		await act(async () => {
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={createTerminalState()}
					sessionSummary={null}
					terminalProps={createTerminalProps(false)}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).not.toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				projectId: "project-1",
				panelBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
				terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
			}),
		);
	});

	it("offers explicit resume above the retained terminal for a saved processless chat", async () => {
		const terminalState = { ...createTerminalState(), isSessionProcessless: true };
		const summary = createTestTaskSessionSummary({
			pid: null,
			state: "awaiting_review",
			reviewReason: "hook",
			resumeSessionId: "saved-session",
		});
		await act(async () =>
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={terminalState}
					sessionSummary={summary}
					terminalProps={createTerminalProps()}
				/>,
			),
		);
		expect(container.textContent).toContain("Chat is not running");
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).not.toBeNull();
		expect(terminalState.onResumeSession).not.toHaveBeenCalled();
		const resumeButton = container.querySelector("button");
		expect(resumeButton?.textContent).toBe("Resume chat");
		await act(async () => resumeButton?.click());
		expect(terminalState.onResumeSession).toHaveBeenCalledTimes(1);
	});

	it("shows pending launch progress without a second resume action", async () => {
		await act(async () =>
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={{
						...createTerminalState(),
						isSessionProcessless: true,
						pendingSessionLabel: "Preparing worktree",
					}}
					sessionSummary={null}
					terminalProps={createTerminalProps()}
				/>,
			),
		);
		expect(container.querySelector('[role="status"]')?.textContent).toContain("Preparing worktree");
		expect(container.querySelector("button")).toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalled();
	});

	it("keeps live agent terminals and the optional shell available", async () => {
		const summary = createTestTaskSessionSummary({ pid: 1234, state: "awaiting_review", reviewReason: "hook" });
		await act(async () =>
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={createTerminalState()}
					sessionSummary={summary}
					terminalProps={createTerminalProps(true)}
				/>,
			),
		);
		expect(mockAgentTerminalPanel).toHaveBeenCalledWith(expect.objectContaining({ summary, terminalEnabled: true }));
		expect(container.querySelector('[data-testid="shell-terminal-panel"]')).not.toBeNull();
		expect(container.textContent).not.toContain("Chat is not running");
	});

	it("preserves the same terminal and its output across process exit and resume", async () => {
		const terminalState = createTerminalState();
		const summary = createTestTaskSessionSummary({
			pid: 1234,
			state: "awaiting_review",
			reviewReason: "hook",
			resumeSessionId: "saved-session",
		});
		async function render(isSessionProcessless: boolean): Promise<void> {
			await act(async () =>
				root.render(
					<TaskDetailTerminalSurface
						selection={createSelection()}
						currentProjectId="project-1"
						layoutState={createLayoutState()}
						terminalState={{ ...terminalState, isSessionProcessless }}
						sessionSummary={{ ...summary, pid: isSessionProcessless ? null : 1234 }}
						terminalProps={createTerminalProps(true)}
					/>,
				),
			);
		}
		await render(false);
		const terminal = container.querySelector('[data-testid="agent-terminal-panel"]');
		if (!terminal) throw new Error("Expected an agent terminal.");
		// Simulate provider output held in the terminal's own DOM, outside React.
		terminal.textContent = "Provider fatal exit detail";
		await render(true);
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).toBe(terminal);
		expect(container.textContent).toContain("Provider fatal exit detail");
		expect(container.textContent).toContain("Chat is not running");
		expect(container.querySelector('[data-testid="shell-terminal-panel"]')).not.toBeNull();
		await render(false);
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).toBe(terminal);
		expect(container.textContent).not.toContain("Chat is not running");
		expect(agentMount).toHaveBeenCalledTimes(1);
		expect(agentUnmount).not.toHaveBeenCalled();
	});

	it("renders the bottom shell pane only when the detail shell is open", async () => {
		await act(async () => {
			root.render(
				<TaskDetailTerminalSurface
					selection={createSelection()}
					currentProjectId="project-1"
					layoutState={createLayoutState()}
					terminalState={createTerminalState()}
					sessionSummary={null}
					terminalProps={createTerminalProps(true)}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="bottom-terminal-pane"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="shell-terminal-panel"]')).not.toBeNull();
		expect(mockShellTerminalPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				projectId: "project-1",
				panelBackgroundColor: TERMINAL_THEME_COLORS.surfaceRaised,
				terminalBackgroundColor: TERMINAL_THEME_COLORS.surfaceRaised,
			}),
		);
	});
});
