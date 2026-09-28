// @vitest-environment node

import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { createSourceEditorActionContext } from "@/components/editor/source-editor-context";
import { TaskResourceOperationCoordinator } from "../../../../src/core/task-resource-operation-coordinator";
import type { TerminalSessionManager } from "../../../../src/terminal";
import { handleSendTaskSessionInput } from "../../../../src/trpc/handlers/send-task-session-input";
import { createTestTaskSessionSummary } from "../../../../test/utilities/task-session-factory";
import { buildAgentContextPrompt, captureEditorAgentContext } from "./agent-context";

describe("captured agent context transport", () => {
	it.each([
		{ kind: "file" as const, lineSeparator: "\r\n" },
		{ kind: "selection" as const, lineSeparator: "\r\n" },
		{ kind: "file" as const, lineSeparator: "\n" },
	])("preserves the $kind preview and safely submits $lineSeparator line endings", async ({ kind, lineSeparator }) => {
		const content = `const draft = {${lineSeparator}\tvalue: 2,${lineSeparator}};${lineSeparator}`;
		const state = EditorState.create({ doc: content, extensions: EditorState.lineSeparator.of(lineSeparator) });
		const selectedState = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
		const context = captureEditorAgentContext(createSourceEditorActionContext(selectedState, "draft.ts", 1), kind)!;
		const prompt = buildAgentContextPrompt(context, "Explain this draft.", "Task worktree");
		expect(context.content).toBe(content);
		expect(prompt.text).toContain(content);
		expect(prompt.error).toBeNull();

		const summary = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "hook",
			agentId: "codex",
			pid: 42,
			sessionInstanceId: "launch-1",
		});
		const writeInput = vi.fn(() => summary);
		const terminalManager = {
			store: { getSummary: () => summary },
			getTaskSessionProcessIdentity: () => ({ sessionInstanceId: "launch-1" }),
			writeInput,
		} as unknown as TerminalSessionManager;
		const result = await handleSendTaskSessionInput(
			{ projectId: "project-1", projectPath: "/synthetic" },
			{
				taskId: "task-1",
				text: prompt.text,
				intent: "submit",
				appendNewline: true,
				replyToSessionInstanceId: "launch-1",
			},
			{
				getScopedTerminalManager: async () => terminalManager,
				taskResourceOperations: new TaskResourceOperationCoordinator(),
			},
		);
		expect(result.ok).toBe(true);
		const transportPrompt = buildAgentContextPrompt(
			{ ...context, content: "const draft = {\n\tvalue: 2,\n};\n" },
			"Explain this draft.",
			"Task worktree",
		);
		expect(writeInput).toHaveBeenCalledExactlyOnceWith(
			"task-1",
			Buffer.from(`\x1b[200~${transportPrompt.text}\x1b[201~\r`),
			{ explicitUserSubmission: true },
		);
		expect(context.content).toBe(content);
		expect(prompt.text).toContain(content);
	});
});
