import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>());
vi.mock("node:fs/promises", () => ({ access: accessMock }));

import type { PtySession } from "../../../src/terminal/pty-session";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import {
	createReconciliationTimer,
	type ReconciliationSweepContext,
	reconcileSessionStates,
} from "../../../src/terminal/session-reconciliation-sweep";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { createTestTaskHookActivity, createTestTaskOutstandingInteraction } from "../../utilities/task-session-factory";

function createActive(sessionInstanceId: string, pid = process.pid) {
	return createActiveProcessState({
		session: { pid, stop: vi.fn() } as unknown as PtySession,
		sessionInstanceId,
		agentId: "claude",
		cols: 80,
		rows: 24,
		willAutoTrust: false,
	});
}

function createContext() {
	const store = new InMemorySessionSummaryStore();
	const entry = createProcessEntry("task-1");
	entry.active = createActive("launch-1");
	store.ensureEntry(entry.taskId);
	store.update(entry.taskId, {
		state: "awaiting_review",
		reviewReason: "hook",
		pid: process.pid,
		sessionLaunchPath: "/launch",
	});
	const ctx: ReconciliationSweepContext = {
		entries: new Map([[entry.taskId, entry]]),
		store,
		applyTransitionEvent: vi.fn((current, event) => store.applySessionEvent(current.taskId, event)),
		recoverMissingLaunchPath: vi.fn(() => null),
	};
	return { ctx, entry, store };
}

let rejectAccess: (error: Error) => void;

describe("async session reconciliation sweep", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		accessMock.mockReset();
		accessMock.mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectAccess = reject;
				}),
		);
	});

	afterEach(async () => {
		await vi.advanceTimersByTimeAsync(2_000);
		rejectAccess?.(new Error("cleanup"));
		await vi.advanceTimersByTimeAsync(0);
		vi.useRealTimers();
	});

	it("a hung path deadline still recovers a dead process and retains the actual I/O slot", async () => {
		const { ctx, entry, store } = createContext();
		store.update(entry.taskId, { pid: 999_999_999 });
		const alive = createProcessEntry("task-2");
		alive.active = createActive("alive");
		ctx.entries.set(alive.taskId, alive);
		store.ensureEntry(alive.taskId);
		store.update(alive.taskId, {
			state: "awaiting_review",
			reviewReason: "hook",
			pid: process.pid,
			sessionLaunchPath: "/launch",
		});
		const sweep = reconcileSessionStates(ctx);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(ctx.applyTransitionEvent).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await sweep;
		expect(ctx.applyTransitionEvent).toHaveBeenCalledWith(entry, {
			type: "process.exit",
			exitCode: null,
			interrupted: false,
		});
		expect(entry.active).toBeNull();
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();

		await reconcileSessionStates(ctx);
		expect(accessMock).toHaveBeenCalledTimes(1);
		expect(alive.active).not.toBeNull();
	});

	it("a new PTY at the same path never receives an old timed-out access failure", async () => {
		const { ctx, entry } = createContext();
		const oldSweep = reconcileSessionStates(ctx);
		await vi.advanceTimersByTimeAsync(2_000);
		await oldSweep;
		entry.active = createActive("replacement");
		const replacement = entry.active;
		const newSweep = reconcileSessionStates(ctx);
		rejectAccess(new Error("old missing path"));
		await newSweep;
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
		expect(entry.active).toBe(replacement);
		expect(accessMock).toHaveBeenCalledTimes(1);

		accessMock.mockRejectedValueOnce(new Error("current missing path"));
		await reconcileSessionStates(ctx);
		expect(ctx.recoverMissingLaunchPath).toHaveBeenCalledTimes(1);
		expect(accessMock).toHaveBeenCalledTimes(2);
	});

	it("does not reuse a result for a replacement entry even if its PTY identity is retained", async () => {
		const { ctx, entry } = createContext();
		const sweep = reconcileSessionStates(ctx);
		ctx.entries.set(entry.taskId, { ...entry });
		rejectAccess(new Error("missing"));
		await sweep;
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
	});

	it("evaluates a live replacement entry rather than a captured dead entry", async () => {
		const { ctx, entry, store } = createContext();
		entry.active = createActive("dead-launch", 999_999_999);
		const oldCleanup = vi.fn(async () => {});
		entry.active.onSessionCleanup = oldCleanup;
		store.update(entry.taskId, { pid: 999_999_999 });
		const sweep = reconcileSessionStates(ctx);

		const replacement = createProcessEntry(entry.taskId);
		replacement.active = createActive("live-replacement");
		const replacementCleanup = vi.fn(async () => {});
		replacement.active.onSessionCleanup = replacementCleanup;
		ctx.entries.set(entry.taskId, replacement);
		store.update(entry.taskId, { pid: process.pid });
		const currentSummary = store.getSummary(entry.taskId);
		rejectAccess(new Error("old launch path missing"));
		await sweep;

		expect(ctx.applyTransitionEvent).not.toHaveBeenCalled();
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
		expect(oldCleanup).not.toHaveBeenCalled();
		expect(replacementCleanup).not.toHaveBeenCalled();
		expect(replacement.active?.session.stop).not.toHaveBeenCalled();
		expect(store.getSummary(entry.taskId)).toEqual(currentSummary);
	});

	it("does not apply processless recovery from an exited old entry to a live replacement", async () => {
		const { ctx, entry, store } = createContext();
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: entry.taskId,
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/launch",
				prompt: "test",
			},
		};
		const sweep = reconcileSessionStates(ctx);
		const replacement = createProcessEntry(entry.taskId);
		replacement.active = createActive("replacement");
		ctx.entries.set(entry.taskId, replacement);
		entry.active = null;
		store.update(entry.taskId, {
			outstandingInteraction: createTestTaskOutstandingInteraction({ sessionInstanceId: "replacement" }),
		});
		rejectAccess(new Error("old missing path"));
		await sweep;
		expect(ctx.applyTransitionEvent).not.toHaveBeenCalled();
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
		expect(replacement.active).not.toBeNull();
	});

	it("stopping the sweep during await suppresses every action and cleanup", async () => {
		const { ctx, entry, store } = createContext();
		store.update(entry.taskId, {
			pid: 999_999_999,
			latestHookActivity: createTestTaskHookActivity({ hookEventName: "PermissionRequest" }),
		});
		if (!entry.active) throw new Error("Expected active launch");
		const cleanup = vi.fn(async () => {});
		entry.active.onSessionCleanup = cleanup;
		const update = vi.spyOn(store, "update");
		const timer = createReconciliationTimer(ctx);
		timer.start();
		await vi.advanceTimersByTimeAsync(10_000);
		timer.stop();
		rejectAccess(new Error("missing after stop"));
		await vi.advanceTimersByTimeAsync(0);

		expect(ctx.applyTransitionEvent).not.toHaveBeenCalled();
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
		expect(entry.active.session.stop).not.toHaveBeenCalled();
	});

	it("uses current summary checks even when the captured path became stale", async () => {
		const { ctx, entry, store } = createContext();
		const sweep = reconcileSessionStates(ctx);
		store.update(entry.taskId, {
			sessionLaunchPath: "/replacement",
			reviewReason: "interrupted",
			latestHookActivity: createTestTaskHookActivity({ hookEventName: "PermissionRequest" }),
		});
		rejectAccess(new Error("old path missing"));
		await sweep;
		expect(ctx.recoverMissingLaunchPath).not.toHaveBeenCalled();
		expect(store.getSummary(entry.taskId)?.latestHookActivity).toBeNull();
	});

	it("an exception reading one entry during capture does not block another entry", async () => {
		const { ctx, entry, store } = createContext();
		const broken = createProcessEntry("broken");
		ctx.entries = new Map([
			[broken.taskId, broken],
			[entry.taskId, entry],
		]);
		const getSummary = store.getSummary.bind(store);
		vi.spyOn(store, "getSummary").mockImplementation((taskId) => {
			if (taskId === "broken") throw new Error("bad summary");
			return getSummary(taskId);
		});
		accessMock.mockRejectedValueOnce(new Error("missing"));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await reconcileSessionStates(ctx);
			expect(ctx.recoverMissingLaunchPath).toHaveBeenCalledWith(entry, expect.any(String));
			expect(errorLog).toHaveBeenCalledExactlyOnceWith(expect.any(String), "Reconciliation error for broken", {
				error: "bad summary",
			});
		} finally {
			errorLog.mockRestore();
		}
	});
});
