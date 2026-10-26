import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({ prepareAgentLaunch: prepareAgentLaunchMock }));
vi.mock("../../../src/terminal/pty-session.js", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));

import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createTestTaskOutstandingInteraction } from "../../utilities/task-session-factory";

const BATCH = Buffer.from("\u001b[<64;10;5M".repeat(12));

async function fixture() {
	const session = {
		pid: 111,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	};
	ptySessionSpawnMock.mockReturnValue(session);
	const store = new InMemorySessionSummaryStore();
	const manager = new TerminalSessionManager(store);
	const token = "startup-token";
	manager.beginStartupRecovery("task-1", token);
	const started = await manager.startTaskSessionWithReadiness({
		taskId: "task-1",
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: "/tmp/synthetic-passive-input",
		prompt: "",
		startupRecoveryToken: token,
	});
	store.update("task-1", {
		state: "awaiting_review",
		reviewReason: null,
		outstandingInteraction: createTestTaskOutstandingInteraction({
			provider: "codex",
			kind: "permission",
			sessionInstanceId: started.sessionInstanceId,
		}),
	});
	return { session, store, manager, token, started };
}

describe("TerminalSessionManager passive input", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { binary: string; args: string[] }) => ({
			...input,
			env: {},
		}));
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([
		["SGR", BATCH],
		["X10", Buffer.from("\u001b[M`!!".repeat(12))],
		["mixed encoding", Buffer.concat([BATCH, Buffer.from("\u001b[M`!!\u001b[<35;12;6M")])],
	])(
		"uses one detached post-write summary for a %s passive batch without changing waiting semantics",
		async (_encoding, data) => {
			const { session, store, manager, token, started } = await fixture();
			const before = store.getSummary("task-1");
			const waiting = manager.waitForTaskSessionLaunch("task-1", started.sessionInstanceId ?? "", 1_000);
			const reads = vi.spyOn(store, "getSummary");
			const updates = vi.spyOn(store, "update");
			const summary = manager.writeInput("task-1", data);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(session.write).toHaveBeenCalledExactlyOnceWith(data);
			expect(session.write.mock.calls[0]?.[0]).toBe(data);
			expect(summary).toEqual(before);
			expect(updates).not.toHaveBeenCalled();
			expect(summary?.outstandingInteraction?.status).toBe("waiting");
			expect(manager.isStartupRecoveryCurrent("task-1", token)).toBe(false);
			await expect(waiting).resolves.toMatchObject({ status: "user_engaged" });
			if (!summary?.outstandingInteraction) throw new Error("Missing interaction");
			summary.outstandingInteraction.status = "response_submitted";
			expect(store.getSummary("task-1")?.outstandingInteraction?.status).toBe("waiting");
		},
	);

	it("reads the return snapshot after synchronous PTY write effects", async () => {
		const { session, store, manager } = await fixture();
		session.write.mockImplementation(() => {
			store.update("task-1", { warningMessage: "changed during write" });
		});
		expect(manager.writeInput("task-1", BATCH)?.warningMessage).toBe("changed during write");
	});

	it("keeps mixed input on the full pipeline and forwards every byte", async () => {
		const { session, store, manager } = await fixture();
		const data = Buffer.concat([BATCH, Buffer.from("y\u001b[I\u001b[<64;10;")]);
		const reads = vi.spyOn(store, "getSummary");
		expect(manager.writeInput("task-1", data)?.outstandingInteraction?.status).toBe("waiting");
		expect(reads).toHaveBeenCalledTimes(2);
		expect(session.write).toHaveBeenCalledExactlyOnceWith(data);
	});

	it("retains recovery requirement cleanup after the successful write", async () => {
		const { store, manager } = await fixture();
		store.update("task-1", { startupRecoveryRequired: true });
		const returned = manager.writeInput("task-1", BATCH);
		// Preserve the existing return contract: the snapshot precedes cleanup.
		expect(returned?.startupRecoveryRequired).toBe(true);
		expect(store.getSummary("task-1")?.startupRecoveryRequired).toBe(false);
	});

	it("honors explicit submission intent instead of taking the passive shortcut", async () => {
		const { session, manager } = await fixture();
		expect(
			manager.writeInput("task-1", BATCH, { explicitUserSubmission: true })?.outstandingInteraction?.status,
		).toBe("response_submitted");
		expect(session.write).toHaveBeenCalledExactlyOnceWith(BATCH);
	});

	it("still recognizes a single-byte immediate approval choice", async () => {
		const { manager } = await fixture();
		expect(manager.writeInput("task-1", Buffer.from("y"))?.outstandingInteraction?.status).toBe("response_submitted");
	});

	it.each(["stopping", "failed write"])("does not cancel recovery for a %s passive write", async (kind) => {
		const { session, store, manager, token } = await fixture();
		store.update("task-1", { startupRecoveryRequired: true });
		if (kind === "stopping") session.wasInterrupted.mockReturnValue(true);
		else
			session.write.mockImplementation(() => {
				throw new Error("write failed");
			});
		if (kind === "failed write") expect(() => manager.writeInput("task-1", BATCH)).toThrow("write failed");
		else expect(manager.writeInput("task-1", BATCH)).toBeNull();
		expect(manager.isStartupRecoveryCurrent("task-1", token)).toBe(true);
		expect(store.getSummary("task-1")?.startupRecoveryRequired).toBe(true);
	});
});
