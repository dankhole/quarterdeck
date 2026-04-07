import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
	getWorkspacePath: () => "/mock/workspace",
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: null,
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

/** Wrap content in providers required by BoardCard's tooltip usage. */
function Providers({ children }: { children: ReactNode }): React.ReactElement {
	return <TooltipProvider>{children}</TooltipProvider>;
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockWorkspaceSnapshot = undefined;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<Harness />
				</Providers>,
			);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("shows a loading state on the review trash button while moving to trash", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />
				</Providers>,
			);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to trash"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={{
							taskId: "task-1",
							state: "running",
							agentId: "claude",
							workspacePath: "/tmp/worktree",
							pid: null,
							startedAt: Date.now(),
							updatedAt: Date.now(),
							lastOutputAt: Date.now(),
							reviewReason: null,
							exitCode: null,
							lastHookAt: Date.now(),
							latestHookActivity: {
								activityText: "Using Read",
								toolName: "Read",
								toolInputSummary: "src/index.ts",
								finalMessage: null,
								hookEventName: "tool_call",
								notificationType: null,
								source: "hook",
							},
							latestTurnCheckpoint: null,
							previousTurnCheckpoint: null,
						}}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows tool activity in the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", {
							agentId: "claude",
							latestHookActivity: {
								activityText: "Completed Read: src/index.ts",
								toolName: "Read",
								toolInputSummary: null,
								finalMessage: null,
								hookEventName: "PostToolUse",
								notificationType: null,
								source: "claude",
							},
						})}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", {
							agentId: "codex",
							latestHookActivity: {
								activityText: "Calling Read: src/index.ts",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								hookEventName: "raw_response_item",
								notificationType: null,
								source: "codex",
							},
						})}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("keeps showing the last tool label during assistant streaming", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={{
							taskId: "task-1",
							state: "running",
							agentId: "claude",
							workspacePath: "/tmp/worktree",
							pid: null,
							startedAt: Date.now(),
							updatedAt: Date.now(),
							lastOutputAt: Date.now(),
							reviewReason: null,
							exitCode: null,
							lastHookAt: Date.now(),
							latestHookActivity: {
								activityText: "Agent active",
								toolName: "Read",
								toolInputSummary: "src/index.ts",
								finalMessage: "Looking at the file now",
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "hook",
							},
							latestTurnCheckpoint: null,
							previousTurnCheckpoint: null,
						}}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", {
							latestHookActivity: {
								activityText: "Reviewing the final diff",
								toolName: null,
								toolInputSummary: null,
								finalMessage: "Reviewing the final diff",
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "hook",
							},
						})}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", {
							agentId: "codex",
							latestHookActivity: {
								activityText: "Agent: checking the next file",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								hookEventName: "agent_message",
								notificationType: null,
								source: "codex",
							},
						})}
					/>
				</Providers>,
			);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});
});
