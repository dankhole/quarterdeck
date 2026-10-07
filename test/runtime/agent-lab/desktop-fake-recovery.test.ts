import { describe, expect, it } from "vitest";

import {
	assertDesktopFakeExactRecovery,
	assertDesktopFakeInvocationOwnership,
	type DesktopFakeLaunchEvidence,
} from "../../../scripts/agent-lab/desktop-fake-recovery";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";
import type { FakeInvocationReceipt } from "../../../scripts/agent-lab/fake-invocation-receipt";

const before: DesktopFakeLaunchEvidence = {
	taskId: "task",
	sessionInstanceId: "old-launch",
	providerSessionId: "agent-lab-task",
	pid: 100,
	hook: { event: "activity", hookEventName: "SessionStart", deliveryId: "old-hook" },
};
const after: DesktopFakeLaunchEvidence = {
	...before,
	sessionInstanceId: "new-launch",
	pid: 101,
	hook: { ...before.hook, deliveryId: "new-hook" },
};
const beforeReceipt: FakeInvocationReceipt = {
	version: 1,
	provider: "codex",
	taskId: "task",
	sessionInstanceId: "old-launch",
	pid: 100,
	providerSessionId: "agent-lab-task",
	resumeKind: "fresh",
	requestedSessionId: null,
	historyPresent: true,
};
const afterReceipt: FakeInvocationReceipt = {
	...beforeReceipt,
	sessionInstanceId: "new-launch",
	pid: 101,
	resumeKind: "targeted",
	requestedSessionId: "agent-lab-task",
};

describe("packaged fake exact-session recovery evidence", () => {
	it("accepts targeted argv, matching history and a new current native hook", () => {
		expect(() => assertDesktopFakeExactRecovery({ before, after, beforeReceipt, afterReceipt })).not.toThrow();
	});
	it.each([
		{ resumeKind: "fresh" as const, requestedSessionId: null },
		{ resumeKind: "continue" as const, requestedSessionId: null },
		{ historyPresent: false },
		{ taskId: "another-task" },
		{ sessionInstanceId: "another-launch" },
		{ providerSessionId: "another-conversation", requestedSessionId: "another-conversation" },
	])("rejects incomplete or unrelated invocation proof %j", (change) => {
		expect(() =>
			assertDesktopFakeExactRecovery({ before, after, beforeReceipt, afterReceipt: { ...afterReceipt, ...change } }),
		).toThrow();
	});
	it.each([
		{ taskId: "another-task" },
		{ providerSessionId: "another-conversation" },
		{ sessionInstanceId: before.sessionInstanceId },
		{ hook: before.hook },
	])("rejects a card-only or historical native proof %j", (change) => {
		expect(() =>
			assertDesktopFakeExactRecovery({ before, after: { ...after, ...change }, beforeReceipt, afterReceipt }),
		).toThrow();
	});
	it("does not mistake a reused numeric PID for the same PTY identity", () => {
		expect(() =>
			assertDesktopFakeExactRecovery({
				before,
				after: { ...after, pid: before.pid },
				beforeReceipt,
				afterReceipt: { ...afterReceipt, pid: before.pid },
			}),
		).not.toThrow();
	});

	const helper: DesktopLabProcess = { pid: 99, parentPid: 98, startedAt: "helper birth", command: "helper" };
	const pty: DesktopLabProcess = { pid: 100, parentPid: 99, startedAt: "pty birth", command: "tsx CLI" };
	const worker: DesktopLabProcess = { pid: 102, parentPid: 100, startedAt: "worker birth", command: "fake worker" };
	it.each([100, 102])("proves a same-root or TSX-descendant receipt PID %s", (pid) => {
		const proof = assertDesktopFakeInvocationOwnership({
			launch: before,
			receipt: { ...beforeReceipt, pid },
			helper,
			processes: [helper, pty, worker],
		});
		expect(proof.pty).toEqual(pty);
		expect(proof.worker.pid).toBe(pid);
	});
	it.each([
		{ ...worker, parentPid: helper.pid },
		{ ...worker, parentPid: 1 },
	])("rejects an unrelated or sibling worker %j", (unrelated) => {
		expect(() =>
			assertDesktopFakeInvocationOwnership({
				launch: before,
				receipt: { ...beforeReceipt, pid: worker.pid },
				helper,
				processes: [helper, pty, unrelated],
			}),
		).toThrow();
	});
	it("rejects a reused helper birth before admitting any PID subtree", () => {
		expect(() =>
			assertDesktopFakeInvocationOwnership({
				launch: before,
				receipt: beforeReceipt,
				helper,
				processes: [{ ...helper, startedAt: "reused" }, pty, worker],
			}),
		).toThrow();
	});
	it("rejects a missing PTY root and worker even if metadata matches", () => {
		expect(() =>
			assertDesktopFakeInvocationOwnership({ launch: before, receipt: beforeReceipt, helper, processes: [helper] }),
		).toThrow();
	});
});
