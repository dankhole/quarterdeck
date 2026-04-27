import { createTaggedLogger, parseTaskSessionStopRequest } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

const log = createTaggedLogger("task-session-stop");

export interface StopTaskSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

export async function handleStopTaskSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StopTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStopRequest(input);
		log.debug("stop-task-session request received", {
			taskId: body.taskId,
			projectId: projectScope.projectId,
			waitForExit: body.waitForExit ?? false,
		});
		const terminalManager = await deps.getScopedTerminalManager(projectScope);
		const summary = body.waitForExit
			? await terminalManager.stopTaskSessionAndWaitForExit(body.taskId)
			: terminalManager.stopTaskSession(body.taskId);
		log.debug("stop-task-session returning", {
			taskId: body.taskId,
			ok: Boolean(summary),
			state: summary?.state ?? null,
			pid: summary?.pid ?? null,
			resumeSessionIdOnSummary: summary?.resumeSessionId ?? null,
		});
		return {
			ok: Boolean(summary),
			summary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn("stop-task-session returning error", { error: message });
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
