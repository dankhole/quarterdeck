import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("claude", ["--auto", "high", "hello world"]);
		expect(commandLine).toContain("claude");
		expect(commandLine).toContain("--auto");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("clears stale event-identity fields when a new hook event arrives", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		// Simulate a permission prompt event
		manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Waiting for approval",
			hookEventName: "PermissionRequest",
			notificationType: "permission_prompt",
			toolName: "Bash",
		});

		// Simulate a subsequent to_review event that only carries hookEventName + activityText
		const updated = manager.applyHookActivity("task-1", {
			hookEventName: "agent_end",
			activityText: "Task complete",
			finalMessage: "Done with the work",
		});

		// Event-identity fields should reflect the new event, not the stale permission values
		expect(updated?.latestHookActivity?.hookEventName).toBe("agent_end");
		expect(updated?.latestHookActivity?.activityText).toBe("Task complete");
		expect(updated?.latestHookActivity?.finalMessage).toBe("Done with the work");
		expect(updated?.latestHookActivity?.notificationType).toBeNull();
		// Contextual fields carry forward
		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.toolName).toBe("Bash");
	});

	it("preserves previous fields for non-event activity updates", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		// Set initial state with event fields
		manager.applyHookActivity("task-1", {
			source: "claude",
			hookEventName: "PostToolUse",
			activityText: "Using Read",
			toolName: "Read",
			toolInputSummary: "src/index.ts",
		});

		// Activity update with only tool info (no hookEventName or notificationType)
		const updated = manager.applyHookActivity("task-1", {
			toolName: "Write",
			toolInputSummary: "src/main.ts",
		});

		// Previous event-identity fields should carry forward since this is not a new event
		expect(updated?.latestHookActivity?.hookEventName).toBe("PostToolUse");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Write");
		expect(updated?.latestHookActivity?.toolInputSummary).toBe("src/main.ts");
	});

	it("transitionToReview preserves latestHookActivity (RC4 invariant — no null-window)", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "running",
				latestHookActivity: {
					source: "claude",
					activityText: "Waiting for approval",
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
					toolName: "Bash",
					toolInputSummary: null,
					finalMessage: null,
					conversationSummaryText: null,
				},
			}),
		});

		// Transition to review — must NOT clear latestHookActivity (RC4 invariant).
		// The caller (hooks-api.ts) applies new activity via applyHookActivity in
		// the same synchronous tick, which replaces it atomically.
		const reviewed = manager.transitionToReview("task-1", "hook");
		expect(reviewed?.state).toBe("awaiting_review");
		expect(reviewed?.reviewReason).toBe("hook");
		// Activity is preserved — no null-window
		expect(reviewed?.latestHookActivity).not.toBeNull();
		expect(reviewed?.latestHookActivity?.hookEventName).toBe("PermissionRequest");

		// applyHookActivity with a new event clears stale fields via isNewEvent=true
		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			hookEventName: "Stop",
			activityText: "Task complete",
			finalMessage: "Done with the work",
		});

		// isNewEvent=true: hookEventName replaced, old notificationType cleared
		expect(updated?.latestHookActivity?.hookEventName).toBe("Stop");
		expect(updated?.latestHookActivity?.notificationType).toBeNull();
		expect(updated?.latestHookActivity?.activityText).toBe("Task complete");
		expect(updated?.latestHookActivity?.finalMessage).toBe("Done with the work");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	describe("appendConversationSummary", () => {
		it("adds a conversation summary entry and sets raw displaySummary", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const result = manager.appendConversationSummary("task-1", {
				text: "Completed the auth refactor",
				capturedAt: 1000,
			});

			expect(result).not.toBeNull();
			expect(result?.conversationSummaries).toHaveLength(1);
			expect(result?.conversationSummaries[0].text).toBe("Completed the auth refactor");
			expect(result?.conversationSummaries[0].sessionIndex).toBe(0);
			expect(result?.displaySummary).toBe("Completed the auth refactor");
		});

		it("truncates displaySummary to 90 chars with ellipsis", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const longText = "X".repeat(100);
			const result = manager.appendConversationSummary("task-1", {
				text: longText,
				capturedAt: 1000,
			});

			expect(result?.displaySummary?.length).toBe(91); // 90 + ellipsis
			expect(result?.displaySummary?.endsWith("\u2026")).toBe(true);
		});

		it("preserves displaySummaryGeneratedAt when LLM summary exists", () => {
			const generatedAt = Date.now();
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({
					state: "running",
					displaySummaryGeneratedAt: generatedAt,
				}),
			});

			const result = manager.appendConversationSummary("task-1", {
				text: "New summary",
				capturedAt: 1000,
			});

			expect(result?.displaySummaryGeneratedAt).toBe(generatedAt);
		});

		it("retains at most 5 entries", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			for (let i = 0; i < 7; i++) {
				manager.appendConversationSummary("task-1", {
					text: `Summary ${i}`,
					capturedAt: 1000 + i,
				});
			}

			const result = manager.getSummary("task-1");
			expect(result?.conversationSummaries.length).toBeLessThanOrEqual(5);
			// First entry is always retained.
			expect(result?.conversationSummaries[0].text).toBe("Summary 0");
			// Latest entry is always retained.
			expect(result?.conversationSummaries[result?.conversationSummaries.length - 1].text).toBe("Summary 6");
		});

		it("drops entries when total chars exceed 2000", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			// Each entry is 450 chars. 5 entries = 2250 > 2000.
			for (let i = 0; i < 5; i++) {
				manager.appendConversationSummary("task-1", {
					text: `${"Z".repeat(448)}${i}`,
					capturedAt: 1000 + i,
				});
			}

			const result = manager.getSummary("task-1");
			const totalChars = result?.conversationSummaries.reduce((sum, e) => sum + e.text.length, 0);
			expect(totalChars).toBeLessThanOrEqual(2000);
			// First and latest are always retained.
			expect(result?.conversationSummaries.length).toBeGreaterThanOrEqual(2);
		});

		it("truncates individual entry text to 500 chars", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const longText = "Y".repeat(600);
			const result = manager.appendConversationSummary("task-1", {
				text: longText,
				capturedAt: 1000,
			});

			expect(result?.conversationSummaries[0].text.length).toBe(501); // 500 + ellipsis
		});

		it("returns null for a nonexistent task", () => {
			const manager = new TerminalSessionManager();
			const result = manager.appendConversationSummary("nonexistent", {
				text: "Some text",
				capturedAt: 1000,
			});
			expect(result).toBeNull();
		});

		it("auto-increments sessionIndex", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			manager.appendConversationSummary("task-1", { text: "First", capturedAt: 1 });
			manager.appendConversationSummary("task-1", { text: "Second", capturedAt: 2 });
			const result = manager.appendConversationSummary("task-1", { text: "Third", capturedAt: 3 });

			expect(result?.conversationSummaries[0].sessionIndex).toBe(0);
			expect(result?.conversationSummaries[1].sessionIndex).toBe(1);
			expect(result?.conversationSummaries[2].sessionIndex).toBe(2);
		});
	});

	describe("setDisplaySummary", () => {
		it("sets displaySummary and generatedAt timestamp", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const now = Date.now();
			const result = manager.setDisplaySummary("task-1", "LLM-generated summary", now);

			expect(result?.displaySummary).toBe("LLM-generated summary");
			expect(result?.displaySummaryGeneratedAt).toBe(now);
		});

		it("sets generatedAt to null for raw fallback summaries", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const result = manager.setDisplaySummary("task-1", "Raw fallback text", null);

			expect(result?.displaySummary).toBe("Raw fallback text");
			expect(result?.displaySummaryGeneratedAt).toBeNull();
		});

		it("returns null for a nonexistent task", () => {
			const manager = new TerminalSessionManager();
			const result = manager.setDisplaySummary("nonexistent", "Text", null);
			expect(result).toBeNull();
		});
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});
});
