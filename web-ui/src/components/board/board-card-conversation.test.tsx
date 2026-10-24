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
const previewSelector = "[data-board-response-preview]";

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

	function preview(index = 0): HTMLElement {
		const element = container.querySelectorAll<HTMLElement>(previewSelector)[index];
		if (!element) throw new Error(`Missing response preview ${index}`);
		return element;
	}

	it.each(["codex", "claude", "pi"] as const)(
		"formats %s previews while preserving progress, final, retained, and prompt precedence",
		async (agentId) => {
			const summary: RuntimeTaskSessionSummary = {
				...running,
				agentId,
				nativeWorkEvidence: { ...running.nativeWorkEvidence!, provider: agentId },
				progressMessage: "**Current progress**",
				latestHookActivity: { ...ready.latestHookActivity!, finalMessage: "**Current final**" },
				completedResponses: [
					{ text: "**Older retained**", capturedAt: 100, sessionIndex: 0 },
					{ text: "**Latest retained**", capturedAt: 200, sessionIndex: 1 },
				],
			};
			const render = async (value: RuntimeTaskSessionSummary | undefined, unstarted = false) =>
				act(async () =>
					root.render(
						<BoardCardConversation
							card={{ ...card, prompt: "**Original prompt**", unstarted }}
							columnId="in_progress"
							summary={value}
						/>,
					),
				);
			await render(summary);
			expect(preview().querySelector("strong")?.textContent).toBe("Current progress");
			expect(container.textContent).not.toContain("Current final");
			await render({ ...summary, progressMessage: null });
			expect(preview().querySelector("strong")?.textContent).toBe("Current final");
			expect(container.querySelector("[aria-expanded]")).toBeNull();
			await render({ ...summary, state: "awaiting_review", reviewReason: "hook" });
			expect(preview().querySelector("strong")?.textContent).toBe("Current final");
			await render({ ...summary, progressMessage: null, latestHookActivity: null });
			expect(preview().querySelector("strong")?.textContent).toBe("Latest retained");
			expect(container.textContent).not.toContain("Older retained");
			expect(container.querySelector("time")).toBeNull();
			await render({ ...summary, progressMessage: null, latestHookActivity: null, completedResponses: [] });
			expect(preview().querySelector("strong")?.textContent).toBe("Original prompt");
			await render(undefined);
			expect(preview().querySelector("strong")?.textContent).toBe("Original prompt");
			await render(summary, true);
			expect(preview().querySelector("strong")?.textContent).toBe("Original prompt");
			expect(container.querySelector("[aria-expanded]")).toBeNull();
			expect(container.textContent).toContain("Ready when you are");
			expect(container.textContent).not.toContain("Current progress");
			expect(container.textContent).not.toContain("Current final");
			expect(container.textContent).not.toContain("Latest retained");
		},
	);

	it.each([undefined, null, "", "   "])(
		"shows the previous final response directly when running progress is %s",
		async (progressMessage) => {
			await act(async () =>
				root.render(
					<BoardCardConversation card={card} columnId="in_progress" summary={{ ...running, progressMessage }} />,
				),
			);
			expect(preview().textContent).toBe("The updated layout is ready.");
			expect(container.querySelector("[aria-expanded]")).toBeNull();
			expect(container.textContent).not.toContain("Working…");
		},
	);

	it("restores the retained response after progress clears and native final output is absent", async () => {
		const completedResponse = "The **completed response** survives the next turn.";
		const summary = {
			...running,
			latestHookActivity: null,
			completedResponses: [{ text: completedResponse, capturedAt: 100, sessionIndex: 0 }],
		};
		const render = async (progressMessage: string | null) =>
			act(async () =>
				root.render(
					<BoardCardConversation card={card} columnId="in_progress" summary={{ ...summary, progressMessage }} />,
				),
			);
		await render(null);
		expect(preview().querySelector("strong")?.textContent).toBe("completed response");
		const formattedResponse = preview().innerHTML;
		await render("Validating the **next change**.");
		expect(preview().querySelector("strong")?.textContent).toBe("next change");
		const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
		expect(trigger?.textContent).toBe("Previous response");
		await act(async () => trigger?.click());
		expect(preview(1).innerHTML).toBe(formattedResponse);
		await render(null);
		expect(preview().innerHTML).toBe(formattedResponse);
		expect(container.querySelector("[aria-expanded]")).toBeNull();
	});

	it("formats current and previous responses identically without changing card navigation", async () => {
		const openTask = vi.fn();
		const response =
			"## Result\n\nThe **layout** uses *compact* `code`.\n\n- [Details](https://example.com)\n- Keyboard support";
		const render = async (progressMessage: string | null) =>
			act(async () =>
				root.render(
					<div onClick={openTask} onDoubleClick={openTask}>
						<BoardCardConversation
							card={card}
							columnId="in_progress"
							summary={{
								...running,
								progressMessage,
								latestHookActivity: { ...ready.latestHookActivity!, finalMessage: response },
							}}
						/>
					</div>,
				),
			);
		await render(null);
		expect(preview().querySelector("h2")?.textContent).toBe("Result");
		expect(preview().querySelector("strong")?.textContent).toBe("layout");
		expect(preview().querySelector("em")?.textContent).toBe("compact");
		expect(preview().querySelector("code")?.textContent).toBe("code");
		expect(preview().querySelectorAll("li")).toHaveLength(2);
		expect(preview().querySelector("a, img, button, input, textarea, select")).toBeNull();
		expect(preview().textContent).toContain("Details");
		const formattedResponse = preview().innerHTML;
		await act(async () => preview().querySelector("strong")?.click());
		await act(async () => preview().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(openTask).toHaveBeenCalledTimes(2);
		openTask.mockClear();
		await render("Checking the **remaining shortcuts**.");
		expect(preview().querySelector("strong")?.textContent).toBe("remaining shortcuts");
		const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
		expect(trigger?.textContent).toBe("Previous response");
		expect(trigger?.type).toBe("button");
		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		const contentId = trigger?.getAttribute("aria-controls");
		expect(contentId).toBeTruthy();
		expect(document.getElementById(contentId!)?.querySelector(previewSelector)?.innerHTML).toBe(formattedResponse);
		await act(async () => preview(1).querySelector("strong")?.click());
		await act(async () => preview(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		await act(async () => trigger?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(openTask).not.toHaveBeenCalled();
		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelectorAll(previewSelector)).toHaveLength(1);
		await act(async () => preview().click());
		expect(openTask).toHaveBeenCalledOnce();
	});

	it.each(["progress", "final", "retained", "prompt", "previous"] as const)(
		"bounds the %s source through the shared formatted preview",
		async (source) => {
			const text = `**Bounded** ${"x".repeat(600)} omitted tail`;
			const summary: RuntimeTaskSessionSummary = {
				...running,
				latestHookActivity:
					source === "final" || source === "previous"
						? { ...ready.latestHookActivity!, finalMessage: text }
						: null,
				progressMessage: source === "progress" ? text : source === "previous" ? "Current progress" : null,
				completedResponses: source === "retained" ? [{ text, capturedAt: 100, sessionIndex: 0 }] : [],
			};
			await act(async () =>
				root.render(
					<BoardCardConversation
						card={{ ...card, prompt: source === "prompt" ? text : card.prompt }}
						columnId="in_progress"
						summary={summary}
					/>,
				),
			);
			if (source === "previous") {
				await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
			}
			const bounded = preview(source === "previous" ? 1 : 0);
			expect(bounded.querySelector("strong")?.textContent).toBe("Bounded");
			expect(bounded.textContent).toBe(`Bounded ${"x".repeat(500 - "**Bounded** ".length)}`);
			expect(bounded.textContent).not.toContain("omitted tail");
			expect(bounded.classList.contains("max-h-[108px]")).toBe(true);
			expect(bounded.classList.contains("overflow-hidden")).toBe(true);
		},
	);

	it("keeps the latest Pi-shortcuts answer formatted when transient final output clears", async () => {
		const response = `While **Pi** is working:\n\n- Redirect it with \`Enter\`.\n- Stop with \`Esc\`.\n\n${"More detail. ".repeat(50)}`;
		const summary: RuntimeTaskSessionSummary = {
			...ready,
			agentId: "pi",
			completedResponses: [
				{ text: "The installed Tintinweb extension is available.", capturedAt: 100, sessionIndex: 0 },
				{ text: response, capturedAt: 200, sessionIndex: 1 },
			],
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
		expect(preview().querySelector("strong")?.textContent).toBe("Pi");
		expect(preview().querySelectorAll("code")).toHaveLength(2);
		const formattedResponse = preview().innerHTML;
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={card}
					columnId="in_progress"
					summary={{
						...summary,
						state: "running",
						reviewReason: null,
						nativeWorkEvidence: { ...running.nativeWorkEvidence!, provider: "pi" },
						latestHookActivity: null,
					}}
				/>,
			),
		);
		expect(preview().innerHTML).toBe(formattedResponse);
		expect(container.querySelector("[aria-expanded]")).toBeNull();
		expect(container.textContent).not.toContain("The installed Tintinweb extension is available.");
	});

	it("shows the empty-state preview when neither a prompt nor response exists", async () => {
		await act(async () => root.render(<BoardCardConversation card={{ ...card, prompt: "" }} columnId="review" />));
		expect(preview().textContent).toBe("No response yet. Open the agent to follow its progress.");
		expect(container.querySelector("[aria-expanded]")).toBeNull();
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
		expect(preview().textContent).toBe("The updated layout is ready.");
		await render({ ...ready, sessionInstanceId: "launch-2" });
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
				replyToSessionInstanceId: "launch-2",
			},
		);
		expect(container.textContent).toContain("Reply sent");
		expect(drafts.get(key).text).toBe("");
	});

	it.each(["unstarted", "trash", "read-only"] as const)("does not offer replies for %s cards", async (mode) => {
		const drafts = new BoardReplyDrafts();
		const sendInput = vi.fn(async () => ({ ok: true }));
		drafts.edit(JSON.stringify(["project", card.id, card.createdAt]), "Keep this draft");
		await act(async () =>
			root.render(
				<BoardCardConversation
					card={{ ...card, unstarted: mode === "unstarted" }}
					columnId={mode === "trash" ? "trash" : "review"}
					summary={ready}
					readOnly={mode === "read-only"}
					replyScope={{ projectId: "project", drafts, sendInput }}
				/>,
			),
		);
		expect(container.querySelector("textarea, button")).toBeNull();
		expect(sendInput).not.toHaveBeenCalled();
		expect(drafts.get(JSON.stringify(["project", card.id, card.createdAt])).text).toBe("Keep this draft");
	});

	it("keeps reply controls isolated from card navigation and retains drafts on rejection", async () => {
		const openTask = vi.fn();
		const drafts = new BoardReplyDrafts();
		const key = JSON.stringify(["project", card.id, card.createdAt]);
		drafts.edit(key, "Try this");
		const sendInput = vi.fn(async () => ({ ok: false, message: "Session changed" }));
		await act(async () =>
			root.render(
				<div onClick={openTask} onDoubleClick={openTask}>
					<BoardCardConversation
						card={card}
						columnId="review"
						summary={{
							...ready,
							latestHookActivity: {
								...ready.latestHookActivity!,
								finalMessage: "The **formatted result** is ready.",
							},
						}}
						replyScope={{ projectId: "project", drafts, sendInput }}
					/>
				</div>,
			),
		);
		expect(preview().querySelector("strong")?.textContent).toBe("formatted result");
		await act(async () => container.querySelector("textarea")?.click());
		await act(async () =>
			container.querySelector("textarea")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Session changed");
		expect(container.querySelector("textarea")?.value).toBe("Try this");
		await act(async () =>
			container.querySelector<HTMLButtonElement>('button[aria-label="Close reply, keep draft"]')?.click(),
		);
		expect(container.querySelector("textarea")).toBeNull();
		const continueDraft = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Continue draft",
		);
		await act(async () => continueDraft?.click());
		expect(container.querySelector("textarea")?.value).toBe("Try this");
		expect(sendInput).toHaveBeenCalledOnce();
		expect(openTask).not.toHaveBeenCalled();
	});
});
