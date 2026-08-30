import { describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import type { TerminalSessionManager } from "../../../src/terminal";
import { handleSendTaskSessionInput } from "../../../src/trpc/handlers/send-task-session-input";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

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
