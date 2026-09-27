import { describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import type { TerminalSessionManager } from "../../../src/terminal";
import { handleSendTaskSessionInput } from "../../../src/trpc/handlers/send-task-session-input";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const scope = { projectId: "project-1", projectPath: "/repo" };
const terminalSubmitTerminator = process.platform === "win32" ? "\r" : "\n";
const taskResourceOperations = new TaskResourceOperationCoordinator();

describe("handleSendTaskSessionInput", () => {
	it("preserves transport bytes while forwarding explicit submit intent", async () => {
		const summary = createTestTaskSessionSummary({ taskId: "task-1", state: "running" });
		const writeInput = vi.fn(() => summary);
		const terminalManager = { writeInput } as unknown as TerminalSessionManager;

		const response = await handleSendTaskSessionInput(
			scope,
			{ taskId: "task-1", text: "continue", appendNewline: false, intent: "submit" },
			{ getScopedTerminalManager: vi.fn(async () => terminalManager), taskResourceOperations },
		);

		expect(response).toEqual({ ok: true, summary });
		expect(writeInput).toHaveBeenCalledWith("task-1", Buffer.from("continue"), {
			explicitUserSubmission: true,
		});
	});

	it("uses the platform terminal Enter sequence while submitting", async () => {
		const writeInput = vi.fn(() => createTestTaskSessionSummary({ taskId: "task-1" }));
		const terminalManager = { writeInput } as unknown as TerminalSessionManager;

		await handleSendTaskSessionInput(
			scope,
			{ taskId: "task-1", text: "continue", appendNewline: true, intent: "submit" },
			{ getScopedTerminalManager: vi.fn(async () => terminalManager), taskResourceOperations },
		);

		expect(writeInput).toHaveBeenCalledWith("task-1", Buffer.from(`continue${terminalSubmitTerminator}`), {
			explicitUserSubmission: true,
		});
	});

	it("lets structured callers separate newline transport from submit intent", async () => {
		const writeInput = vi.fn(() => createTestTaskSessionSummary({ taskId: "task-1" }));
		const terminalManager = { writeInput } as unknown as TerminalSessionManager;

		await handleSendTaskSessionInput(
			scope,
			{ taskId: "task-1", text: "continue", appendNewline: true, intent: "write" },
			{ getScopedTerminalManager: vi.fn(async () => terminalManager), taskResourceOperations },
		);

		expect(writeInput).toHaveBeenCalledWith("task-1", Buffer.from(`continue${terminalSubmitTerminator}`), {
			explicitUserSubmission: false,
		});
	});
});

describe("board quick replies", () => {
	const ready = createTestTaskSessionSummary({
		taskId: "task-1",
		state: "awaiting_review",
		reviewReason: "hook",
		agentId: "codex",
		pid: 42,
		sessionInstanceId: "launch-1",
	});
	async function send(summary = ready, identity = "launch-1", text = "Check the layout\non a narrow screen") {
		const writeInput = vi.fn(() => summary);
		const manager = {
			store: { getSummary: () => summary },
			getTaskSessionProcessIdentity: () => ({ sessionInstanceId: identity }),
			writeInput,
		} as unknown as TerminalSessionManager;
		const response = await handleSendTaskSessionInput(
			scope,
			{ taskId: "task-1", text, intent: "submit", replyToSessionInstanceId: "launch-1" },
			{ getScopedTerminalManager: async () => manager, taskResourceOperations },
		);
		return { response, writeInput };
	}
	it("submits multiline text as one bracketed paste to the exact ready launch", async () => {
		const { response, writeInput } = await send();
		expect(response.ok).toBe(true);
		expect(writeInput).toHaveBeenCalledWith(
			"task-1",
			Buffer.from("\x1b[200~Check the layout\non a narrow screen\x1b[201~\r"),
			{ explicitUserSubmission: true },
		);
	});
	it.each([
		{ ...ready, pid: null },
		{ ...ready, sessionInstanceId: "replacement" },
		{ ...ready, state: "running" as const },
		{ ...ready, outstandingInteraction: createTestTaskOutstandingInteraction() },
		{ ...ready, outstandingInteraction: createTestTaskOutstandingInteraction({ status: "response_submitted" }) },
		{ ...ready, reviewReason: "unconfirmed" as const },
		{ ...ready, agentId: null },
	])("rejects stale, busy, stopped, uncertain, and approval prompts before writing", async (summary) => {
		const { response, writeInput } = await send(summary);
		expect(response.ok).toBe(false);
		expect(writeInput).not.toHaveBeenCalled();
	});
	it("rechecks the actual PTY identity, not just its projected summary", async () => {
		const { response, writeInput } = await send(ready, "replacement");
		expect(response.ok).toBe(false);
		expect(writeInput).not.toHaveBeenCalled();
	});
	it.each(["\x1b[201~unsafe", "\u0003", " ", "x".repeat(8_001)])(
		"rejects terminal control bytes and invalid lengths",
		async (text) => {
			const { response, writeInput } = await send(ready, "launch-1", text);
			expect(response.ok).toBe(false);
			expect(writeInput).not.toHaveBeenCalled();
		},
	);
});
