import { afterEach, describe, expect, it, vi } from "vitest";

import {
	STARTUP_RECOVERY_FIRST_READINESS_TIMEOUT_MS,
	type StartupSessionRecoveryCandidate,
	StartupSessionRecoveryCoordinator,
} from "../../../src/server/startup-session-recovery";
import type {
	PreparedTaskSessionStart,
	TaskSessionStartServiceResult,
} from "../../../src/server/task-session-start-service";
import {
	InMemorySessionSummaryStore,
	type SessionSummaryStore,
	type TerminalSessionManager,
} from "../../../src/terminal";
import type { TaskSessionLaunchReadinessOutcome } from "../../../src/terminal/session-launch-readiness";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

interface ManagerHarness {
	manager: TerminalSessionManager;
	store: SessionSummaryStore;
	beginStartupRecovery: ReturnType<typeof vi.fn>;
	isStartupRecoveryCurrent: ReturnType<typeof vi.fn>;
	isTaskSessionLaunchActive: ReturnType<typeof vi.fn>;
	completeStartupRecovery: ReturnType<typeof vi.fn>;
	finalizeStartupRecoveryFailure: ReturnType<typeof vi.fn>;
	waitForTaskSessionLaunch: ReturnType<typeof vi.fn>;
	stopTaskSessionForStartupRecovery: ReturnType<typeof vi.fn>;
	cancel: () => void;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

function readinessOutcome(
	status: "ready" | "timeout" | "exited" | "identity_mismatch",
	sessionInstanceId: string,
): TaskSessionLaunchReadinessOutcome {
	switch (status) {
		case "ready":
			return { status, sessionInstanceId, observedSessionId: "resume-session-1" };
		case "exited":
			return { status, sessionInstanceId, exitCode: 1 };
		case "identity_mismatch":
			return {
				status,
				sessionInstanceId,
				expectedSessionId: "resume-session-1",
				observedSessionId: "wrong-session",
			};
		case "timeout":
			return { status, sessionInstanceId };
	}
}

function createManagerHarness(
	outcomes: Array<"ready" | "timeout" | "exited" | "identity_mismatch">,
	stopResults: Array<"stopped" | "inactive" | "superseded" | "timeout"> = ["stopped"],
	activeResults: boolean[] = [true, true],
): ManagerHarness {
	const store = new InMemorySessionSummaryStore();
	store.hydrateFromRecord({
		"task-1": createTestTaskSessionSummary({
			taskId: "task-1",
			state: "interrupted",
			reviewReason: "interrupted",
			agentId: "codex",
			resumeSessionId: "resume-session-1",
		}),
	});
	let token: string | null = null;
	const beginStartupRecovery = vi.fn((_taskId: string, nextToken: string) => {
		if (token && token !== nextToken) {
			return false;
		}
		token = nextToken;
		return true;
	});
	const isStartupRecoveryCurrent = vi.fn((_taskId: string, expectedToken: string) => token === expectedToken);
	const isTaskSessionLaunchActive = vi.fn(() => activeResults.shift() ?? true);
	const completeStartupRecovery = vi.fn((_taskId: string, expectedToken: string) => {
		if (token === expectedToken) {
			token = null;
		}
	});
	const finalizeStartupRecoveryFailure = vi.fn(
		(
			taskId: string,
			expectedToken: string,
			options: {
				processStillRunning: boolean;
				clearResumeSessionId: boolean;
				warningMessage: string;
			},
		) => {
			if (token !== expectedToken) {
				return null;
			}
			return store.update(taskId, {
				...(options.processStillRunning
					? {}
					: { state: "awaiting_review" as const, reviewReason: "interrupted" as const, pid: null }),
				...(options.clearResumeSessionId ? { resumeSessionId: null } : {}),
				warningMessage: options.warningMessage,
			});
		},
	);
	const waitForTaskSessionLaunch = vi.fn(
		async (_taskId: string, sessionInstanceId: string): Promise<TaskSessionLaunchReadinessOutcome> => {
			const status = outcomes.shift() ?? "ready";
			return readinessOutcome(status, sessionInstanceId);
		},
	);
	const stopTaskSessionForStartupRecovery = vi.fn(async () => stopResults.shift() ?? "stopped");
	const manager = {
		store,
		beginStartupRecovery,
		isStartupRecoveryCurrent,
		isTaskSessionLaunchActive,
		completeStartupRecovery,
		finalizeStartupRecoveryFailure,
		waitForTaskSessionLaunch,
		stopTaskSessionForStartupRecovery,
	} as unknown as TerminalSessionManager;
	return {
		manager,
		store,
		beginStartupRecovery,
		isStartupRecoveryCurrent,
		isTaskSessionLaunchActive,
		completeStartupRecovery,
		finalizeStartupRecoveryFailure,
		waitForTaskSessionLaunch,
		stopTaskSessionForStartupRecovery,
		cancel: () => {
			token = null;
		},
	};
}

function createCandidate(harness: ManagerHarness, taskId = "task-1"): StartupSessionRecoveryCandidate {
	return {
		scope: { projectId: "project-1", projectPath: "/tmp/project-1" },
		manager: harness.manager,
		originalResumeSessionId: "resume-session-1",
		request: {
			taskId,
			prompt: "",
			baseRef: "main",
			resumeConversation: true,
			awaitReview: true,
			useWorktree: true,
		},
	};
}

function createPrepared(
	candidate: StartupSessionRecoveryCandidate,
	startupRecoveryToken = "recovery-token",
): PreparedTaskSessionStart {
	return {
		terminalManager: candidate.manager,
		request: {
			taskId: candidate.request.taskId,
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/project-1-worktree",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: candidate.originalResumeSessionId ?? undefined,
			awaitReview: true,
			startupRecoveryToken,
		},
		taskCwd: "/tmp/project-1-worktree",
		llmSummaryPolishEnabled: false,
		resumeContextWarning: null,
		resumeSessionWarning: null,
	};
}

function createStartedResult(
	prepared: PreparedTaskSessionStart,
	sessionInstanceId: string,
): TaskSessionStartServiceResult {
	const summary =
		prepared.terminalManager.store.update(prepared.request.taskId, {
			state: "running",
			reviewReason: null,
			pid: Number(sessionInstanceId.replace(/\D/g, "")) || 1,
		}) ?? prepared.terminalManager.store.ensureEntry(prepared.request.taskId);
	return {
		summary,
		terminalManager: prepared.terminalManager,
		taskCwd: prepared.taskCwd,
		sessionInstanceId,
		startedNewSession: true,
		llmSummaryPolishEnabled: false,
	};
}

function createCoordinator(
	launch: (prepared: PreparedTaskSessionStart) => Promise<TaskSessionStartServiceResult>,
	options: {
		waitForPrerequisite?: () => Promise<void>;
		prepare?: (
			candidate: StartupSessionRecoveryCandidate,
			options: { startupRecoveryToken: string; resumeSessionIdOverride: string | null },
		) => Promise<PreparedTaskSessionStart>;
	} = {},
): StartupSessionRecoveryCoordinator {
	return new StartupSessionRecoveryCoordinator({
		waitForPrerequisite: options.waitForPrerequisite,
		prepare:
			options.prepare ??
			(async (candidate, prepareOptions) => createPrepared(candidate, prepareOptions.startupRecoveryToken)),
		launch,
		firstReadinessTimeoutMs: 1,
		retryReadinessTimeoutMs: 1,
		stabilityMs: 0,
		retryDelayMs: 0,
		launchSpacingMs: 0,
		stopTimeoutMs: 1,
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("StartupSessionRecoveryCoordinator", () => {
	it("waits for startup cleanup and serializes task launches", async () => {
		const prerequisite = createDeferred();
		const first = createManagerHarness(["ready"]);
		const second = createManagerHarness(["ready"]);
		second.store.hydrateFromRecord({
			"task-2": createTestTaskSessionSummary({
				taskId: "task-2",
				state: "interrupted",
				reviewReason: "interrupted",
			}),
		});
		const starts: string[] = [];
		const coordinator = createCoordinator(
			async (candidate) => {
				starts.push(candidate.request.taskId);
				return createStartedResult(candidate, `launch-${starts.length}`);
			},
			{ waitForPrerequisite: async () => await prerequisite.promise },
		);

		const firstRecovery = coordinator.enqueue(createCandidate(first));
		const secondRecovery = coordinator.enqueue(createCandidate(second, "task-2"));
		await Promise.resolve();
		expect(starts).toEqual([]);

		prerequisite.resolve();
		await expect(firstRecovery).resolves.toMatchObject({ status: "ready", attempts: 1 });
		await expect(secondRecovery).resolves.toMatchObject({ status: "ready", attempts: 1 });
		expect(starts).toEqual(["task-1", "task-2"]);
	});

	it("attempts each task at most once per terminal-manager lifetime", async () => {
		const harness = createManagerHarness(["ready"]);
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => createStartedResult(prepared, "launch-1"));
		const coordinator = createCoordinator(launchTask);
		const candidate = createCandidate(harness);

		await expect(coordinator.enqueue(candidate)).resolves.toMatchObject({ status: "ready" });
		await expect(coordinator.enqueue(candidate)).resolves.toEqual({
			status: "duplicate",
			attempts: 0,
			taskId: "task-1",
		});
		expect(launchTask).toHaveBeenCalledTimes(1);
	});

	it("retries the same resume target exactly once after a readiness timeout", async () => {
		const harness = createManagerHarness(["timeout", "ready"]);
		let launch = 0;
		const prepare = vi.fn(
			async (
				candidate: StartupSessionRecoveryCandidate,
				options: { startupRecoveryToken: string; resumeSessionIdOverride: string | null },
			) => {
				expect(options.resumeSessionIdOverride).toBe("resume-session-1");
				return createPrepared(candidate, options.startupRecoveryToken);
			},
		);
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => {
			launch += 1;
			return createStartedResult(prepared, `launch-${launch}`);
		});
		const coordinator = createCoordinator(launchTask, { prepare });

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "ready",
			attempts: 2,
			taskId: "task-1",
		});
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(launchTask).toHaveBeenCalledTimes(2);
		expect(launchTask.mock.calls[0]?.[0]).toBe(launchTask.mock.calls[1]?.[0]);
		expect(harness.stopTaskSessionForStartupRecovery).toHaveBeenCalledTimes(1);
		expect(harness.stopTaskSessionForStartupRecovery).toHaveBeenCalledWith(
			"task-1",
			"launch-1",
			expect.any(String),
			1,
		);
	});

	it("prepares once and does not retry deterministic setup failures", async () => {
		const harness = createManagerHarness([]);
		const prepare = vi.fn(async (): Promise<PreparedTaskSessionStart> => {
			throw new Error("worktree could not be recreated");
		});
		const launchTask = vi.fn(async (): Promise<TaskSessionStartServiceResult> => {
			throw new Error("launch should not run");
		});
		const coordinator = createCoordinator(launchTask, { prepare });

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "exhausted",
			attempts: 0,
			taskId: "task-1",
			reason: "preparation_failed",
		});
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(launchTask).not.toHaveBeenCalled();
		expect(harness.store.getSummary("task-1")?.warningMessage).toContain("worktree could not be recreated");
	});

	it("allows a slow first startup to become ready without restarting it", async () => {
		vi.useFakeTimers();
		const harness = createManagerHarness([]);
		harness.waitForTaskSessionLaunch.mockImplementation(
			async (_taskId: string, sessionInstanceId: string, timeoutMs: number) => {
				expect(timeoutMs).toBe(STARTUP_RECOVERY_FIRST_READINESS_TIMEOUT_MS);
				await new Promise((resolve) => setTimeout(resolve, 20_000));
				return readinessOutcome("ready", sessionInstanceId);
			},
		);
		const prepare = vi.fn(
			async (candidate: StartupSessionRecoveryCandidate, options: { startupRecoveryToken: string }) =>
				createPrepared(candidate, options.startupRecoveryToken),
		);
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => createStartedResult(prepared, "launch-1"));
		const coordinator = new StartupSessionRecoveryCoordinator({
			prepare,
			launch: launchTask,
			stabilityMs: 0,
			retryDelayMs: 0,
			launchSpacingMs: 0,
			stopTimeoutMs: 1,
		});

		const recovery = coordinator.enqueue(createCandidate(harness));
		await vi.advanceTimersByTimeAsync(0);
		expect(launchTask).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(20_000);
		await expect(recovery).resolves.toMatchObject({ status: "ready", attempts: 1 });
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(launchTask).toHaveBeenCalledTimes(1);
		expect(harness.stopTaskSessionForStartupRecovery).not.toHaveBeenCalled();
	});

	it("retries when a hook arrives but the PTY exits during readiness stabilization", async () => {
		const harness = createManagerHarness(["ready", "ready"], ["stopped"], [false, true]);
		let launch = 0;
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => {
			launch += 1;
			return createStartedResult(prepared, `launch-${launch}`);
		});
		const coordinator = createCoordinator(launchTask);

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "ready",
			attempts: 2,
			taskId: "task-1",
		});
		expect(launchTask).toHaveBeenCalledTimes(2);
		expect(harness.stopTaskSessionForStartupRecovery).not.toHaveBeenCalled();
	});

	it("leaves the second unconfirmed process running instead of looping", async () => {
		const harness = createManagerHarness(["timeout", "timeout"]);
		let launch = 0;
		const coordinator = createCoordinator(async (candidate) => {
			launch += 1;
			return createStartedResult(candidate, `launch-${launch}`);
		});

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "exhausted",
			attempts: 2,
			taskId: "task-1",
			reason: "timeout",
		});
		expect(harness.stopTaskSessionForStartupRecovery).toHaveBeenCalledTimes(1);
		const summary = harness.store.getSummary("task-1");
		expect(summary?.state).toBe("running");
		expect(summary?.pid).toBe(2);
		expect(summary?.warningMessage).toContain("left running to avoid a restart loop");
	});

	it("clears a stored target only after the bounded targeted resume exits non-zero", async () => {
		const harness = createManagerHarness(["exited", "exited"], ["stopped"], [false]);
		let launch = 0;
		const coordinator = createCoordinator(async (candidate) => {
			launch += 1;
			return createStartedResult(candidate, `launch-${launch}`);
		});

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toMatchObject({
			status: "exhausted",
			attempts: 2,
			reason: "exited",
		});
		expect(harness.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			resumeSessionId: null,
			warningMessage: expect.stringContaining("best-effort resume path"),
		});
	});

	it("does not launch another process when the failed PTY cannot stop safely", async () => {
		const harness = createManagerHarness(["timeout"], ["timeout"]);
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => createStartedResult(prepared, "launch-1"));
		const coordinator = createCoordinator(launchTask);

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "exhausted",
			attempts: 1,
			taskId: "task-1",
			reason: "stop_timeout",
		});
		expect(launchTask).toHaveBeenCalledTimes(1);
		expect(harness.store.getSummary("task-1")?.warningMessage).toContain("did not start another copy");
	});

	it("cancels a queued recovery when an explicit action clears its token", async () => {
		const prerequisite = createDeferred();
		const harness = createManagerHarness(["ready"]);
		const launchTask = vi.fn(async (prepared: PreparedTaskSessionStart) => createStartedResult(prepared, "launch-1"));
		const coordinator = createCoordinator(launchTask, {
			waitForPrerequisite: async () => await prerequisite.promise,
		});

		const recovery = coordinator.enqueue(createCandidate(harness));
		harness.cancel();
		prerequisite.resolve();

		await expect(recovery).resolves.toEqual({ status: "cancelled", attempts: 0, taskId: "task-1" });
		expect(launchTask).not.toHaveBeenCalled();
	});

	it("caps launch failures at two attempts and surfaces a manual recovery warning", async () => {
		const harness = createManagerHarness([]);
		harness.store.update("task-1", {
			state: "awaiting_review",
			reviewReason: "attention",
			pid: 9_999,
		});
		const launchTask = vi.fn(async (): Promise<TaskSessionStartServiceResult> => {
			throw new Error("spawn failed");
		});
		const coordinator = createCoordinator(launchTask);

		await expect(coordinator.enqueue(createCandidate(harness))).resolves.toEqual({
			status: "exhausted",
			attempts: 2,
			taskId: "task-1",
			reason: "launch_failed",
		});
		expect(launchTask).toHaveBeenCalledTimes(2);
		expect(harness.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			warningMessage: expect.stringContaining("Use Restart"),
		});
	});
});
