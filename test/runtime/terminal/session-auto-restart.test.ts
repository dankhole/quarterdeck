import { describe, expect, it, vi } from "vitest";

import { scheduleAutoRestart, shouldAutoRestart } from "../../../src/terminal/session-auto-restart";
import { createProcessEntry } from "../../../src/terminal/session-manager-types";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

describe("shouldAutoRestart", () => {
	it("classifies interrupted exits as normal lifecycle cleanup before listener checks", () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};

		expect(shouldAutoRestart(entry, "awaiting_review")).toEqual({
			restart: false,
			reason: "not_running",
		});
	});

	it("keeps no-listener running exits visible as skipped crash recovery", () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};

		expect(shouldAutoRestart(entry, "running")).toEqual({
			restart: false,
			reason: "no_listeners",
		});
	});

	it("fails closed when a supported provider has no exact resume identity", async () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};
		const startTaskSession = vi.fn();
		const updateStore = vi.fn(() => createTestTaskSessionSummary({ taskId: "task-1" }));
		const applyDenied = vi.fn();

		scheduleAutoRestart(entry, { startTaskSession, updateStore, applyDenied });
		const pendingAutoRestart = entry.pendingAutoRestart;
		await pendingAutoRestart;

		expect(startTaskSession).not.toHaveBeenCalled();
		expect(applyDenied).toHaveBeenCalledOnce();
		expect(updateStore).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ warningMessage: expect.stringContaining("exact provider session ID") }),
		);
		expect(entry.pendingAutoRestart).toBeNull();
	});

	it("retries once against the exact identity and never falls back to a fresh prompt", async () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};
		const startTaskSession = vi.fn(async () => {
			throw new Error("targeted resume failed");
		});
		const updateStore = vi.fn(() => createTestTaskSessionSummary({ taskId: "task-1" }));
		const applyDenied = vi.fn();

		scheduleAutoRestart(entry, { startTaskSession, updateStore, applyDenied }, { resumeSessionId: "session-1" });
		await entry.pendingAutoRestart;

		expect(startTaskSession).toHaveBeenCalledOnce();
		expect(startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeConversation: true,
				resumeSessionId: "session-1",
				prompt: "",
				images: undefined,
				awaitReview: true,
			}),
		);
		expect(applyDenied).toHaveBeenCalledOnce();
	});
});
