import { createTaggedLogger, type IRuntimeConfigProvider, parseTaskSessionStartRequest } from "../../core";
import {
	type SerializedTaskSessionStartServiceDependencies,
	startTaskSessionThroughService,
	type TaskSessionStartServiceResult,
} from "../../server/task-session-start-service";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";
import { queueTaskDisplaySummaryPolish } from "../display-summary-polish";

const log = createTaggedLogger("task-session-start");

export interface StartTaskSessionDeps extends SerializedTaskSessionStartServiceDependencies {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	assertNativeStartAllowed?: (scope: RuntimeTrpcProjectScope, taskId: string) => Promise<void>;
	onTaskSessionStarted?: (scope: RuntimeTrpcProjectScope, result: TaskSessionStartServiceResult) => Promise<void>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function handleStartTaskSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StartTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStartRequest(input);
		log.debug("start-task-session request received", {
			taskId: body.taskId,
			projectId: projectScope.projectId,
			projectPath: projectScope.projectPath,
			resumeConversation: body.resumeConversation ?? false,
			awaitReview: body.awaitReview ?? false,
			useWorktree: body.useWorktree ?? true,
			requestedAgentId: body.agentId ?? null,
			launchOperationId: body.launchOperationId ?? null,
			hasPrompt: Boolean(body.prompt.trim()),
			imageCount: body.images?.length ?? 0,
			baseRef: body.baseRef,
		});

		const result = await startTaskSessionThroughService(projectScope, body, deps, {
			assertStartAllowed: deps.assertNativeStartAllowed
				? async () => await deps.assertNativeStartAllowed?.(projectScope, body.taskId)
				: undefined,
		});
		await deps.onTaskSessionStarted?.(projectScope, result);
		if (result.llmSummaryPolishEnabled) {
			queueTaskDisplaySummaryPolish({
				projectScope,
				taskId: body.taskId,
				deps,
				reason: "task-started",
				promptOverride: body.prompt,
			});
		}
		log.debug("start-task-session returning ok", {
			taskId: body.taskId,
			agentId: result.summary.agentId,
			state: result.summary.state,
			reviewReason: result.summary.reviewReason,
			pid: result.summary.pid,
			startedAt: result.summary.startedAt,
			resumeSessionIdOnSummary: result.summary.resumeSessionId ?? null,
			sessionLaunchPath: result.summary.sessionLaunchPath,
		});
		return {
			ok: true,
			summary: result.summary,
		};
	} catch (error) {
		const message = errorMessage(error);
		log.warn("start-task-session returning error", { error: message });
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
