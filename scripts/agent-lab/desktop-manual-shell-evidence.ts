import type { RuntimeTaskSessionSummary } from "../../src/core/api/task-session";
import { sameDesktopProcess } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";

export interface DesktopManualShellSnapshot {
	session: RuntimeTaskSessionSummary | null;
	process: DesktopLabProcess | null;
	dedicatedSlotIds: number[];
	helperTextareas: number;
	parkedTextareas: number;
}

export interface DesktopManualShellIdentity {
	taskId: string;
	sessionInstanceId: string;
	startedAt: number;
	process: DesktopLabProcess;
	slotId: number;
	cwd: string;
}

export function requireDesktopManualShell(snapshot: DesktopManualShellSnapshot): DesktopManualShellIdentity {
	const { session, process, dedicatedSlotIds } = snapshot;
	if (
		!session?.sessionInstanceId ||
		!session.startedAt ||
		!session.sessionLaunchPath ||
		session.agentId !== null ||
		session.state !== "running" ||
		!process ||
		process.pid !== session.pid ||
		dedicatedSlotIds.length !== 1 ||
		snapshot.helperTextareas !== 1 ||
		snapshot.parkedTextareas !== 0
	)
		throw new Error("Manual shell lacks one live owned PTY and dedicated terminal.");
	return {
		taskId: session.taskId,
		sessionInstanceId: session.sessionInstanceId,
		startedAt: session.startedAt,
		process,
		slotId: dedicatedSlotIds[0] as number,
		cwd: session.sessionLaunchPath,
	};
}

export function assertDesktopManualShellPreserved(
	before: DesktopManualShellIdentity,
	after: DesktopManualShellSnapshot,
): void {
	const current = requireDesktopManualShell(after);
	if (
		before.taskId !== current.taskId ||
		before.sessionInstanceId !== current.sessionInstanceId ||
		before.startedAt !== current.startedAt ||
		before.slotId !== current.slotId ||
		before.cwd !== current.cwd ||
		!sameDesktopProcess(before.process, current.process)
	)
		throw new Error("Hidden native close replaced the exact manual shell or its terminal.");
}

export function assertDesktopManualShellFresh(
	before: DesktopManualShellIdentity,
	after: DesktopManualShellIdentity,
): void {
	if (
		before.taskId !== after.taskId ||
		before.sessionInstanceId === after.sessionInstanceId ||
		before.startedAt === after.startedAt ||
		before.slotId === after.slotId ||
		sameDesktopProcess(before.process, after.process)
	)
		throw new Error("Reopened manual panel did not create a fresh PTY and dedicated terminal.");
}

/** Observe exact exit plus a quiet interval beyond the shell auto-restart delay. No signalling authority. */
export async function waitForDesktopManualShellRetirement(
	before: DesktopManualShellIdentity,
	ports: {
		capture(): Promise<DesktopManualShellSnapshot>;
		wait(milliseconds: number): Promise<void>;
		now(): number;
	},
	options: { timeoutMs?: number; quietMs?: number; pollMs?: number } = {},
): Promise<DesktopManualShellSnapshot> {
	const deadline = ports.now() + (options.timeoutMs ?? 15_000);
	const quietMs = options.quietMs ?? 1_500;
	let retiredAt: number | null = null;
	while (ports.now() < deadline) {
		const snapshot = await ports.capture();
		if (
			(snapshot.session?.pid != null &&
				(snapshot.session.pid !== before.process.pid ||
					snapshot.session.sessionInstanceId !== before.sessionInstanceId)) ||
			(snapshot.process !== null && !sameDesktopProcess(snapshot.process, before.process))
		)
			throw new Error("Closed manual shell was replaced or restarted.");
		const retired =
			snapshot.process === null &&
			snapshot.session?.pid == null &&
			snapshot.dedicatedSlotIds.length === 0 &&
			snapshot.helperTextareas === 0 &&
			snapshot.parkedTextareas === 0;
		if (retired) {
			retiredAt ??= ports.now();
			if (ports.now() - retiredAt >= quietMs) return snapshot;
		} else {
			if (retiredAt !== null) throw new Error("Closed manual shell regained a process or parked terminal.");
		}
		await ports.wait(options.pollMs ?? 100);
	}
	throw new Error("Manual panel close timed out before exact shell exit and terminal disposal were confirmed.");
}
