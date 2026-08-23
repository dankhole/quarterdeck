import {
	createTaggedLogger,
	parseTaskSessionStopRequest,
	type RuntimeTaskSessionStopOutcome,
	type RuntimeTaskSessionStopResponse,
	type TaskResourceOperationRunner,
} from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

const log = createTaggedLogger("task-session-stop");
type StopOperationResult = Omit<RuntimeTaskSessionStopResponse, "ok">;

export interface StopTaskSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	taskResourceOperations: TaskResourceOperationRunner;
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
		const result = await deps.taskResourceOperations.run<StopOperationResult>(
			projectScope.projectId,
			body.taskId,
			async () => {
				const terminalManager = await deps.getScopedTerminalManager(projectScope);
				if (body.waitForExit) {
					return await terminalManager.stopTaskSessionAndWaitForExit(body.taskId);
				}
				const summary = terminalManager.stopTaskSession(body.taskId);
				const outcome: RuntimeTaskSessionStopOutcome = summary ? "requested" : "not_running";
				return { summary, didExit: summary ? null : true, outcome };
			},
		);
		log.debug("stop-task-session returning", {
			taskId: body.taskId,
			ok: result.outcome !== "timed_out" && result.outcome !== "failed",
			outcome: result.outcome,
			didExit: result.didExit,
			state: result.summary?.state ?? null,
			pid: result.summary?.pid ?? null,
			resumeSessionIdOnSummary: result.summary?.resumeSessionId ?? null,
		});
		return {
			ok: result.outcome !== "timed_out" && result.outcome !== "failed",
			summary: result.summary,
			didExit: result.didExit,
			outcome: result.outcome,
			...(result.error ? { error: result.error } : {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn("stop-task-session returning error", { error: message });
		return {
			ok: false,
			summary: null,
			didExit: false,
			outcome: "failed" as const,
			error: message,
		};
	}
}
