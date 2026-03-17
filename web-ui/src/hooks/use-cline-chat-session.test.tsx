import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ClineChatMessage, useClineChatSession } from "@/hooks/use-cline-chat-session";

interface HookSnapshot {
	messageIds: string[];
	lastMessageContent: string | null;
	lastMessageHookEvent: string | null;
	error: string | null;
	isSending: boolean;
}

function HookHarness({
	taskId,
	onLoadMessages,
	incomingMessage,
	onSnapshot,
}: {
	taskId: string;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessage?: ClineChatMessage | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const state = useClineChatSession({
		taskId,
		onLoadMessages,
		incomingMessage,
	});

	useEffect(() => {
		const lastMessage = state.messages.at(-1);
		onSnapshot({
			messageIds: state.messages.map((message) => message.id),
			lastMessageContent: lastMessage?.content ?? null,
			lastMessageHookEvent: lastMessage?.meta?.hookEventName ?? null,
			error: state.error,
			isSending: state.isSending,
		});
	}, [onSnapshot, state.messages, state.error, state.isSending]);

	return null;
}

describe("useClineChatSession", () => {
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
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("appends incoming stream messages and updates existing messages by id", async () => {
		const initialMessage: ClineChatMessage = {
			id: "initial",
			role: "assistant",
			content: "Initial response",
			createdAt: 1,
		};
		const streamedMessage: ClineChatMessage = {
			id: "streamed",
			role: "assistant",
			content: "Stream update",
			createdAt: 2,
		};
		const onLoadMessages = vi.fn(async () => [initialMessage]);
		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onLoadMessages={onLoadMessages}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.messageIds).toEqual(["initial"]);

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onLoadMessages={onLoadMessages}
					incomingMessage={streamedMessage}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.messageIds).toEqual(["initial", "streamed"]);
		expect(snapshots.at(-1)?.lastMessageContent).toBe("Stream update");

		const streamedMessageUpdate: ClineChatMessage = {
			...streamedMessage,
			content: "Stream update (continued)",
		};

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onLoadMessages={onLoadMessages}
					incomingMessage={streamedMessageUpdate}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.messageIds).toEqual(["initial", "streamed"]);
		expect(snapshots.at(-1)?.lastMessageContent).toBe("Stream update (continued)");
	});

	it("updates existing message when only meta changes", async () => {
		const toolStart: ClineChatMessage = {
			id: "tool-1",
			role: "tool",
			content: "Tool: Read",
			createdAt: 2,
			meta: {
				hookEventName: "tool_call_start",
				toolName: "Read",
				toolCallId: "call-1",
				streamType: "tool",
			},
		};
		const onLoadMessages = vi.fn(async () => [toolStart]);
		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onLoadMessages={onLoadMessages}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.lastMessageHookEvent).toBe("tool_call_start");

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onLoadMessages={onLoadMessages}
					incomingMessage={{
						...toolStart,
						meta: {
							...toolStart.meta,
							hookEventName: "tool_call_end",
						},
					}}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.messageIds).toEqual(["tool-1"]);
		expect(snapshots.at(-1)?.lastMessageHookEvent).toBe("tool_call_end");
	});
});
