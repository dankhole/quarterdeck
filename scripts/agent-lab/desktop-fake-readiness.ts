import type { RuntimeTaskSessionSummary } from "../../src/core/api/task-session";
import { collectOwnedDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";

/** Metadata-only timeout evidence; it never substitutes for current-launch readiness. */
export function projectDesktopFakeReadinessDiagnostic(summary: RuntimeTaskSessionSummary) {
	return {
		taskId: summary.taskId,
		agentId: summary.agentId,
		sessionInstanceId: summary.sessionInstanceId ?? null,
		providerSessionId: summary.resumeSessionId ?? null,
		pid: summary.pid,
		state: summary.state,
		reviewReason: summary.reviewReason,
		hooks: summary.recentProviderHookOrderObservations.map((hook) => ({
			event: hook.event,
			source: hook.source,
			hookEventName: hook.hookEventName,
			sessionInstanceId: hook.sessionInstanceId,
			providerSessionId: hook.providerSessionId,
			deliveryId: hook.deliveryId,
		})),
	};
}

/** Startup readiness is not a work/lifecycle assertion. Never accept an older launch's hook. */
export function projectDesktopFakeReadiness(summary: RuntimeTaskSessionSummary, taskId: string) {
	const providerSessionId = `agent-lab-${taskId}`;
	if (
		summary.taskId !== taskId ||
		summary.agentId !== "codex" ||
		!summary.sessionInstanceId ||
		summary.resumeSessionId !== providerSessionId ||
		!Number.isInteger(summary.pid) ||
		!summary.pid ||
		summary.pid <= 0
	)
		return null;
	const hook = summary.recentProviderHookOrderObservations.find(
		(observation) =>
			observation.source === "codex" &&
			observation.event === "activity" &&
			observation.hookEventName === "SessionStart" &&
			observation.sessionInstanceId === summary.sessionInstanceId &&
			(!observation.providerSessionId || observation.providerSessionId === providerSessionId),
	);
	if (!hook) return null;
	return {
		taskId,
		sessionInstanceId: summary.sessionInstanceId,
		providerSessionId,
		pid: summary.pid,
		hook: { event: hook.event, hookEventName: hook.hookEventName, deliveryId: hook.deliveryId },
	};
}

export function assertDesktopFakeProcessOwnership(
	pid: number,
	helper: DesktopLabProcess,
	processes: DesktopLabProcess[],
): DesktopLabProcess {
	const currentHelper = processes.find((process) => process.pid === helper.pid);
	if (!currentHelper || !sameDesktopProcess(helper, currentHelper))
		throw new Error("Fake readiness lost the exact owned helper identity.");
	const owned = collectOwnedDesktopProcesses(processes, [], [helper]);
	const agent = owned.find((process) => process.pid === pid && process.pid !== helper.pid);
	if (!agent) throw new Error("Fake readiness does not identify a live owned helper descendant.");
	return agent;
}
