import { assertDesktopFakeProcessOwnership, type projectDesktopFakeReadiness } from "./desktop-fake-readiness";
import { collectOwnedDesktopProcesses } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";
import { type FakeInvocationReceipt, FakeInvocationReceiptSchema } from "./fake-invocation-receipt";

export type DesktopFakeLaunchEvidence = NonNullable<ReturnType<typeof projectDesktopFakeReadiness>>;

function assertReceiptMatchesLaunch(launch: DesktopFakeLaunchEvidence, receipt: FakeInvocationReceipt): void {
	FakeInvocationReceiptSchema.parse(receipt);
	if (
		receipt.taskId !== launch.taskId ||
		receipt.sessionInstanceId !== launch.sessionInstanceId ||
		receipt.providerSessionId !== launch.providerSessionId ||
		!receipt.historyPresent
	)
		throw new Error("Fake invocation receipt does not prove the current launch and its exact history.");
}

/** TSX may retain a PTY launcher parent; the receipt belongs to its exact live worker subtree. */
export function assertDesktopFakeInvocationOwnership(options: {
	launch: DesktopFakeLaunchEvidence;
	receipt: FakeInvocationReceipt;
	helper: DesktopLabProcess;
	processes: DesktopLabProcess[];
}): { pty: DesktopLabProcess; worker: DesktopLabProcess } {
	const { launch, receipt, helper, processes } = options;
	assertReceiptMatchesLaunch(launch, receipt);
	const pty = assertDesktopFakeProcessOwnership(launch.pid, helper, processes);
	const worker = collectOwnedDesktopProcesses(processes, [], [pty]).find((process) => process.pid === receipt.pid);
	if (!worker) throw new Error("Fake invocation receipt is not owned by the exact current PTY subtree.");
	return { pty, worker };
}

/** Provider output and a restored card cannot substitute for targeted argv plus a new native hook. */
export function assertDesktopFakeExactRecovery(options: {
	before: DesktopFakeLaunchEvidence;
	after: DesktopFakeLaunchEvidence;
	beforeReceipt: FakeInvocationReceipt;
	afterReceipt: FakeInvocationReceipt;
}): void {
	const { before, after, beforeReceipt, afterReceipt } = options;
	assertReceiptMatchesLaunch(before, beforeReceipt);
	assertReceiptMatchesLaunch(after, afterReceipt);
	if (beforeReceipt.resumeKind !== "fresh" || beforeReceipt.requestedSessionId !== null)
		throw new Error("Initial fake invocation was not a fresh conversation.");
	if (
		after.taskId !== before.taskId ||
		after.providerSessionId !== before.providerSessionId ||
		after.sessionInstanceId === before.sessionInstanceId ||
		after.hook.deliveryId === before.hook.deliveryId ||
		afterReceipt.resumeKind !== "targeted" ||
		afterReceipt.requestedSessionId !== before.providerSessionId
	)
		throw new Error("Runtime replacement did not target the exact fake conversation with a new PTY and native hook.");
}
