import { describe, expect, it, vi } from "vitest";
import type { ConversationReadResult } from "../../src/conversation";
import { createTaskProgressPreview } from "../../src/server/task-progress-preview";
import { InMemorySessionSummaryStore } from "../../src/terminal";
import { createTestTaskNativeWorkEvidence, createTestTaskSessionSummary } from "../utilities/task-session-factory";

function response(text = "Checking keyboard navigation", recordedAt = 200): ConversationReadResult {
	return {
		status: "available",
		reason: null,
		entries: [{ type: "message", id: "message-1", role: "assistant", text, recordedAt }],
		hasOlder: false,
		incomplete: false,
		requestedMessages: 1,
		diagnostics: {
			sourceBytesExamined: 100,
			recordsExamined: 1,
			lookupEntriesExamined: 0,
			returnedMessages: 1,
			returnedBoundaries: 0,
			durationMs: 1,
			issues: [],
		},
	};
}
function setup() {
	let time = 100;
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry("task-1");
	store.update(
		"task-1",
		createTestTaskSessionSummary({
			taskId: "task-1",
			agentId: "codex",
			state: "running",
			pid: 123,
			sessionInstanceId: "launch-1",
			resumeSessionId: "session-1",
			nativeWorkEvidence: createTestTaskNativeWorkEvidence({
				sessionInstanceId: "launch-1",
				providerSessionId: "session-1",
				turnId: "turn-1",
			}),
		}),
	);
	const readRecent = vi.fn(async () => response());
	const hasSource = vi.fn(() => true);
	const service = createTaskProgressPreview({ reads: { readRecent }, hasSource, now: () => time });
	const observe = () => {
		const previous = store.getSummary("task-1");
		if (!previous) throw new Error("Missing test session");
		service.observe({ projectId: "project-1", taskId: "task-1", store, previous });
	};
	return {
		store,
		service,
		observe,
		readRecent,
		hasSource,
		setTime: (value: number) => {
			time = value;
		},
	};
}

describe("task progress preview sampling", () => {
	it("samples only on activity, at most once per 30 seconds, without publishing unchanged text", async () => {
		const { store, service, observe, readRecent, setTime } = setup();
		const update = vi.spyOn(store, "update");
		expect(readRecent).not.toHaveBeenCalled();
		observe();
		await vi.waitFor(() => expect(store.getSummary("task-1")?.progressMessage).toBe("Checking keyboard navigation"));
		observe();
		setTime(30_099);
		observe();
		expect(readRecent).toHaveBeenCalledTimes(1);
		setTime(30_100);
		observe();
		await vi.waitFor(() => expect(readRecent).toHaveBeenCalledTimes(2));
		await service.close();
		expect(update).toHaveBeenCalledTimes(1);
		expect(store.getSummary("task-1")?.conversationSummaries).toEqual([]);
	});
	it("clears progress on completion and cold hydration without changing completed history", async () => {
		const { store, service, observe } = setup();
		store.appendConversationSummary("task-1", { text: "Completed response", capturedAt: 1 });
		observe();
		await vi.waitFor(() => expect(store.getSummary("task-1")?.progressMessage).toBeTruthy());
		const running = store.getSummary("task-1");
		if (!running) throw new Error("Missing session");
		const restored = new InMemorySessionSummaryStore();
		restored.hydrateFromRecord({ "task-1": running });
		expect(restored.getSummary("task-1")?.progressMessage).toBeNull();
		store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
		expect(store.getSummary("task-1")?.progressMessage).toBeNull();
		expect(store.getSummary("task-1")?.conversationSummaries.at(-1)?.text).toBe("Completed response");
		await service.close();
	});

	it("does not read idle tasks, unsupported providers, or sessions without a supplied source", async () => {
		const { store, service, observe, readRecent, hasSource } = setup();
		hasSource.mockReturnValue(false);
		observe();
		hasSource.mockReturnValue(true);
		store.update("task-1", { agentId: "pi" });
		observe();
		store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
		observe();
		expect(readRecent).not.toHaveBeenCalled();
		await service.close();
	});
	it("preserves the read cooldown across completed turns", async () => {
		const { store, service, observe, readRecent, setTime } = setup();
		observe();
		await vi.waitFor(() => expect(store.getSummary("task-1")?.progressMessage).toBeTruthy());
		const running = store.getSummary("task-1");
		if (!running?.nativeWorkEvidence) throw new Error("Missing running session");
		store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
		observe();
		setTime(200);
		store.update("task-1", {
			state: "running",
			nativeWorkEvidence: { ...running.nativeWorkEvidence, turnId: "turn-2" },
		});
		observe();
		expect(readRecent).toHaveBeenCalledTimes(1);
		expect(store.getSummary("task-1")?.progressMessage).toBeFalsy();
		setTime(30_100);
		observe();
		expect(readRecent).toHaveBeenCalledTimes(2);
		await service.close();
	});
	it("ignores old messages and caps retained progress text", async () => {
		const { store, service, observe, readRecent, setTime } = setup();
		readRecent.mockResolvedValueOnce(response("Old answer", 99));
		observe();
		await vi.waitFor(() => expect(readRecent).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		await Promise.resolve();
		expect(store.getSummary("task-1")?.progressMessage).toBeFalsy();
		setTime(30_100);
		readRecent.mockResolvedValueOnce(response("x".repeat(1000), 30_100));
		observe();
		await vi.waitFor(() => expect(store.getSummary("task-1")?.progressMessage).toHaveLength(500));
		await service.close();
	});
	it.each(["completion", "replacement", "close"] as const)("discards an in-flight read after %s", async (reason) => {
		const { store, service, observe, readRecent } = setup();
		let resolve!: (result: ConversationReadResult) => void;
		readRecent.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		observe();
		observe();
		expect(readRecent).toHaveBeenCalledTimes(1);
		if (reason === "completion") store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
		if (reason === "replacement") store.update("task-1", { resumeSessionId: "replacement" });
		const closing = reason === "close" ? service.close() : null;
		resolve(response());
		await (closing ?? new Promise((done) => setTimeout(done, 0)));
		expect(store.getSummary("task-1")?.progressMessage).toBeFalsy();
		await service.close();
	});
});
