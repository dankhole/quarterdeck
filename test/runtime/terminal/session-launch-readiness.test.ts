import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createTaskSessionLaunchMonitor,
	markTaskSessionLaunchCancelled,
	markTaskSessionLaunchExited,
	markTaskSessionLaunchReady,
	markTaskSessionLaunchSuperseded,
	markTaskSessionLaunchUserEngaged,
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

	it("retains exact identity admission after input cancels recovery ownership", async () => {
		const monitor = createTaskSessionLaunchMonitor({
			sessionInstanceId: "launch-1",
			expectedSessionId: "expected-session",
		});
		const waiting = waitForTaskSessionLaunchReadiness(monitor, 1_000);

		markTaskSessionLaunchUserEngaged(monitor);
		await expect(waiting).resolves.toMatchObject({ status: "user_engaged" });
		markTaskSessionLaunchReady(monitor, { sessionInstanceId: "launch-1" });
		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "old-launch",
			sessionId: "different-session",
		});
		expect(monitor.identityOutcome).toBeNull();

		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "different-session",
		});
		expect(monitor.identityOutcome).toEqual({
			status: "identity_mismatch",
			sessionInstanceId: "launch-1",
			expectedSessionId: "expected-session",
			observedSessionId: "different-session",
		});
		// A later matching hook cannot rehabilitate the rejected process.
		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "expected-session",
		});
		expect(monitor.identityOutcome?.status).toBe("identity_mismatch");
		expect(monitor.outcome?.status).toBe("user_engaged");
	});

	it.each([false, true])("allows navigation after exact identity confirmation (input first: %s)", (inputFirst) => {
		const monitor = createTaskSessionLaunchMonitor({
			sessionInstanceId: "launch-1",
			expectedSessionId: "expected-session",
		});
		if (inputFirst) markTaskSessionLaunchUserEngaged(monitor);
		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "expected-session",
		});
		markTaskSessionLaunchReady(monitor, {
			sessionInstanceId: "launch-1",
			sessionId: "navigated-session",
		});
		expect(monitor.identityOutcome).toEqual({
			status: "ready",
			sessionInstanceId: "launch-1",
			observedSessionId: "expected-session",
		});
		expect(monitor.outcome?.status).toBe(inputFirst ? "user_engaged" : "ready");
	});

	it("leaves non-targeted input cancellation unchanged", () => {
		const monitor = createTaskSessionLaunchMonitor({ sessionInstanceId: "launch-1" });
		markTaskSessionLaunchUserEngaged(monitor);
		markTaskSessionLaunchReady(monitor, { sessionInstanceId: "launch-1", sessionId: "any-session" });
		expect(monitor.outcome?.status).toBe("user_engaged");
		expect(monitor.identityOutcome).toBeNull();
	});

	describe.each(["cancelled", "superseded", "exited"] as const)("%s identity retirement", (reason) => {
		it.each(["pending", "user_engaged", "ready", "identity_mismatch"] as const)(
			"retires admission independently of a %s recovery outcome",
			async (initialOutcome) => {
				const monitor = createTaskSessionLaunchMonitor({
					sessionInstanceId: "launch-1",
					expectedSessionId: "expected-session",
				});
				const waiting = waitForTaskSessionLaunchReadiness(monitor, 1_000);
				if (initialOutcome === "user_engaged") markTaskSessionLaunchUserEngaged(monitor);
				if (initialOutcome === "ready" || initialOutcome === "identity_mismatch") {
					markTaskSessionLaunchReady(monitor, {
						sessionInstanceId: "launch-1",
						sessionId: initialOutcome === "ready" ? "expected-session" : "different-session",
					});
				}
				const identityBeforeRetirement = monitor.identityOutcome;

				if (reason === "cancelled") markTaskSessionLaunchCancelled(monitor);
				else if (reason === "superseded") markTaskSessionLaunchSuperseded(monitor);
				else markTaskSessionLaunchExited(monitor, 0);

				await expect(waiting).resolves.toMatchObject({
					status: initialOutcome === "pending" ? reason : initialOutcome,
				});
				expect(monitor.identityAdmissionRetired).toBe(true);
				markTaskSessionLaunchReady(monitor, { sessionInstanceId: "launch-1", sessionId: "different-session" });
				markTaskSessionLaunchUserEngaged(monitor);
				markTaskSessionLaunchReady(monitor, { sessionInstanceId: "launch-1", sessionId: "expected-session" });
				expect(monitor.identityOutcome).toBe(identityBeforeRetirement);
				expect(monitor.identityAdmissionRetired).toBe(true);
				expect(monitor.outcome?.status).toBe(initialOutcome === "pending" ? reason : initialOutcome);
			},
		);
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
