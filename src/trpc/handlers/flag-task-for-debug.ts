import { emitSessionEvent } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface FlagTaskForDebugDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

export async function handleFlagTaskForDebug(
	projectScope: RuntimeTrpcProjectScope,
	input: { taskId: string; note?: string },
	deps: FlagTaskForDebugDeps,
) {
	const terminalManager = await deps.getScopedTerminalManager(projectScope);
	const summary = terminalManager.store.getSummary(input.taskId);
	if (!summary) {
		return { ok: false };
	}
	emitSessionEvent(input.taskId, "user.flagged", {
		note: input.note ?? null,
		state: summary.state,
		reviewReason: summary.reviewReason,
		pid: summary.pid,
		agentId: summary.agentId,
		lastOutputAt: summary.lastOutputAt,
		lastHookAt: summary.lastHookAt,
		updatedAt: summary.updatedAt,
		startedAt: summary.startedAt,
		exitCode: summary.exitCode,
		latestHookEvent: summary.latestHookActivity?.hookEventName ?? null,
	});
	return { ok: true };
}
