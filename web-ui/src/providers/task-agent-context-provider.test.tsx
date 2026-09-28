import { TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPromptContext } from "@/hooks/git/agent-context";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import {
	TaskAgentContextProvider,
	type TaskAgentContextProviderProps,
	useTaskAgentContext,
} from "./task-agent-context-provider";

const context: AgentPromptContext = {
	kind: "selection",
	path: "src/unsaved.ts",
	location: "Editor buffer 2:1–2:4",
	content: "new",
};
const summary = createTestTaskSessionSummary({
	taskId: "task",
	agentId: "codex",
	state: "awaiting_review",
	reviewReason: "hook",
	pid: 42,
	sessionInstanceId: "launch-1",
});

function CaptureButton(): React.ReactElement {
	const agentContext = useTaskAgentContext();
	return (
		<button type="button" onClick={() => agentContext?.openContext(context)}>
			Capture context
		</button>
	);
}

describe("task agent context prompts", () => {
	let root: Root;
	let container: HTMLDivElement;
	let sendInput: TaskAgentContextProviderProps["sendInput"];
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		sendInput = vi.fn(async () => ({ ok: true }));
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	const render = async (overrides: Partial<TaskAgentContextProviderProps> = {}) =>
		act(async () =>
			root.render(
				<TaskAgentContextProvider
					projectId="project"
					taskId="task"
					taskCreatedAt={1}
					taskTitle="Fix layout"
					source="Branch/ref feature"
					summary={summary}
					sendInput={sendInput}
					{...overrides}
				>
					<CaptureButton />
				</TaskAgentContextProvider>,
			),
		);
	const capture = async () => act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
	const sendButton = () =>
		Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Send to agent",
		)!;
	const editInstruction = async (text: string) =>
		act(async () => {
			const textarea = document.querySelector("textarea")!;
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});

	it("requires explicit Send and targets only the captured launch", async () => {
		await render();
		await capture();
		await editInstruction("Explain the unsaved change.");
		expect(document.querySelector("pre")?.textContent).toContain("Source: Branch/ref feature");
		expect(document.querySelector("pre")?.textContent).toContain("src/unsaved.ts");
		expect(sendInput).not.toHaveBeenCalled();
		await act(async () => sendButton().click());
		expect(sendInput).toHaveBeenCalledExactlyOnceWith(
			"task",
			expect.stringContaining("Explain the unsaved change."),
			{
				intent: "submit",
				appendNewline: true,
				preferTerminal: false,
				replyToSessionInstanceId: "launch-1",
			},
		);
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("keeps instructions while busy and after delivery failure", async () => {
		sendInput = vi.fn(async () => ({ ok: false, message: "Delivery rejected" }));
		await render();
		await capture();
		await editInstruction("Explain this.");
		await render({ summary: { ...summary, state: "running" } });
		expect(sendButton().disabled).toBe(true);
		expect(document.querySelector("textarea")?.value).toBe("Explain this.");
		await render();
		await act(async () => sendButton().click());
		expect(document.querySelector("textarea")?.value).toBe("Explain this.");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Delivery rejected");
	});

	it("refuses to retarget a captured draft to a replacement session", async () => {
		await render();
		await capture();
		await editInstruction("Explain this.");
		await render({ summary: { ...summary, sessionInstanceId: "launch-2" } });
		expect(sendButton().disabled).toBe(true);
		await act(async () => sendButton().click());
		expect(sendInput).not.toHaveBeenCalled();
		expect(document.querySelector("textarea")?.value).toBe("Explain this.");
	});

	it("counts captured content and metadata against the total send budget", async () => {
		await render();
		await capture();
		await editInstruction("x".repeat(TASK_QUICK_REPLY_MAX_LENGTH));
		expect(sendButton().disabled).toBe(true);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Select a smaller range");
		await act(async () => sendButton().click());
		expect(sendInput).not.toHaveBeenCalled();
	});

	it.each([{ projectId: "other-project" }, { taskId: "other-task" }, { taskCreatedAt: 2 }])(
		"clears context on identity change %j",
		async (overrides) => {
			await render();
			await capture();
			await editInstruction("Explain this.");
			await render(overrides);
			expect(document.querySelector("textarea")).toBeNull();
			expect(sendInput).not.toHaveBeenCalled();
		},
	);

	it("rejects repeated clicks while delivery is pending", async () => {
		let finish: ((result: { ok: boolean }) => void) | undefined;
		sendInput = vi.fn(
			() =>
				new Promise<{ ok: boolean }>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await capture();
		await editInstruction("Explain this.");
		await act(async () => {
			const button = sendButton();
			button.click();
			button.click();
		});
		expect(sendInput).toHaveBeenCalledTimes(1);
		await act(async () => finish?.({ ok: true }));
	});
});
