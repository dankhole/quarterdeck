import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardCardConversation } from "@/components/board/board-card-conversation";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { BoardReplyDrafts } from "@/state/board-reply-drafts";
import { createTestTaskNativeWorkEvidence, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

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
const running = {
	...ready,
	state: "running" as const,
	reviewReason: null,
	nativeWorkEvidence: createTestTaskNativeWorkEvidence({ sessionInstanceId: "launch-1" }),
};

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
		expect(container.querySelector("time")).toBeNull();
	});
	it("keeps the completed response until current progress arrives and restores it in Review", async () => {
		const render = async (summary: RuntimeTaskSessionSummary) =>
			act(async () => root.render(<BoardCardConversation card={card} columnId="in_progress" summary={summary} />));
		const progressMessage = "Checking the remaining keyboard shortcuts.";
		await render(running);
		expect(container.querySelector("p")?.textContent).toBe("The updated layout is ready.");
		await render({ ...running, progressMessage });
		expect(container.querySelector("p")?.textContent).toBe(progressMessage);
		expect(container.textContent).not.toContain("The updated layout is ready.");
		await render({ ...ready, progressMessage });
		expect(container.querySelector("p")?.textContent).toBe("The updated layout is ready.");
		expect(container.querySelector("[aria-expanded]")).toBeNull();
	});
	it.each([undefined, null, "", "   "])(
		"shows the previous final response directly when running progress is %s",
		async (progressMessage) => {
			await act(async () =>
				root.render(
					<BoardCardConversation card={card} columnId="in_progress" summary={{ ...running, progressMessage }} />,
				),
			);
			expect(container.querySelector("p")?.textContent).toBe("The updated layout is ready.");
			expect(container.querySelector("[aria-expanded]")).toBeNull();
			expect(container.textContent).not.toContain("Working…");
		},
	);
	it("keeps the previous response expandable after new progress arrives without opening the task", async () => {
		const openTask = vi.fn();
		const progressMessage = "Checking the remaining keyboard shortcuts.";
		await act(async () =>
			root.render(
				<div onClick={openTask} onDoubleClick={openTask}>
					<BoardCardConversation card={card} columnId="in_progress" summary={{ ...running, progressMessage }} />
				</div>,
			),
		);
		const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
		expect(trigger?.textContent).toBe("Previous response");
		expect(trigger?.type).toBe("button");
		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		const contentId = trigger?.getAttribute("aria-controls");
		expect(contentId).toBeTruthy();
		expect(document.getElementById(contentId!)?.textContent).toBe("The updated layout is ready.");
		await act(async () => trigger?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(openTask).not.toHaveBeenCalled();
		expect(container.querySelector("p")?.textContent).toBe(progressMessage);
		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("The updated layout is ready.");
	});
	it("keeps the retained response beyond the short display summary visible when the next turn starts", async () => {
		const response = "The latest completed response has more detail than a short synopsis. ".repeat(10).trim();
		const summary = {
			...ready,
			conversationSummaries: [
				{ text: "Older response", capturedAt: 100, sessionIndex: 0 },
				{ text: response, capturedAt: 200, sessionIndex: 1 },
			],
			displaySummary: `${response.slice(0, 90)}…`,
		};
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="review"
					summary={{ ...summary, latestHookActivity: { ...ready.latestHookActivity!, finalMessage: response } }}
				/>,
			),
		);
		expect(container.querySelector("p")?.textContent).toBe(response.slice(0, 500));
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="in_progress"
					summary={{
						...summary,
						state: "running",
						reviewReason: null,
						nativeWorkEvidence: running.nativeWorkEvidence,
						latestHookActivity: null,
					}}
				/>,
			),
		);
		expect(container.querySelector("p")?.textContent).toBe(response.slice(0, 500));
		expect(container.querySelector("[aria-expanded]")).toBeNull();
		expect(container.textContent).not.toContain("Older response");
	});
	it("shows the original prompt without a disclosure when there is no previous response", async () => {
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="in_progress"
					summary={{ ...running, latestHookActivity: null }}
				/>,
			),
		);
		expect(container.querySelector("p")?.textContent).toBe(card.prompt);
		expect(container.querySelector("button[aria-expanded]")).toBeNull();
		expect(container.textContent).not.toContain("Working…");
	});
	it("keeps unstarted cards on the original prompt even when old runtime messages exist", async () => {
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={{ ...card, unstarted: true }}
					columnId="in_progress"
					summary={{ ...running, progressMessage: "Current progress", displaySummary: "Old synopsis" }}
				/>,
			),
		);
		expect(container.querySelector("p")?.textContent).toBe(card.prompt);
		expect(container.querySelector("button[aria-expanded]")).toBeNull();
		expect(container.textContent).toContain("Ready when you are");
		expect(container.textContent).not.toContain("Current progress");
		expect(container.textContent).not.toContain("The updated layout is ready.");
		expect(container.textContent).not.toContain("Old synopsis");
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
