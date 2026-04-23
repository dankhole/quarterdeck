import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard, getCardHoverTooltip } from "@/components/board/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskHookActivity, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { ReviewTaskWorktreeSnapshot } from "@/types";

let mockWorktreeSnapshot: ReviewTaskWorktreeSnapshot | undefined;

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

vi.mock("@/stores/project-metadata-store", () => ({
	useTaskWorktreeSnapshotValue: () => mockWorktreeSnapshot,
	getProjectPath: () => "/mock/project",
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
	return createTestTaskSessionSummary({
		taskId: "task-1",
		state,
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		lastHookAt: 1,
		...overrides,
	});
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "move_to_trash",
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
		mockWorktreeSnapshot = undefined;
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
			(button) => button.textContent?.trim() === "Cancel Auto-trash",
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

	it("always shows running-task restart and trash actions on hover", async () => {
		vi.useFakeTimers();
		try {
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard()}
							index={0}
							columnId="in_progress"
							sessionSummary={createSummary("running")}
							onRestartSession={() => {}}
							onMoveToTrash={() => {}}
						/>
					</Providers>,
				);
			});

			const cardShell = container.querySelector('[data-task-id="task-1"]');
			expect(cardShell).toBeInstanceOf(HTMLDivElement);

			await act(async () => {
				cardShell?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
				vi.advanceTimersByTime(250);
			});

			expect(container.querySelector('button[aria-label="Force restart agent session"]')).toBeInstanceOf(
				HTMLButtonElement,
			);
			expect(container.querySelector('button[aria-label="Force move task to trash"]')).toBeInstanceOf(
				HTMLButtonElement,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			root.render(
				<Providers>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createTestTaskSessionSummary({
							taskId: "task-1",
							state: "running",
							agentId: "claude",
							sessionLaunchPath: "/tmp/worktree",
							startedAt: Date.now(),
							updatedAt: Date.now(),
							lastOutputAt: Date.now(),
							lastHookAt: Date.now(),
							latestHookActivity: createTestTaskHookActivity({
								activityText: "Using Read",
								toolName: "Read",
								toolInputSummary: "src/index.ts",
								hookEventName: "tool_call",
								source: "hook",
							}),
						})}
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
								conversationSummaryText: null,
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
								conversationSummaryText: null,
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
							sessionLaunchPath: "/tmp/worktree",
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
								conversationSummaryText: null,
								source: "hook",
							},
							stalledSince: null,
							latestTurnCheckpoint: null,
							previousTurnCheckpoint: null,
							conversationSummaries: [],
							displaySummary: null,
							displaySummaryGeneratedAt: null,
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
								conversationSummaryText: null,
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

	describe("getCardHoverTooltip", () => {
		it("returns null when no summary is provided", () => {
			expect(getCardHoverTooltip(undefined)).toBeNull();
		});

		it("returns null when session is running with no summary data", () => {
			const summary = createSummary("running");
			expect(getCardHoverTooltip(summary)).toBeNull();
		});

		it("returns displaySummary when session is running and has summary", () => {
			const summary = createSummary("running", {
				displaySummary: "Refactored auth flow",
			});
			expect(getCardHoverTooltip(summary)).toBe("Refactored auth flow");
		});

		it("returns displaySummary when available", () => {
			const summary = createSummary("awaiting_review", {
				displaySummary: "Added auth middleware and validation",
			});
			expect(getCardHoverTooltip(summary)).toBe("Added auth middleware and validation");
		});

		it("falls back to last conversationSummaries entry when displaySummary is null", () => {
			const summary = createSummary("awaiting_review", {
				displaySummary: null,
				conversationSummaries: [
					{ text: "First entry", capturedAt: 1, sessionIndex: 0 },
					{ text: "Latest conversation text", capturedAt: 2, sessionIndex: 1 },
				],
			});
			expect(getCardHoverTooltip(summary)).toBe("Latest conversation text");
		});

		it("truncates fallback text to 80 chars with ellipsis", () => {
			const longText = "A".repeat(100);
			const summary = createSummary("awaiting_review", {
				displaySummary: null,
				conversationSummaries: [{ text: longText, capturedAt: 1, sessionIndex: 0 }],
			});
			const result = getCardHoverTooltip(summary);
			expect(result).not.toBeNull();
			expect(result!.length).toBe(81); // 80 + ellipsis
			expect(result!.endsWith("\u2026")).toBe(true);
		});

		it("does not truncate fallback text at exactly 80 chars", () => {
			const exactText = "B".repeat(80);
			const summary = createSummary("awaiting_review", {
				displaySummary: null,
				conversationSummaries: [{ text: exactText, capturedAt: 1, sessionIndex: 0 }],
			});
			expect(getCardHoverTooltip(summary)).toBe(exactText);
		});

		it("returns null when conversationSummaries is empty and displaySummary is null", () => {
			const summary = createSummary("awaiting_review", {
				displaySummary: null,
				conversationSummaries: [],
			});
			expect(getCardHoverTooltip(summary)).toBeNull();
		});

		it("prefers displaySummary over conversationSummaries fallback", () => {
			const summary = createSummary("awaiting_review", {
				displaySummary: "LLM-generated summary",
				conversationSummaries: [{ text: "Raw conversation text", capturedAt: 1, sessionIndex: 0 }],
			});
			expect(getCardHoverTooltip(summary)).toBe("LLM-generated summary");
		});
	});

	describe("branch display precedence", () => {
		function createSnapshot(overrides?: Partial<ReviewTaskWorktreeSnapshot>): ReviewTaskWorktreeSnapshot {
			return {
				taskId: "task-1",
				path: "/tmp/worktree",
				branch: null,
				isDetached: false,
				headCommit: "abc1234",
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				hasUnmergedChanges: false,
				behindBaseCount: null,
				conflictState: null,
				...overrides,
			};
		}

		it("prefers live metadata branch over stale card.branch", async () => {
			mockWorktreeSnapshot = createSnapshot({ branch: "live-branch" });
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard({ branch: "stale-branch" })}
							index={0}
							columnId="in_progress"
							sessionSummary={createSummary("running")}
						/>
					</Providers>,
				);
			});
			expect(container.textContent).toContain("live-branch");
			expect(container.textContent).not.toContain("stale-branch");
		});

		it("falls back to card.branch when metadata branch is null (detached HEAD)", async () => {
			mockWorktreeSnapshot = createSnapshot({ branch: null });
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard({ branch: "persisted-branch" })}
							index={0}
							columnId="review"
							sessionSummary={createSummary("awaiting_review")}
						/>
					</Providers>,
				);
			});
			expect(container.textContent).toContain("persisted-branch");
		});

		it("falls back to card.branch when no metadata is available", async () => {
			mockWorktreeSnapshot = undefined;
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard({ branch: "saved-branch" })}
							index={0}
							columnId="review"
							sessionSummary={createSummary("awaiting_review")}
						/>
					</Providers>,
				);
			});
			expect(container.textContent).toContain("saved-branch");
		});

		it("shows headCommit fallback when neither source has a branch", async () => {
			mockWorktreeSnapshot = createSnapshot({ branch: null, headCommit: "deadbeef12345678" });
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard()}
							index={0}
							columnId="in_progress"
							sessionSummary={createSummary("running")}
						/>
					</Providers>,
				);
			});
			expect(container.textContent).toContain("deadbeef");
		});

		it("keeps assigned isolation separate from session launch drift", async () => {
			mockWorktreeSnapshot = createSnapshot({
				path: "/mock/project/.quarterdeck/worktrees/task-1",
				branch: "feature/assigned",
			});
			await act(async () => {
				root.render(
					<Providers>
						<BoardCard
							card={createCard({
								branch: "feature/stale",
								useWorktree: true,
								workingDirectory: "/mock/project/.quarterdeck/worktrees/task-1",
							})}
							index={0}
							columnId="in_progress"
							sessionSummary={createSummary("running", {
								sessionLaunchPath: "/mock/project",
							})}
						/>
					</Providers>,
				);
			});

			expect(container.textContent).not.toContain("Shared");
			expect(container.querySelector("svg.text-status-orange")).not.toBeNull();
		});
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
								conversationSummaryText: null,
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
