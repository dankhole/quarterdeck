import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
	type ConversationProgressCursor,
	type ConversationProgressReadResult,
	ConversationSourceHintStore,
} from "../../src/conversation";
import type { RuntimeHookIngestRequest, RuntimeHookMetadata } from "../../src/core";
import { RuntimeSessionPersistence } from "../../src/server/runtime-session-persistence";
import { createTaskProgressPreview } from "../../src/server/task-progress-preview";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../src/terminal";
import {
	commitHookEventOrder,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
} from "../../src/terminal/hook-event-order";
import { createHooksApi } from "../../src/trpc";
import { createBoard } from "../utilities/board-factory";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const START = Date.parse("2026-01-01T00:00:00Z");
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

function message(id: string, parentId: string | null, role: string, text: string, timestamp: number) {
	return line({
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role, content: [{ type: "text", text }], timestamp },
	});
}

async function harness(cursor?: ConversationProgressCursor) {
	const temporary = createTempDir("pi-progress-integration-");
	const sourcePath = join(temporary.path, "custom-session-storage.jsonl");
	await writeFile(sourcePath, line({ type: "session", version: 3, id: SESSION_ID, cwd: temporary.path }));
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry("task-1");
	store.update(
		"task-1",
		createTestTaskSessionSummary({
			agentId: "pi",
			sessionInstanceId: "launch-1",
			resumeSessionId: SESSION_ID,
			sessionLaunchPath: temporary.path,
			state: "awaiting_review",
			reviewReason: "hook",
			pid: 4321,
		}),
	);
	store.appendCompletedResponse("task-1", { text: "Previous completed response", capturedAt: START - 1000 });
	const manager = new TerminalSessionManager(store);
	// Keep the real ingest, ordering, reducer, store, cursor and persistence
	// boundaries. Only native process admission is synthetic: no provider or PTY.
	const order = createHookEventOrderState("launch-1");
	vi.spyOn(manager, "recordHookReceived").mockImplementation(() => undefined);
	vi.spyOn(manager, "observeTaskSessionLaunchHook").mockReturnValue(true);
	vi.spyOn(manager, "shouldDeferProviderHookUntilLaunchHandoff").mockReturnValue(false);
	vi.spyOn(manager, "evaluateHookEventOrder").mockImplementation((_taskId, input) =>
		evaluateHookEventOrder(order, input),
	);
	vi.spyOn(manager, "commitHookEventOrder").mockImplementation((taskId, input, advanceTurn) => {
		commitHookEventOrder(order, input, { advanceTurn });
		if (advanceTurn) store.recordProviderHookReceipt(taskId, createProviderHookOrderObservation(input));
	});
	vi.spyOn(manager, "applyProviderHook").mockImplementation((taskId, input) =>
		store.applySessionEvent(taskId, {
			type: "provider.hook",
			event: input.event,
			metadata: input.metadata,
			occurredAt: input.delivery?.occurredAt,
			confirmedAt: input.delivery?.occurredAt,
			sessionEvidence: "live",
		}),
	);
	const reconcileRuntimeSessions = vi.fn(async () => ({
		state: {
			repoPath: temporary.path,
			statePath: join(temporary.path, "state"),
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board: createBoard("Synthetic task"),
			sessions: {},
			revision: 1,
		},
		changed: false,
		acceptedChange: false,
		replayed: false,
	}));
	const persistence = new RuntimeSessionPersistence({
		projectRegistry: { getProjectPathById: () => temporary.path },
		boardCommands: { reconcileRuntimeSessions },
	});
	persistence.trackTerminalManager("project-1", manager);
	await persistence.persistRuntimeSessions("project-1");
	const hints = new ConversationSourceHintStore();
	let time = START;
	const previews = createTaskProgressPreview({
		hints,
		isCurrentStore: (projectId, candidate) => projectId === "project-1" && candidate === store,
		createCursor: cursor ? () => cursor : undefined,
		now: () => time,
	});
	const api = createHooksApi({
		projects: { getProjectPathById: () => temporary.path },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
		conversationSourceHints: hints,
		observeProgress: previews.observe,
		persistSessionState: persistence.persistRuntimeSessions,
		awaitSessionStateDurable: persistence.awaitRuntimeSessionsDurable,
	});
	let deliveryIndex = 0;
	function hook(metadata: RuntimeHookMetadata = {}, event: RuntimeHookIngestRequest["event"] = "to_in_progress") {
		deliveryIndex += 1;
		return api.ingest({
			projectId: "project-1",
			taskId: "task-1",
			event,
			metadata: {
				source: "pi",
				sessionInstanceId: "launch-1",
				sessionId: SESSION_ID,
				transcriptPath: sourcePath,
				hookEventName: event === "to_review" ? "AgentSettled" : "AgentStart",
				turnId: "run-1",
				...metadata,
			},
			delivery: {
				id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`,
				occurredAt: time,
			},
		});
	}
	return {
		sourcePath,
		store,
		manager,
		hints,
		previews,
		persistence,
		reconcileRuntimeSessions,
		hook,
		setTime(value: number) {
			time = value;
		},
		async close() {
			await previews.close();
			await persistence.close();
			temporary.cleanup();
		},
	};
}

describe("Pi hook-to-card progress integration", () => {
	it("delivers appended assistant text through presentation-only updates while retaining completion history", async () => {
		const f = await harness();
		try {
			await appendFile(
				f.sourcePath,
				message("old-user", null, "user", "Previous request", START - 1000) +
					message("old-assistant", "old-user", "assistant", "Old transcript response", START - 999),
			);
			expect(await f.hook()).toEqual({ ok: true });
			await f.previews.refresh();
			expect(f.hints.getHint("project-1", "task-1", SESSION_ID)).toEqual({
				providerId: "pi",
				providerSessionId: SESSION_ID,
				sessionInstanceId: "launch-1",
				sourcePath: f.sourcePath,
			});
			expect(f.store.getSummary("task-1")?.progressMessage).toBeFalsy();
			expect(f.store.getSummary("task-1")?.completedResponses.map((reply) => reply.text)).toEqual([
				"Previous completed response",
			]);
			await f.persistence.awaitRuntimeSessionsDurable("project-1");
			f.reconcileRuntimeSessions.mockClear();
			const before = f.store.getSummary("task-1");
			const onChange = vi.fn();
			const unsubscribe = f.store.onChange(onChange);
			await appendFile(
				f.sourcePath,
				message("user-1", "old-assistant", "user", "Current request", START + 1) +
					message("assistant-1", "user-1", "assistant", "Checking keyboard navigation", START + 2),
			);
			const sourceBeforeRead = await readFile(f.sourcePath, "utf8");
			await f.previews.refresh();
			const after = f.store.getSummary("task-1");
			expect(after?.progressMessage).toBe("Checking keyboard navigation");
			expect(after).toEqual({
				...before,
				progressMessage: "Checking keyboard navigation",
				updatedAt: after?.updatedAt,
			});
			expect(onChange).toHaveBeenCalledWith(after, { presentationOnly: true });
			const changes = onChange.mock.calls.length;
			await f.previews.refresh();
			expect(onChange).toHaveBeenCalledTimes(changes);
			expect(await readFile(f.sourcePath, "utf8")).toBe(sourceBeforeRead);
			await f.persistence.awaitRuntimeSessionsDurable("project-1");
			expect(f.reconcileRuntimeSessions).not.toHaveBeenCalled();
			unsubscribe();

			f.setTime(START + 100);
			expect(await f.hook({ finalMessage: "Final accepted reply" }, "to_review")).toEqual({ ok: true });
			await appendFile(f.sourcePath, message("late", "assistant-1", "assistant", "Late text", START + 101));
			await f.previews.refresh();
			expect(f.store.getSummary("task-1")).toMatchObject({ state: "awaiting_review", progressMessage: null });
			expect(f.store.getSummary("task-1")?.completedResponses.map((reply) => reply.text)).toEqual([
				"Previous completed response",
				"Final accepted reply",
			]);
		} finally {
			await f.close();
		}
	});

	it.each(["Fresh final reply", "Previous completed response"])(
		"retires foreground progress after capturing %s while Pi background work stays Running",
		async (finalMessage) => {
			const f = await harness();
			try {
				expect(await f.hook()).toEqual({ ok: true });
				await f.previews.refresh();
				await appendFile(
					f.sourcePath,
					message("u1", null, "user", "Current request", START + 1) +
						message("a1", "u1", "assistant", finalMessage, START + 2),
				);
				await f.previews.refresh();
				expect(f.store.getSummary("task-1")?.progressMessage).toBe(finalMessage);
				const evidence = f.store.getSummary("task-1")?.nativeWorkEvidence;
				f.setTime(START + 100);
				expect(await f.hook({ hookEventName: "AgentSettledBackgroundPending", finalMessage }, "activity")).toEqual({
					ok: true,
				});
				expect(f.store.getSummary("task-1")).toMatchObject({
					state: "running",
					nativeWorkEvidence: evidence,
					progressMessage: null,
				});
				expect(f.store.getSummary("task-1")?.completedResponses.at(-1)?.text).toBe(finalMessage);
				const completedResponses = f.store.getSummary("task-1")?.completedResponses;
				await f.persistence.awaitRuntimeSessionsDurable("project-1");
				f.reconcileRuntimeSessions.mockClear();
				await appendFile(f.sourcePath, message("late", "a1", "assistant", "Late foreground text", START + 101));
				await f.previews.refresh();
				expect(f.store.getSummary("task-1")?.progressMessage).toBeNull();
				expect(f.reconcileRuntimeSessions).not.toHaveBeenCalled();
				f.setTime(START + 200);
				expect(
					await f.hook({ hookEventName: "ToolExecutionEnd", toolUseId: "background-tool" }, "activity"),
				).toEqual({ ok: true });
				await f.previews.refresh();
				expect(f.store.getSummary("task-1")).toMatchObject({
					state: "running",
					nativeWorkEvidence: evidence,
					progressMessage: null,
					completedResponses,
				});
				f.setTime(START + 300);
				expect(await f.hook({ finalMessage }, "to_review")).toEqual({ ok: true });
				expect(f.store.getSummary("task-1")).toMatchObject({
					state: "awaiting_review",
					progressMessage: null,
					completedResponses,
				});
			} finally {
				await f.close();
			}
		},
	);

	it("retires a missing-text foreground settlement, fences an in-flight read, and ignores later background activity", async () => {
		const response = { text: "Foreground progress", hasMore: false, sourceBytesExamined: 100 };
		const read = vi.fn(async (): Promise<ConversationProgressReadResult> => response);
		const cursor = { read, beginEpoch: vi.fn(), pause: vi.fn() };
		const f = await harness(cursor);
		let resolveRead: ((result: ConversationProgressReadResult) => void) | undefined;
		let pending: Promise<void> | undefined;
		try {
			expect(await f.hook()).toEqual({ ok: true });
			await f.previews.refresh();
			const running = f.store.getSummary("task-1");
			expect(running?.progressMessage).toBe("Foreground progress");
			read.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveRead = resolve;
					}),
			);
			pending = f.previews.refresh();
			expect(resolveRead).toBeTypeOf("function");
			const reads = read.mock.calls.length;
			f.setTime(START + 100);
			// A content-free replay legitimately has settlement identity but no reply.
			expect(await f.hook({ hookEventName: "AgentSettledBackgroundPending" }, "activity")).toEqual({ ok: true });
			expect(f.store.getSummary("task-1")).toMatchObject({
				state: "running",
				nativeWorkEvidence: running?.nativeWorkEvidence,
				progressMessage: null,
				completedResponses: running?.completedResponses,
			});
			resolveRead?.({ ...response, text: "Delayed foreground text", hasMore: true });
			await pending;
			f.setTime(START + 200);
			expect(await f.hook({ hookEventName: "ToolExecutionEnd", toolUseId: "background-tool" }, "activity")).toEqual({
				ok: true,
			});
			await f.previews.refresh();
			expect(read).toHaveBeenCalledTimes(reads);
			expect(cursor.pause).toHaveBeenCalled();
			expect(f.store.getSummary("task-1")).toMatchObject({
				state: "running",
				nativeWorkEvidence: running?.nativeWorkEvidence,
				progressMessage: null,
				completedResponses: running?.completedResponses,
			});
		} finally {
			resolveRead?.(response);
			await pending;
			await f.close();
		}
	});

	it("fences foreign-launch hints and superseded runs before they can replace current progress", async () => {
		const f = await harness();
		try {
			expect(await f.hook()).toEqual({ ok: true });
			await f.previews.refresh();
			await appendFile(
				f.sourcePath,
				message("u1", null, "user", "First request", START + 1) +
					message("a1", "u1", "assistant", "First run progress", START + 2),
			);
			await f.previews.refresh();
			expect(f.store.getSummary("task-1")?.progressMessage).toBe("First run progress");
			const hint = f.hints.getHint("project-1", "task-1", SESSION_ID);
			await f.hook({ sessionInstanceId: "previous-launch", transcriptPath: "/foreign/source.jsonl" });
			expect(f.manager.evaluateHookEventOrder).toHaveLastReturnedWith(expect.objectContaining({ accepted: false }));
			expect(f.hints.getHint("project-1", "task-1", SESSION_ID)).toEqual(hint);

			f.setTime(START + 1000);
			expect(await f.hook({ turnId: "run-2" })).toEqual({ ok: true });
			await f.previews.refresh();
			expect(f.store.getSummary("task-1")?.progressMessage).toBeFalsy();
			await appendFile(
				f.sourcePath,
				message("u2", "a1", "user", "Second request", START + 1001) +
					message("a2", "u2", "assistant", "Second run progress", START + 1002),
			);
			await f.previews.refresh();
			expect(f.store.getSummary("task-1")?.progressMessage).toBe("Second run progress");
			await f.hook(
				{ turnId: "run-1", transcriptPath: "/retired/source.jsonl", finalMessage: "Stale reply" },
				"to_review",
			);
			expect(f.manager.evaluateHookEventOrder).toHaveLastReturnedWith(expect.objectContaining({ accepted: false }));
			expect(f.hints.getHint("project-1", "task-1", SESSION_ID)).toEqual(hint);
			expect(f.store.getSummary("task-1")).toMatchObject({
				state: "running",
				progressMessage: "Second run progress",
			});
			expect(f.store.getSummary("task-1")?.completedResponses.map((reply) => reply.text)).toEqual([
				"Previous completed response",
			]);
		} finally {
			await f.close();
		}
	});
});
