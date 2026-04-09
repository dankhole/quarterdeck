import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { createTaggedLogger } from "../core/debug-logger";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { isPermissionActivity } from "../terminal/session-reconciliation";
import { DISPLAY_SUMMARY_MAX_LENGTH } from "../title/llm-client";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

const log = createTaggedLogger("hooks");

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
				log.debug("Hook ingest", {
					taskId,
					event,
					hasSummaryText: !!body.metadata?.conversationSummaryText,
					summarySnippet: body.metadata?.conversationSummaryText?.slice(0, 100),
				});
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
						// Guard: protect permission metadata from being clobbered by non-permission hooks.
						// When the task is in awaiting_review with permission-related activity, only allow
						// permission events to overwrite the activity. Non-permission hooks (Stop, PreToolUse,
						// SubagentStop, etc.) are silently skipped to preserve the "Waiting for approval" state.
						const currentActivity = summary.latestHookActivity;
						const shouldGuardPermission =
							summary.state === "awaiting_review" &&
							currentActivity != null &&
							isPermissionActivity(currentActivity);

						if (shouldGuardPermission) {
							const incomingActivity: RuntimeTaskHookActivity = {
								hookEventName: body.metadata.hookEventName ?? null,
								notificationType: body.metadata.notificationType ?? null,
								activityText: body.metadata.activityText ?? null,
								toolName: body.metadata.toolName ?? null,
								toolInputSummary: body.metadata.toolInputSummary ?? null,
								finalMessage: body.metadata.finalMessage ?? null,
								source: body.metadata.source ?? null,
								conversationSummaryText: body.metadata.conversationSummaryText ?? null,
							};
							if (!isPermissionActivity(incomingActivity)) {
								// Skip applyHookActivity — the incoming event is not permission-related
								// and would clobber the existing permission metadata.
								applyConversationSummaryFromMetadata(manager, taskId, body.metadata);
								return {
									ok: true,
								} satisfies RuntimeHookIngestResponse;
							}
						}

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

				// Apply hook activity and conversation summary BEFORE the async
				// checkpoint capture. The browser uses a 500ms settle window to
				// upgrade "review" → "permission" sounds based on activity data.
				// Checkpoint capture runs multiple git operations that routinely
				// exceed 500ms, so deferring activity would cause the settle
				// window to expire and the wrong (review) sound to play.
				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				applyConversationSummaryFromMetadata(manager, taskId, body.metadata);

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
