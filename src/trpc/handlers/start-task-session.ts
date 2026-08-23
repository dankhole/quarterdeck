import {
	createTaggedLogger,
	type IRuntimeConfigProvider,
	parseTaskSessionStartRequest,
	type RuntimeTaskSessionSummary,
} from "../../core";
import {
	type SerializedTaskSessionStartServiceDependencies,
	startTaskSessionThroughService,
} from "../../server/task-session-start-service";
import type { TerminalSessionManager } from "../../terminal";
import { captureTaskTurnCheckpoint } from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";
import { queueTaskDisplaySummaryPolish } from "../display-summary-polish";

const log = createTaggedLogger("task-session-start");

export interface StartTaskSessionDeps extends SerializedTaskSessionStartServiceDependencies {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function queueStartTurnCheckpointCapture(options: {
	terminalManager: TerminalSessionManager;
	taskId: string;
	taskCwd: string;
	summary: RuntimeTaskSessionSummary;
}): void {
	const nextTurn = (options.summary.latestTurnCheckpoint?.turn ?? 0) + 1;
	const checkpointLogData = {
		taskId: options.taskId,
		taskCwd: options.taskCwd,
		checkpointTurn: nextTurn,
		sessionStartedAt: options.summary.startedAt,
	};
	log.debug("Start turn checkpoint capture queued", checkpointLogData);
	void captureTaskTurnCheckpoint({
		cwd: options.taskCwd,
		taskId: options.taskId,
		turn: nextTurn,
	})
		.then((checkpoint) => {
			const currentSummary = options.terminalManager.store.getSummary(options.taskId);
			if (currentSummary?.startedAt !== options.summary.startedAt) {
				log.debug("Start turn checkpoint capture skipped for stale session", checkpointLogData);
				return;
			}
			options.terminalManager.store.applyTurnCheckpoint(options.taskId, checkpoint);
			log.debug("Start turn checkpoint captured", {
				...checkpointLogData,
				checkpointRef: checkpoint.ref,
				checkpointCommit: checkpoint.commit,
			});
		})
		.catch((error) => {
			log.warn("Start turn checkpoint capture failed", {
				...checkpointLogData,
				error: errorMessage(error),
			});
		});
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
			hasPrompt: Boolean(body.prompt.trim()),
			imageCount: body.images?.length ?? 0,
			baseRef: body.baseRef,
		});

		const result = await startTaskSessionThroughService(projectScope, body, deps);
		if (result.llmSummaryPolishEnabled) {
			queueTaskDisplaySummaryPolish({
				projectScope,
				taskId: body.taskId,
				deps,
				reason: "task-started",
				promptOverride: body.prompt,
			});
		}
		if (!body.resumeConversation) {
			queueStartTurnCheckpointCapture({
				terminalManager: result.terminalManager,
				taskId: body.taskId,
				taskCwd: result.taskCwd,
				summary: result.summary,
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
