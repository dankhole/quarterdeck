import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAgentContextProvider } from "@/providers/task-agent-context-provider";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import { SplitDiff } from "./diff-split";
import { UnifiedDiff } from "./diff-unified";

describe("diff hunk agent actions", () => {
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

	it.each(["unified", "split"] as const)(
		"captures exact displayed %s hunk and comparison source without sending",
		async (mode) => {
			const Diff = mode === "unified" ? UnifiedDiff : SplitDiff;
			const sendInput = vi.fn(async () => ({ ok: true }));
			const content = (
				<Diff
					path="example.ts"
					oldText={"const before = 1;\n"}
					newText={"const after = 2;\n"}
					comments={new Map()}
					onAddComment={() => {}}
					onUpdateComment={() => {}}
					onDeleteComment={() => {}}
					agentContextSource="Compare: base → feature"
				/>
			);
			await act(async () => root.render(content));
			expect(container.textContent).not.toContain("Ask agent about hunk");
			await act(async () =>
				root.render(
					<TaskAgentContextProvider
						projectId="project"
						taskId="task"
						taskCreatedAt={1}
						taskTitle="Task"
						source="Task worktree"
						summary={createTestTaskSessionSummary({
							taskId: "task",
							agentId: "codex",
							state: "awaiting_review",
							reviewReason: "hook",
							pid: 42,
							sessionInstanceId: "launch",
						})}
						sendInput={sendInput}
					>
						{content}
					</TaskAgentContextProvider>,
				),
			);
			const button = Array.from(container.querySelectorAll("button")).find((item) =>
				item.textContent?.includes("Ask agent about hunk"),
			);
			expect(button).toBeDefined();
			await act(async () => button?.click());
			expect(document.querySelector("pre")?.textContent).toContain("Source: Compare: base → feature");
			expect(document.querySelector("pre")?.textContent).toContain("-const before = 1;\n+const after = 2;");
			expect(sendInput).not.toHaveBeenCalled();
		},
	);
});
