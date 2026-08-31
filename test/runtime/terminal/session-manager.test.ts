import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { buildShellCommandLine } from "../../../src/core";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import {
	DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER,
	resolveEffectiveTerminalRowMultiplier,
	resolveEffectiveTerminalRows,
} from "../../../src/terminal/session-manager-types";
import {
	createTestProviderHookEvent,
	createTestTaskNativeWorkEvidence,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function createTestManager(): TerminalSessionManager {
	return new TerminalSessionManager(new InMemorySessionSummaryStore());
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		...overrides,
	});
}

describe("TerminalSessionManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("transitions to review from a canonical provider event", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "running", reviewReason: null }),
		});
		const result = store.applySessionEvent("task-1", createTestProviderHookEvent("to_review"));
		expect(result?.summary.state).toBe("awaiting_review");
		expect(result?.clearAttentionBuffer).toBe(true);
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("claude", ["--auto", "high", "hello world"], "linux");
		expect(commandLine).toContain("claude");
		expect(commandLine).toContain("--auto");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("activity", {
				hookEventName: "PreToolUse",
				metadata: { activityText: "Using Read", toolName: "Read" },
			}),
		)?.summary;

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("clears stale event-identity fields when a new hook event arrives", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		// Simulate a permission prompt event
		manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("to_review", {
				hookEventName: "PermissionRequest",
				metadata: {
					activityText: "Waiting for approval",
					notificationType: "permission_prompt",
					promptId: "prompt-1",
					toolName: "Bash",
				},
			}),
		);

		const updated = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("to_review", {
				hookEventName: "Stop",
				metadata: {
					activityText: "Task complete",
					finalMessage: "Done with the work",
					promptId: "prompt-1",
				},
			}),
		)?.summary;

		// Event-identity fields should reflect the new event, not the stale permission values
		expect(updated?.latestHookActivity?.hookEventName).toBe("Stop");
		expect(updated?.latestHookActivity?.activityText).toBe("Task complete");
		expect(updated?.latestHookActivity?.finalMessage).toBe("Done with the work");
		expect(updated?.latestHookActivity?.notificationType).toBeNull();
		// Contextual fields carry forward
		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.toolName).toBe("Bash");
	});

	it("preserves previous fields for non-event activity updates", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		// Set initial state with event fields
		manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("activity", {
				hookEventName: "PostToolUse",
				metadata: { activityText: "Using Read", toolName: "Read", toolInputSummary: "src/index.ts" },
			}),
		);

		// Activity update with only tool info (no hookEventName or notificationType)
		const updated = manager.store.applySessionEvent("task-1", {
			type: "provider.hook",
			event: "activity",
			metadata: { source: "claude", toolName: "Write", toolInputSummary: "src/main.ts" },
			sessionEvidence: "live",
		})?.summary;

		// Previous event-identity fields should carry forward since this is not a new event
		expect(updated?.latestHookActivity?.hookEventName).toBe("PostToolUse");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Write");
		expect(updated?.latestHookActivity?.toolInputSummary).toBe("src/main.ts");
	});

	it("stores resumeSessionId without clobbering existing hook activity", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({
				state: "running",
				agentId: "codex",
				latestHookActivity: {
					source: "codex",
					activityText: "Running command: npm test",
					hookEventName: "exec_command_begin",
					notificationType: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					conversationSummaryText: null,
				},
			}),
		});

		const updated = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("activity", {
				source: "codex",
				hookEventName: "session_meta",
				metadata: { sessionId: "019d6fa0-db65-7f83-9531-35df54674d76" },
			}),
		)?.summary;

		expect(updated?.resumeSessionId).toBe("019d6fa0-db65-7f83-9531-35df54674d76");
		expect(updated?.latestHookActivity?.activityText).toBe("Running command: npm test");
		expect(updated?.latestHookActivity?.hookEventName).toBe("exec_command_begin");
	});

	it("dedupes repeated metadata-only session ids", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({
				state: "running",
				agentId: "codex",
				resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
			}),
		});

		const before = manager.store.getSummary("task-1");
		const updated = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("activity", {
				source: "codex",
				hookEventName: "session_meta",
				metadata: { sessionId: "019d6fa0-db65-7f83-9531-35df54674d76" },
			}),
		)?.summary;
		const after = manager.store.getSummary("task-1");

		expect(updated).toEqual(before);
		expect(after).toEqual(before);
	});

	it("stores Claude SessionStart session ids without clobbering existing hook activity", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({
				state: "running",
				agentId: "claude",
				latestHookActivity: {
					source: "claude",
					activityText: "Using Bash: npm test",
					hookEventName: "PreToolUse",
					notificationType: null,
					toolName: "Bash",
					toolInputSummary: "Bash: npm test",
					finalMessage: null,
					conversationSummaryText: null,
				},
			}),
		});

		const updated = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("activity", {
				hookEventName: "SessionStart",
				metadata: {
					sessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
					transcriptPath: "/Users/dev/.claude/projects/repo/019d6fa0-db65-7f83-9531-35df54674d76.jsonl",
				},
			}),
		)?.summary;

		expect(updated?.resumeSessionId).toBe("019d6fa0-db65-7f83-9531-35df54674d76");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Bash: npm test");
		expect(updated?.latestHookActivity?.hookEventName).toBe("PreToolUse");
	});

	it("uses a fixed detached row multiplier only for Claude without browser output", () => {
		expect(resolveEffectiveTerminalRowMultiplier("claude", false)).toBe(DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER);
		expect(resolveEffectiveTerminalRowMultiplier("claude", true)).toBe(1);
		expect(resolveEffectiveTerminalRowMultiplier("claude", false, { claudeFullscreenEnabled: true })).toBe(1);
		expect(resolveEffectiveTerminalRowMultiplier("codex", false)).toBe(1);
		expect(resolveEffectiveTerminalRowMultiplier(null, false)).toBe(1);
		expect(resolveEffectiveTerminalRows("claude", 40, false)).toBe(40 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER);
		expect(resolveEffectiveTerminalRows("claude", 40, true)).toBe(40);
		expect(resolveEffectiveTerminalRows("claude", 40, false, { claudeFullscreenEnabled: true })).toBe(40);
	});

	it("applies hook state, activity, and session identity in one store emission", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
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
		const onChange = vi.fn();
		manager.store.onChange(onChange);

		const reviewed = manager.store.applySessionEvent(
			"task-1",
			createTestProviderHookEvent("to_review", {
				metadata: {
					activityText: "Task complete",
					finalMessage: "Done with the work",
					sessionId: "claude-session-1",
				},
			}),
		)?.summary;
		expect(reviewed?.state).toBe("awaiting_review");
		expect(reviewed?.reviewReason).toBe("hook");
		expect(reviewed?.resumeSessionId).toBe("claude-session-1");
		expect(reviewed?.latestHookActivity?.hookEventName).toBe("Stop");
		expect(reviewed?.latestHookActivity?.notificationType).toBeNull();
		expect(reviewed?.latestHookActivity?.activityText).toBe("Task complete");
		expect(reviewed?.latestHookActivity?.finalMessage).toBe("Done with the work");
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ state: "awaiting_review" }));
	});

	it("marks crash-recovered running sessions as interrupted during hydration", () => {
		const manager = createTestManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		// Hydration detects the stale running state and marks it as interrupted
		// so the UI can show a restart button and auto-resume.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
		expect(summary?.pid).toBeNull();
		expect(summary?.agentId).toBe("claude");
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.store.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.store.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.store.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-probe": createSummary({ taskId: "task-probe", state: "running" }),
		});
		const onOutput = vi.fn();
		const entry = {
			taskId: "task-probe",
			active: {
				session: {
					resize: vi.fn(),
				},
				agentId: "claude",
				cols: 80,
				baseRows: 24,
				rows: 24 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER,
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
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const result = manager.store.appendConversationSummary("task-1", {
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
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const longText = "X".repeat(100);
			const result = manager.store.appendConversationSummary("task-1", {
				text: longText,
				capturedAt: 1000,
			});

			expect(result?.displaySummary?.length).toBe(91); // 90 + ellipsis
			expect(result?.displaySummary?.endsWith("\u2026")).toBe(true);
		});

		it("replaces stale generated display summaries with the latest raw summary", () => {
			const generatedAt = Date.now();
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({
					state: "running",
					displaySummaryGeneratedAt: generatedAt,
				}),
			});

			const result = manager.store.appendConversationSummary("task-1", {
				text: "New summary",
				capturedAt: 1000,
			});

			expect(result?.displaySummary).toBe("New summary");
			expect(result?.displaySummaryGeneratedAt).toBeNull();
		});

		it("retains at most 5 entries", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			for (let i = 0; i < 7; i++) {
				manager.store.appendConversationSummary("task-1", {
					text: `Summary ${i}`,
					capturedAt: 1000 + i,
				});
			}

			const result = manager.store.getSummary("task-1");
			expect(result?.conversationSummaries.length).toBeLessThanOrEqual(5);
			// First entry is always retained.
			expect(result?.conversationSummaries[0].text).toBe("Summary 0");
			// Latest entry is always retained.
			expect(result?.conversationSummaries[result?.conversationSummaries.length - 1].text).toBe("Summary 6");
		});

		it("drops entries when total chars exceed 2000", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			// Each entry is 450 chars. 5 entries = 2250 > 2000.
			for (let i = 0; i < 5; i++) {
				manager.store.appendConversationSummary("task-1", {
					text: `${"Z".repeat(448)}${i}`,
					capturedAt: 1000 + i,
				});
			}

			const result = manager.store.getSummary("task-1");
			const totalChars = result?.conversationSummaries.reduce((sum, e) => sum + e.text.length, 0);
			expect(totalChars).toBeLessThanOrEqual(2000);
			// First and latest are always retained.
			expect(result?.conversationSummaries.length).toBeGreaterThanOrEqual(2);
		});

		it("truncates individual entry text to 500 chars", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const longText = "Y".repeat(600);
			const result = manager.store.appendConversationSummary("task-1", {
				text: longText,
				capturedAt: 1000,
			});

			expect(result?.conversationSummaries[0].text.length).toBe(501); // 500 + ellipsis
		});

		it("returns null for a nonexistent task", () => {
			const manager = createTestManager();
			const result = manager.store.appendConversationSummary("nonexistent", {
				text: "Some text",
				capturedAt: 1000,
			});
			expect(result).toBeNull();
		});

		it("auto-increments sessionIndex", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			manager.store.appendConversationSummary("task-1", { text: "First", capturedAt: 1 });
			manager.store.appendConversationSummary("task-1", { text: "Second", capturedAt: 2 });
			const result = manager.store.appendConversationSummary("task-1", { text: "Third", capturedAt: 3 });

			expect(result?.conversationSummaries[0].sessionIndex).toBe(0);
			expect(result?.conversationSummaries[1].sessionIndex).toBe(1);
			expect(result?.conversationSummaries[2].sessionIndex).toBe(2);
		});
	});

	describe("setDisplaySummary", () => {
		it("sets displaySummary and generatedAt timestamp", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const now = Date.now();
			const result = manager.store.setDisplaySummary("task-1", "LLM-generated summary", now);

			expect(result?.displaySummary).toBe("LLM-generated summary");
			expect(result?.displaySummaryGeneratedAt).toBe(now);
		});

		it("sets generatedAt to null for raw fallback summaries", () => {
			const manager = createTestManager();
			manager.store.hydrateFromRecord({
				"task-1": createSummary({ state: "running" }),
			});

			const result = manager.store.setDisplaySummary("task-1", "Raw fallback text", null);

			expect(result?.displaySummary).toBe("Raw fallback text");
			expect(result?.displaySummaryGeneratedAt).toBeNull();
		});

		it("returns null for a nonexistent task", () => {
			const manager = createTestManager();
			const result = manager.store.setDisplaySummary("nonexistent", "Text", null);
			expect(result).toBeNull();
		});
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = createTestManager();
		manager.store.hydrateFromRecord({
			"task-control-first": createSummary({ taskId: "task-control-first", state: "running" }),
		});
		const entry = {
			taskId: "task-control-first",
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
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-resize",
			active: {
				session: {
					resize: resizeSpy,
				},
				agentId: null,
				cols: 80,
				baseRows: 24,
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

	it("uses the platform redraw owner for a forced same-size resize", () => {
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const forceRedrawSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-force-redraw",
			active: {
				session: {
					resize: resizeSpy,
					forceRedraw: forceRedrawSpy,
				},
				agentId: "codex",
				cols: 100,
				baseRows: 30,
				rows: 30,
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
		).entries.set("task-force-redraw", entry);

		const resized = manager.resize("task-force-redraw", 100, 30, 1200, 720, true);

		expect(resized).toBe(true);
		expect(resizeSpy).not.toHaveBeenCalled();
		expect(forceRedrawSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("applies the detached Claude row multiplier to resize rows", () => {
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-resize-mult",
			active: {
				session: {
					resize: resizeSpy,
				},
				agentId: "claude",
				cols: 80,
				baseRows: 24,
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
		).entries.set("task-resize-mult", entry);
		manager.store.hydrateFromRecord({
			"task-resize-mult": createSummary({ taskId: "task-resize-mult", agentId: "claude" }),
		});

		const resized = manager.resize("task-resize-mult", 100, 30);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER, undefined, undefined);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER);
	});

	it("keeps resize rows unmultiplied while browser output is attached", () => {
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-resize-live",
			active: {
				session: {
					resize: resizeSpy,
				},
				agentId: "claude",
				cols: 80,
				baseRows: 24,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map([[1, { onOutput: vi.fn() }]]),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize-live", entry);
		manager.store.hydrateFromRecord({
			"task-resize-live": createSummary({ taskId: "task-resize-live", agentId: "claude" }),
		});

		const resized = manager.resize("task-resize-live", 100, 30);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, undefined, undefined);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("keeps detached fullscreen Claude rows unmultiplied", () => {
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-resize-fullscreen",
			active: {
				session: {
					resize: resizeSpy,
				},
				agentId: "claude",
				claudeFullscreenEnabled: true,
				cols: 80,
				baseRows: 24,
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
		).entries.set("task-resize-fullscreen", entry);
		manager.store.hydrateFromRecord({
			"task-resize-fullscreen": createSummary({ taskId: "task-resize-fullscreen", agentId: "claude" }),
		});

		const resized = manager.resize("task-resize-fullscreen", 100, 30);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, undefined, undefined);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("expands Claude rows again when the last browser output listener detaches", () => {
		const manager = createTestManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			taskId: "task-detach",
			active: {
				session: {
					resize: resizeSpy,
				},
				agentId: "claude",
				cols: 100,
				baseRows: 30,
				rows: 30 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER,
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
				setBatching: vi.fn(),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-detach", entry);

		const detach = manager.attach("task-detach", { onOutput: vi.fn() });
		expect(resizeSpy).toHaveBeenLastCalledWith(100, 30, undefined, undefined);
		expect(resizeMirrorSpy).toHaveBeenLastCalledWith(100, 30);

		detach?.();
		expect(resizeSpy).toHaveBeenLastCalledWith(
			100,
			30 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER,
			undefined,
			undefined,
		);
		expect(resizeMirrorSpy).toHaveBeenLastCalledWith(100, 30 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = createTestManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			taskId: "task-restore",
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

	it("warns when a task session does not exit before waitForExit times out", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = createTestManager();
		const stop = vi.fn();

		(
			manager as unknown as {
				entries: Map<string, unknown>;
			}
		).entries.set("task-timeout", {
			taskId: "task-timeout",
			active: {
				session: {
					stop,
				},
			},
			pendingExitResolvers: [],
			suppressAutoRestartOnExit: false,
			listeners: new Map(),
			listenerIdCounter: 1,
			terminalStateMirror: null,
		});
		manager.store.hydrateFromRecord({
			"task-timeout": createSummary({
				taskId: "task-timeout",
				pid: 1234,
				state: "running",
			}),
		});
		manager.store.update("task-timeout", {
			state: "running",
			reviewReason: null,
			pid: 1234,
			sessionInstanceId: "current-timeout-process",
			nativeWorkEvidence: createTestTaskNativeWorkEvidence({
				provider: "claude",
				sessionInstanceId: "current-timeout-process",
			}),
		});

		const waitPromise = manager.stopTaskSessionAndWaitForExit("task-timeout", 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		const result = await waitPromise;

		expect(stop).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			didExit: false,
			outcome: "timed_out",
			error: "Task session did not exit before the timeout.",
		});
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[session-lifecycle]"),
			"task session did not exit before timeout",
			expect.objectContaining({
				taskId: "task-timeout",
				timeoutMs: 1_000,
				currentPid: 1234,
			}),
		);
	});

	it("rejects a new start request while the previous task session is still exiting", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = createTestManager();
		const stop = vi.fn();

		(
			manager as unknown as {
				entries: Map<string, unknown>;
			}
		).entries.set("task-restart", {
			taskId: "task-restart",
			active: {
				session: {
					stop,
				},
			},
			pendingExitResolvers: [],
			suppressAutoRestartOnExit: false,
			listeners: new Map(),
			listenerIdCounter: 1,
			terminalStateMirror: null,
			restartRequest: null,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			pendingSessionStart: false,
			hookCount: 0,
			hookEventOrder: null,
			launchMonitor: null,
			pendingStartupRecoveryToken: null,
		});
		manager.store.hydrateFromRecord({
			"task-restart": createSummary({
				taskId: "task-restart",
				pid: 4321,
				state: "running",
			}),
		});
		manager.store.update("task-restart", {
			state: "running",
			reviewReason: null,
			pid: 4321,
			sessionInstanceId: "current-restart-process",
			nativeWorkEvidence: createTestTaskNativeWorkEvidence({
				provider: "claude",
				sessionInstanceId: "current-restart-process",
			}),
		});

		manager.stopTaskSession("task-restart");

		await expect(
			manager.startTaskSession({
				taskId: "task-restart",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-restart",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow("Task session is still shutting down. Wait a moment and try again.");
		expect(stop).toHaveBeenCalledTimes(1);
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[session-lifecycle]"),
			"task session start requested while previous session is still exiting",
			expect.objectContaining({
				taskId: "task-restart",
				currentPid: 4321,
			}),
		);
	});

	it("does not rewrite an inactive review session on duplicate stop", () => {
		const manager = createTestManager();
		const hookActivity = {
			activityText: "Ready for review",
			toolName: null,
			toolInputSummary: null,
			finalMessage: "Done",
			hookEventName: "Stop",
			notificationType: "review.ready",
			source: "claude",
			conversationSummaryText: null,
		} as const;
		(
			manager as unknown as {
				entries: Map<string, unknown>;
			}
		).entries.set("task-inactive-review", {
			taskId: "task-inactive-review",
			active: null,
			pendingExitResolvers: [],
			suppressAutoRestartOnExit: false,
			listeners: new Map(),
			listenerIdCounter: 1,
			terminalStateMirror: null,
		});
		manager.store.hydrateFromRecord({
			"task-inactive-review": createSummary({
				taskId: "task-inactive-review",
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				latestHookActivity: hookActivity,
			}),
		});

		const summary = manager.stopTaskSession("task-inactive-review");

		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("hook");
		expect(summary?.latestHookActivity).toEqual(hookActivity);
	});
});
