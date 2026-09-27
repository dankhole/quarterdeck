import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardCardConversation } from "@/components/board/board-card-conversation";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { BoardReplyDrafts } from "@/state/board-reply-drafts";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

const card = { id: "task", title: "Layout", prompt: "Original prompt", baseRef: "main", createdAt: 1, updatedAt: 1 };
const ready = createTestTaskSessionSummary({
	taskId: "task",
	agentId: "codex",
	state: "awaiting_review",
	reviewReason: "hook",
	pid: 42,
	sessionInstanceId: "launch-1",
	latestHookActivity: { finalMessage: "The updated layout is ready." },
});

describe("board card conversation", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	it("shows the current final response instead of older history and its timestamp", async () => {
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="review"
					summary={{
						...ready,
						conversationSummaries: [{ text: "Older response", capturedAt: 100, sessionIndex: 0 }],
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("The updated layout is ready.");
		expect(container.textContent).not.toContain("Older response");
		expect(container.querySelector("time")).toBeNull();
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="review"
					summary={{
						...ready,
						latestHookActivity: null,
						conversationSummaries: [{ text: "Older response", capturedAt: 100, sessionIndex: 0 }],
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("Older response");
		expect(container.querySelector("time")?.dateTime).toBe(new Date(100).toISOString());
	});
	it("keeps a draft across navigation and readiness changes, and submits only explicitly to the current launch", async () => {
		const drafts = new BoardReplyDrafts();
		const key = JSON.stringify(["project", card.id, card.createdAt]);
		drafts.edit(key, "Please check keyboard focus.\nThen check the narrow layout.");
		const sendInput = vi.fn(async () => ({ ok: true }));
		const render = async (summary: RuntimeTaskSessionSummary) =>
			act(async () =>
				root.render(
					<BoardCardConversation
						card={card}
						columnId="review"
						summary={summary}
						replyScope={{ projectId: "project", drafts, sendInput }}
					/>,
				),
			);
		await render({ ...ready, state: "running" });
		expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
		await act(async () => root.render(null));
		await render(ready);
		expect(container.querySelector("textarea")?.value).toContain("Please check keyboard focus.");
		expect(container.textContent).toContain("The updated layout is ready.");
		expect(sendInput).not.toHaveBeenCalled();
		await act(async () =>
			container
				.querySelector("textarea")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
		);
		expect(sendInput).not.toHaveBeenCalled();
		await act(async () =>
			container
				.querySelector("textarea")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })),
		);
		expect(sendInput).toHaveBeenCalledExactlyOnceWith(
			"task",
			"Please check keyboard focus.\nThen check the narrow layout.",
			{
				intent: "submit",
				appendNewline: true,
				preferTerminal: false,
				replyToSessionInstanceId: "launch-1",
			},
		);
		expect(container.textContent).toContain("Reply sent");
		expect(drafts.get(key).text).toBe("");
	});
	it("retains rejected replies and bounds plain-text hook previews", async () => {
		const drafts = new BoardReplyDrafts();
		const key = JSON.stringify(["project", card.id, card.createdAt]);
		drafts.edit(key, "Try this");
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="review"
					summary={{
						...ready,
						latestHookActivity: { ...ready.latestHookActivity!, finalMessage: "x".repeat(1000) },
					}}
					replyScope={{
						projectId: "project",
						drafts,
						sendInput: async () => ({ ok: false, message: "Session changed" }),
					}}
				/>,
			),
		);
		expect(container.querySelector("p")?.textContent).toHaveLength(500);
		await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Session changed");
		expect(container.querySelector("textarea")?.value).toBe("Try this");
	});
});
