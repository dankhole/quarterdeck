import type {
	IProjectResolver,
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core";
import { createTaggedLogger, emitSessionEvent, parseHookIngestRequest } from "../core";
import { loadProjectContextById } from "../state";
import type { SessionSummaryStore } from "../terminal";
import { canReturnToRunning, isPermissionActivity } from "../terminal";
import { DISPLAY_SUMMARY_MAX_LENGTH } from "../title";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workdir";
import type { RuntimeTrpcContext } from "./app-router";
import { applyRuntimeMutationEffects, createHookTransitionEffects } from "./runtime-mutation-effects";

const log = createTaggedLogger("hooks");

/**
 * Apply conversation summary or finalMessage from hook metadata to the session.
 * Shared between the early-return (can't transition) and normal transition paths.
 */
function applyConversationSummaryFromMetadata(
	store: SessionSummaryStore,
	taskId: string,
	metadata: { conversationSummaryText?: string | null; finalMessage?: string | null } | undefined,
): void {
	if (metadata?.conversationSummaryText) {
		store.appendConversationSummary(taskId, {
			text: metadata.conversationSummaryText,
			capturedAt: Date.now(),
		});
	} else if (metadata?.finalMessage) {
		const fm = metadata.finalMessage.trim();
		if (fm) {
			const display =
				fm.length > DISPLAY_SUMMARY_MAX_LENGTH ? `${fm.slice(0, DISPLAY_SUMMARY_MAX_LENGTH)}\u2026` : fm;
			store.setDisplaySummary(taskId, display, null);
		}
	}
}

export interface CreateHooksApiDependencies {
	projects: Pick<IProjectResolver, "getProjectPathById">;
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastRuntimeProjectStateUpdated" | "broadcastTaskReadyForReview">;
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
	return summary.state === "awaiting_review" && canReturnToRunning(summary.reviewReason);
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const projectId = body.projectId;
				const event = body.event;
				const hookReceivedData = {
					event,
					hookEventName: body.metadata?.hookEventName ?? null,
					notificationType: body.metadata?.notificationType ?? null,
					activityText: body.metadata?.activityText ?? null,
					toolName: body.metadata?.toolName ?? null,
					source: body.metadata?.source ?? null,
					hasSummaryText: !!body.metadata?.conversationSummaryText,
					summarySnippet: body.metadata?.conversationSummaryText?.slice(0, 100),
				};
				log.info("Hook ingest received", { taskId, ...hookReceivedData });
				const knownProjectPath = deps.projects.getProjectPathById(projectId);
				const projectContext = knownProjectPath ? null : await loadProjectContextById(projectId);
				const projectPath = knownProjectPath ?? projectContext?.repoPath ?? null;
				if (!projectPath) {
					return {
						ok: false,
						error: `Project "${projectId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.terminals.ensureTerminalManagerForProject(projectId, projectPath);
				const { store } = manager;
				const summary = store.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in project "${projectId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				manager.recordHookReceived(taskId);
				const canTransition = canTransitionTaskForHookEvent(summary, event);
				emitSessionEvent(taskId, "hook.received", {
					...hookReceivedData,
					canTransition,
					currentState: summary.state,
					currentReviewReason: summary.reviewReason,
				});
				if (!canTransition) {
					log.debug("Hook blocked — can't transition", {
						taskId,
						event,
						currentState: summary.state,
						currentReviewReason: summary.reviewReason,
						hookEventName: body.metadata?.hookEventName ?? null,
					});
					emitSessionEvent(taskId, "hook.blocked.cant_transition", {
						event,
						currentState: summary.state,
						currentReviewReason: summary.reviewReason,
						hookEventName: body.metadata?.hookEventName ?? null,
					});
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
								log.debug(
									"Hook blocked — permission guard (non-permission event clobbering permission state)",
									{
										taskId,
										event,
										incomingHookEvent: body.metadata.hookEventName,
										currentPermissionActivity: currentActivity.hookEventName,
									},
								);
								emitSessionEvent(taskId, "hook.blocked.permission_guard", {
									event,
									incomingHookEvent: body.metadata.hookEventName ?? null,
									currentPermissionActivity: currentActivity.hookEventName ?? null,
								});
								// Skip applyHookActivity — the incoming event is not permission-related
								// and would clobber the existing permission metadata.
								applyConversationSummaryFromMetadata(store, taskId, body.metadata);
								return {
									ok: true,
								} satisfies RuntimeHookIngestResponse;
							}
						}

						store.applyHookActivity(taskId, body.metadata);
					}
					applyConversationSummaryFromMetadata(store, taskId, body.metadata);
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				// Patch A: Permission-aware transition guard.
				// When to_in_progress arrives while the task is awaiting review with
				// permission-related activity, block the transition — this is almost
				// certainly a stale PostToolUse from a tool that completed before the
				// permission prompt appeared. UserPromptSubmit is exempted because it
				// means the user actively sent input (covers the edge case where
				// writeInput's synchronous transition didn't fire).
				if (event === "to_in_progress") {
					const currentActivity = summary.latestHookActivity;
					const incomingHookEvent = body.metadata?.hookEventName ?? null;
					if (
						currentActivity != null &&
						isPermissionActivity(currentActivity) &&
						incomingHookEvent !== "UserPromptSubmit"
					) {
						log.debug(
							"Hook blocked — permission-aware transition guard (stale to_in_progress during permission)",
							{
								taskId,
								event,
								incomingHookEvent,
								currentPermissionActivity: currentActivity.hookEventName,
							},
						);
						emitSessionEvent(taskId, "hook.blocked.transition_guard", {
							event,
							currentState: summary.state,
							incomingHookEvent,
							currentPermissionActivity: currentActivity.hookEventName ?? null,
						});
						applyConversationSummaryFromMetadata(store, taskId, body.metadata);
						return { ok: true } satisfies RuntimeHookIngestResponse;
					}
				}

				const transitionData = {
					event,
					fromState: summary.state,
					fromReviewReason: summary.reviewReason,
					toState: event === "to_review" ? "awaiting_review" : "running",
					hookEventName: body.metadata?.hookEventName ?? null,
				};
				log.info("Hook transitioning", { taskId, ...transitionData });
				emitSessionEvent(taskId, "hook.transitioned", transitionData);

				const transitionedSummary =
					event === "to_review" ? store.transitionToReview(taskId, "hook") : store.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (body.metadata) {
					store.applyHookActivity(taskId, body.metadata);
				}

				applyConversationSummaryFromMetadata(store, taskId, body.metadata);

				// Patch B: Broadcast and return BEFORE checkpoint capture.
				// Checkpoint capture runs git operations (stash create) that routinely
				// exceed the hook CLI's 3s timeout. Returning early prevents timeout-
				// triggered retries while the state transition has already succeeded.
				// The checkpoint fires in the background and applies via store.update
				// which triggers onChange listeners for downstream consumers.
				void applyRuntimeMutationEffects(
					deps.broadcaster,
					createHookTransitionEffects({
						projectId,
						projectPath,
						taskId,
						event,
					}),
				);
				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.sessionLaunchPath ?? projectPath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					void (async () => {
						try {
							const checkpoint = await checkpointCapture({
								cwd: checkpointCwd,
								taskId,
								turn: nextTurn,
							});
							store.applyTurnCheckpoint(taskId, checkpoint);
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
					})();
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
