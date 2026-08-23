import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createTaskSessionLaunchMonitor,
	markTaskSessionLaunchCancelled,
	markTaskSessionLaunchReady,
	waitForTaskSessionLaunchReadiness,
} from "../../../src/terminal/session-launch-readiness";

afterEach(() => {
	vi.useRealTimers();
});

describe("task session launch readiness", () => {
	it("ignores hooks from an older PTY instance", async () => {
		vi.useFakeTimers();
		const monitor = createTaskSessionLaunchMonitor({ sessionInstanceId: "current-launch" });
		const waiting = waitForTaskSessionLaunchReadiness(monitor, 100);

		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "old-launch",
			sessionId: "session-1",
		});
		await vi.advanceTimersByTimeAsync(100);

		await expect(waiting).resolves.toEqual({
			status: "timeout",
			sessionInstanceId: "current-launch",
		});
	});

	it("requires the expected resumed conversation identity", async () => {
		vi.useFakeTimers();
		const monitor = createTaskSessionLaunchMonitor({
			sessionInstanceId: "launch-1",
			expectedSessionId: "expected-session",
		});
		const waiting = waitForTaskSessionLaunchReadiness(monitor, 100);

		markTaskSessionLaunchReady(monitor, { sessionInstanceId: "launch-1" });
		await vi.advanceTimersByTimeAsync(50);
		expect(monitor.outcome).toBeNull();

		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "different-session",
		});
		await expect(waiting).resolves.toEqual({
			status: "identity_mismatch",
			sessionInstanceId: "launch-1",
			expectedSessionId: "expected-session",
			observedSessionId: "different-session",
		});
	});

	it("confirms readiness from a matching launch and session", async () => {
		const monitor = createTaskSessionLaunchMonitor({
			sessionInstanceId: "launch-1",
			expectedSessionId: "session-1",
		});
		const waiting = waitForTaskSessionLaunchReadiness(monitor, 1_000);

		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "session-1",
		});

		await expect(waiting).resolves.toEqual({
			status: "ready",
			sessionInstanceId: "launch-1",
			observedSessionId: "session-1",
		});
	});

	it("settles a waiter when an explicit action cancels recovery", async () => {
		const monitor = createTaskSessionLaunchMonitor({ sessionInstanceId: "launch-1" });
		const waiting = waitForTaskSessionLaunchReadiness(monitor, 1_000);

		markTaskSessionLaunchCancelled(monitor);

		await expect(waiting).resolves.toEqual({
			status: "cancelled",
			sessionInstanceId: "launch-1",
		});
	});
});
