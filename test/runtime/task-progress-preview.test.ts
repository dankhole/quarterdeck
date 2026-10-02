import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationProgressCursor, ConversationProgressReadResult } from "../../src/conversation";
import { createTaskProgressPreview, PROGRESS_PREVIEW_INTERVAL_MS } from "../../src/server/task-progress-preview";
import { InMemorySessionSummaryStore } from "../../src/terminal";
import { createTestTaskNativeWorkEvidence, createTestTaskSessionSummary } from "../utilities/task-session-factory";

function response(
	text: string | null = "Checking keyboard navigation",
	hasMore = false,
): ConversationProgressReadResult {
	return { text, hasMore, sourceBytesExamined: 100 };
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
	const read = vi.fn(async () => response());
	const cursor: ConversationProgressCursor = { read, beginEpoch: vi.fn(), pause: vi.fn() };
	const getHint = vi.fn(() => ({
		providerId: "codex" as const,
		providerSessionId: "session-1",
		sourcePath: "/synthetic/session-1.jsonl",
	}));
	const isCurrentStore = vi.fn(() => true);
	const createCursor = vi.fn(() => cursor);
	const service = createTaskProgressPreview({ hints: { getHint }, isCurrentStore, createCursor, now: () => time });
	const observe = (taskId = "task-1") => {
		const previous = store.getSummary(taskId);
		if (!previous) throw new Error("Missing test session");
		service.observe({ projectId: "project-1", taskId, store, previous });
	};
	return {
		store,
		service,
		observe,
		read,
		cursor,
		getHint,
		isCurrentStore,
		createCursor,
		setTime(value: number) {
			time = value;
		},
	};
}

describe("incremental task progress preview delivery", () => {
	afterEach(() => vi.useRealTimers());

	it("polls active sources without another hook and avoids unchanged store updates", async () => {
		vi.useFakeTimers();
		const { store, service, observe, read } = setup();
		const update = vi.spyOn(store, "update");
		try {
			observe();
			await service.refresh();
			expect(store.getSummary("task-1")?.progressMessage).toBe("Checking keyboard navigation");
			read.mockResolvedValue(response("Checking focus restoration"));
			await vi.advanceTimersByTimeAsync(PROGRESS_PREVIEW_INTERVAL_MS);
			expect(store.getSummary("task-1")?.progressMessage).toBe("Checking focus restoration");
			await vi.advanceTimersByTimeAsync(PROGRESS_PREVIEW_INTERVAL_MS);
			await service.refresh();
			expect(
				update.mock.calls.filter(([, change]) => change.progressMessage === "Checking focus restoration"),
			).toHaveLength(1);
			expect(store.getSummary("task-1")?.conversationSummaries).toEqual([]);
		} finally {
			await service.close();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the old preview immediately on a new turn and reuses its cursor without cooldown", async () => {
		const { store, service, observe, cursor, setTime, createCursor } = setup();
		try {
			observe();
			await service.refresh();
			const previous = store.getSummary("task-1");
			if (!previous?.nativeWorkEvidence) throw new Error("Missing work evidence");
			setTime(200);
			store.update("task-1", { nativeWorkEvidence: { ...previous.nativeWorkEvidence, turnId: "turn-2" } });
			service.observe({ projectId: "project-1", taskId: "task-1", store, previous });
			expect(store.getSummary("task-1")?.progressMessage).toBeNull();
			expect(cursor.beginEpoch).toHaveBeenCalledWith(200);
			expect(createCursor).toHaveBeenCalledTimes(1);
		} finally {
			await service.close();
		}
	});

	it("does not read unsupported, idle, or unhinted tasks", async () => {
		const { store, service, observe, read, getHint } = setup();
		try {
			getHint.mockReturnValueOnce(null as never);
			observe();
			store.update("task-1", { agentId: "pi" });
			observe();
			store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
			observe();
			await service.refresh();
			expect(read).not.toHaveBeenCalled();
		} finally {
			await service.close();
		}
	});

	it("retains the first running epoch while waiting for a supplied hint", async () => {
		const { service, observe, getHint, createCursor, setTime } = setup();
		try {
			getHint.mockReturnValueOnce(null as never);
			observe();
			setTime(500);
			observe();
			await service.refresh();
			expect(createCursor).toHaveBeenCalledWith(expect.objectContaining({ since: 100 }));
		} finally {
			await service.close();
		}
	});

	it.each(["completion", "session", "turn", "store", "close"] as const)(
		"fences a pending read after %s changes",
		async (reason) => {
			const { store, service, observe, read, isCurrentStore } = setup();
			let resolve!: (value: ConversationProgressReadResult) => void;
			read.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
			observe();
			if (reason === "completion") store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
			if (reason === "session") store.update("task-1", { resumeSessionId: "replacement" });
			if (reason === "turn") {
				const evidence = store.getSummary("task-1")?.nativeWorkEvidence;
				if (!evidence) throw new Error("Missing work evidence");
				store.update("task-1", { nativeWorkEvidence: { ...evidence, turnId: "turn-2" } });
			}
			if (reason === "store") isCurrentStore.mockReturnValue(false);
			const closing = reason === "close" ? service.close() : null;
			resolve(response("Delayed old message"));
			await (closing ?? service.refresh());
			expect(store.getSummary("task-1")?.progressMessage).toBeFalsy();
			await service.close();
		},
	);

	it("gives each target one chunk per pass even while the first has unread output", async () => {
		const { store, service, observe, createCursor, read } = setup();
		const calls: string[] = [];
		read.mockImplementation(async () => {
			calls.push("first");
			return response("First progress", true);
		});
		const second = vi.fn(async () => {
			calls.push("second");
			return response("Second progress");
		});
		createCursor.mockReturnValueOnce({ read, beginEpoch: vi.fn(), pause: vi.fn() });
		createCursor.mockReturnValueOnce({ read: second, beginEpoch: vi.fn(), pause: vi.fn() });
		const original = store.getSummary("task-1");
		if (!original) throw new Error("Missing test session");
		store.ensureEntry("task-2");
		store.update("task-2", { ...original, taskId: "task-2" });
		try {
			observe();
			observe("task-2");
			await service.refresh();
			await service.refresh();
			expect(calls.slice(-2)).toEqual(["first", "second"]);
			expect(store.getSummary("task-2")?.progressMessage).toBe("Second progress");
		} finally {
			await service.close();
		}
	});

	it("releases a cursor and timer when its store stops being managed", async () => {
		vi.useFakeTimers();
		const { service, observe, cursor, isCurrentStore, read } = setup();
		observe();
		await service.refresh();
		isCurrentStore.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(PROGRESS_PREVIEW_INTERVAL_MS);
		expect(cursor.pause).toHaveBeenCalled();
		const reads = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(reads);
		expect(vi.getTimerCount()).toBe(0);
		await service.close();
	});

	it("bounds active cursor admission even with more than a thousand running tasks", async () => {
		const { store, service, observe, createCursor, read } = setup();
		let resolve!: (value: ConversationProgressReadResult) => void;
		read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const original = store.getSummary("task-1");
		if (!original) throw new Error("Missing test session");
		observe();
		try {
			for (let index = 2; index <= 1100; index += 1) {
				const taskId = `task-${index}`;
				store.ensureEntry(taskId);
				store.update(taskId, { ...original, taskId });
				observe(taskId);
			}
			expect(createCursor).toHaveBeenCalledTimes(128);
		} finally {
			resolve(response());
			await service.close();
		}
	});

	it("discards dormant cursors when their store is no longer current during housekeeping", async () => {
		const { store, service, observe, isCurrentStore, createCursor } = setup();
		try {
			observe();
			await service.refresh();
			const running = store.getSummary("task-1");
			if (!running) throw new Error("Missing test session");
			store.update("task-1", { state: "awaiting_review", nativeWorkEvidence: null });
			observe();
			isCurrentStore.mockReturnValue(false);
			await service.refresh();
			isCurrentStore.mockReturnValue(true);
			store.update("task-1", running);
			observe();
			await service.refresh();
			expect(createCursor).toHaveBeenCalledTimes(2);
		} finally {
			await service.close();
		}
	});

	it("discards a target whose weak store reference is gone before the next pass", async () => {
		const { service, observe, cursor, read } = setup();
		try {
			observe();
			await service.refresh();
			const reads = read.mock.calls.length;
			const deref = vi.spyOn(WeakRef.prototype, "deref").mockReturnValue(undefined);
			try {
				await service.refresh();
				expect(read).toHaveBeenCalledTimes(reads);
				expect(cursor.pause).toHaveBeenCalled();
			} finally {
				deref.mockRestore();
			}
		} finally {
			await service.close();
		}
	});
});
