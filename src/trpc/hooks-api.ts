import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { DISPLAY_SUMMARY_MAX_LENGTH } from "../title/llm-client";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

/**
 * Apply conversation summary or finalMessage from hook metadata to the session.
 * Shared between the early-return (can't transition) and normal transition paths.
 */
function applyConversationSummaryFromMetadata(
	manager: TerminalSessionManager,
	taskId: string,
	metadata: { conversationSummaryText?: string | null; finalMessage?: string | null } | undefined,
): void {
	if (metadata?.conversationSummaryText) {
		manager.appendConversationSummary(taskId, {
			text: metadata.conversationSummaryText,
			capturedAt: Date.now(),
		});
	} else if (metadata?.finalMessage) {
		const fm = metadata.finalMessage.trim();
		if (fm) {
			const display =
				fm.length > DISPLAY_SUMMARY_MAX_LENGTH ? `${fm.slice(0, DISPLAY_SUMMARY_MAX_LENGTH)}\u2026` : fm;
			manager.setDisplaySummary(taskId, display, null);
		}
	}
}

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					applyConversationSummaryFromMetadata(manager, taskId, body.metadata);
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				const transitionedSummary =
					event === "to_review" ? manager.transitionToReview(taskId, "hook") : manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				applyConversationSummaryFromMetadata(manager, taskId, body.metadata);

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
