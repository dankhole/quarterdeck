import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({ prepareAgentLaunch: prepareAgentLaunchMock }));
vi.mock("../../../src/terminal/pty-session.js", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));

import {
	normalizeRuntimeTaskSessionSummary,
	type RuntimeHookIngestRequest,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import type { StartTaskSessionRequest } from "../../../src/terminal/session-manager-types";
import { INITIAL_WORK_CONFIRMATION_TIMEOUT_MS } from "../../../src/terminal/session-transition-controller";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null }) => void;
}

const request: StartTaskSessionRequest = {
	taskId: "initial-start",
	agentId: "codex",
	binary: "codex",
	args: [],
	cwd: "/tmp/initial-start",
	prompt: "Do the task",
};

function setup() {
	const sessions: Array<{ triggerExit: (exitCode: number) => void }> = [];
	ptySessionSpawnMock.mockImplementation((spawn: MockSpawnRequest) => {
		const session = {
			pid: 111 + sessions.length,
			write: vi.fn(),
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
			wasInterrupted: () => false,
			triggerExit: (exitCode: number) => spawn.onExit?.({ exitCode }),
		};
		sessions.push(session);
		return session;
	});
	return { manager: new TerminalSessionManager(new InMemorySessionSummaryStore()), sessions };
}

function hook(manager: TerminalSessionManager, event: RuntimeHookIngestRequest["event"], hookEventName: string) {
	return manager.applyProviderHook(request.taskId, {
		taskId: request.taskId,
		projectId: "project",
		event,
		metadata: {
			source: "codex",
			hookEventName,
			sessionInstanceId: manager.store.getSummary(request.taskId)?.sessionInstanceId,
			sessionId: "parent-session",
			turnId: "turn-1",
		},
	});
}

const summary = (manager: TerminalSessionManager) => manager.store.getSummary(request.taskId);

describe("initial task work confirmation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { binary: string; args: string[] }) => ({
			binary: input.binary,
			args: input.args,
			env: {},
		}));
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("starts Running without inventing native work evidence", async () => {
		const { manager } = setup();
		expect(await manager.startTaskSession(request)).toMatchObject({
			state: "running",
			reviewReason: null,
			nativeWorkEvidence: null,
		});
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS - 1);
		expect(summary(manager)?.state).toBe("running");
		await vi.advanceTimersByTimeAsync(1);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "unconfirmed" });
	});

	it("does not let metadata-only SessionStart prevent the confirmation deadline", async () => {
		const { manager } = setup();
		await manager.startTaskSession(request);
		hook(manager, "activity", "SessionStart");
		expect(summary(manager)).toMatchObject({
			state: "running",
			resumeSessionId: "parent-session",
			nativeWorkEvidence: null,
		});
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS);
		expect(summary(manager)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "unconfirmed",
			nativeWorkEvidence: null,
		});
	});

	it.each(["UserPromptSubmit", "PreToolUse"])(
		"keeps confirmed %s work Running beyond the initial deadline",
		async (name) => {
			const { manager } = setup();
			await manager.startTaskSession(request);
			hook(manager, name === "UserPromptSubmit" ? "to_in_progress" : "activity", name);
			expect(summary(manager)?.nativeWorkEvidence).not.toBeNull();
			expect(summary(manager)?.initialWorkConfirmation).toBeNull();
			await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS * 2);
			expect(summary(manager)).toMatchObject({ state: "running", reviewReason: null });
		},
	);

	it("accepts immediate completion and preserves its review reason beyond the deadline", async () => {
		const { manager } = setup();
		await manager.startTaskSession(request);
		hook(manager, "to_review", "Stop");
		expect(summary(manager)?.initialWorkConfirmation).toBeNull();
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
	});

	it.each([{ awaitReview: true }, { resumeConversation: true, resumeSessionId: "existing" }])(
		"preserves conservative starts with %j",
		async (options) => {
			const { manager } = setup();
			await manager.startTaskSession({ ...request, ...options });
			const initial = summary(manager);
			expect(initial?.state).toBe("awaiting_review");
			await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS);
			expect(summary(manager)).toEqual(initial);
		},
	);

	it("cannot apply an old launch deadline to its replacement", async () => {
		const { manager, sessions } = setup();
		const first = await manager.startTaskSession(request);
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS / 2);
		sessions[0]?.triggerExit(0);
		const next = await manager.startTaskSession(request);
		expect(next.sessionInstanceId).not.toBe(first.sessionInstanceId);
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS / 2);
		expect(summary(manager)?.state).toBe("running");
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS / 2);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "unconfirmed" });
	});

	it("does not automatically restart an unconfirmed launch even after receiving its session identity", async () => {
		const { manager, sessions } = setup();
		await manager.startTaskSession(request);
		manager.attach(request.taskId, { onState: vi.fn() });
		hook(manager, "activity", "SessionStart");
		sessions[0]?.triggerExit(0);
		manager.recoverStaleSession(request.taskId);
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "error", pid: null });
	});

	it("keeps a launch that exits after its confirmation deadline failed until an explicit start", async () => {
		const { manager, sessions } = setup();
		await manager.startTaskSession(request);
		manager.attach(request.taskId, { onState: vi.fn() });
		hook(manager, "activity", "SessionStart");
		await vi.advanceTimersByTimeAsync(INITIAL_WORK_CONFIRMATION_TIMEOUT_MS);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "unconfirmed" });
		sessions[0]?.triggerExit(0);
		manager.recoverStaleSession(request.taskId);
		await vi.advanceTimersByTimeAsync(1);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(summary(manager)).toMatchObject({ state: "awaiting_review", reviewReason: "error", pid: null });

		await manager.startTaskSession(request);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(summary(manager)).toMatchObject({ state: "running", reviewReason: null });
	});
});

describe("initial work confirmation normalization", () => {
	function pending() {
		return createTestTaskSessionSummary({
			state: "running",
			reviewReason: null,
			agentId: "codex",
			sessionInstanceId: "launch-1",
			pid: 111,
			nativeWorkEvidence: null,
			initialWorkConfirmation: { sessionInstanceId: "launch-1", deadlineAt: 45_000 },
		});
	}

	it("roundtrips a matching initial launch marker without claiming native work", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(pending())));
		expect(normalizeRuntimeTaskSessionSummary(parsed)).toMatchObject({
			state: "running",
			nativeWorkEvidence: null,
			initialWorkConfirmation: { sessionInstanceId: "launch-1", deadlineAt: 45_000 },
		});
	});

	it("rejects an initial marker belonging to another launch", () => {
		expect(normalizeRuntimeTaskSessionSummary({ ...pending(), sessionInstanceId: "launch-2" })).toMatchObject({
			state: "awaiting_review",
			reviewReason: "unconfirmed",
			initialWorkConfirmation: null,
		});
	});

	it("invalidates optimistic Running during cold hydration", () => {
		expect(normalizeRuntimeTaskSessionSummary(pending(), { invalidateNativeWorkEvidence: true })).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			initialWorkConfirmation: null,
			pid: null,
		});
	});
});
