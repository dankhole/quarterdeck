import type {
	IProjectResolver,
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeHookMetadata,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core";
import { createTaggedLogger, parseHookIngestRequest } from "../core";
import { loadProjectContextById } from "../state";
import type { SessionSummaryStore } from "../terminal";
import { canReturnToRunning, isPermissionActivity } from "../terminal";
import { DISPLAY_SUMMARY_MAX_LENGTH } from "../title";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workdir";
import type { RuntimeTrpcContext } from "./app-router";
import { applyRuntimeMutationEffects, createHookTransitionEffects } from "./runtime-mutation-effects";

const log = createTaggedLogger("hooks");
const HOOK_LOG_SNIPPET_MAX_LENGTH = 300;

// [perf-investigation] Count hook ingest events per 5s window to see if
// idle-agent CPU churn correlates with hook-event volume. Remove this block
// (and the single reportHookIngest() call below) if investigation shows hook
// rate is not the cause of the "scrollbar changing on idle" CPU symptom.
const HOOK_RATE_WINDOW_MS = 5000;
let hookIngestCount = 0;
let hookRateWindowStart = Date.now();
function reportHookIngest(event: RuntimeHookEvent, taskId: string): void {
	hookIngestCount += 1;
	const now = Date.now();
	const elapsed = now - hookRateWindowStart;
	if (elapsed >= HOOK_RATE_WINDOW_MS) {
		log.warn("[perf-investigation] hook ingest rate", {
			eventsInWindow: hookIngestCount,
			windowMs: elapsed,
			ratePerSec: Math.round((hookIngestCount / elapsed) * 1000 * 10) / 10,
			lastEvent: event,
			lastTaskId: taskId,
		});
		hookIngestCount = 0;
		hookRateWindowStart = now;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function logSnippet(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length <= HOOK_LOG_SNIPPET_MAX_LENGTH) {
		return trimmed;
	}
	return `${trimmed.slice(0, HOOK_LOG_SNIPPET_MAX_LENGTH)}...`;
}

function buildHookLogData(input: {
	projectId: string;
	taskId: string;
	event: RuntimeHookEvent;
	metadata: RuntimeHookMetadata | undefined;
}): Record<string, unknown> {
	const metadata = input.metadata;
	return {
		projectId: input.projectId,
		taskId: input.taskId,
		event: input.event,
		source: metadata?.source ?? null,
		sessionId: metadata?.sessionId ?? null,
		hookEventName: metadata?.hookEventName ?? null,
		notificationType: metadata?.notificationType ?? null,
		toolName: metadata?.toolName ?? null,
		activityTextSnippet: logSnippet(metadata?.activityText),
		toolInputSummarySnippet: logSnippet(metadata?.toolInputSummary),
		finalMessageSnippet: logSnippet(metadata?.finalMessage),
		hasConversationSummaryText: !!metadata?.conversationSummaryText,
		conversationSummarySnippet: logSnippet(metadata?.conversationSummaryText),
	};
}

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

function toHookActivityPatch(metadata: RuntimeHookMetadata | undefined): Partial<RuntimeTaskHookActivity> | undefined {
	if (!metadata) {
		return undefined;
	}
	const { sessionId: _sessionId, ...activity } = metadata;
	return activity;
}

function isMetadataOnlySessionMeta(metadata: RuntimeHookMetadata | undefined): boolean {
	if (!metadata || metadata.hookEventName !== "session_meta" || !metadata.sessionId) {
		return false;
	}
	return (
		typeof metadata.activityText !== "string" &&
		typeof metadata.toolName !== "string" &&
		typeof metadata.toolInputSummary !== "string" &&
		typeof metadata.finalMessage !== "string" &&
		typeof metadata.notificationType !== "string"
	);
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
				const hookLogData = buildHookLogData({ projectId, taskId, event, metadata: body.metadata });
				log.info("Hook ingest received", hookLogData);
				reportHookIngest(event, taskId);
				const knownProjectPath = deps.projects.getProjectPathById(projectId);
				const projectContext = knownProjectPath ? null : await loadProjectContextById(projectId);
				const projectPath = knownProjectPath ?? projectContext?.repoPath ?? null;
				if (!projectPath) {
					log.warn("Hook ingest rejected: project not found", hookLogData);
					return {
						ok: false,
						error: `Project "${projectId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.terminals.ensureTerminalManagerForProject(projectId, projectPath);
				const { store } = manager;
				const summary = store.getSummary(taskId);
				if (!summary) {
					log.warn("Hook ingest rejected: task not found", { ...hookLogData, projectPath });
					return {
						ok: false,
						error: `Task "${taskId}" not found in project "${projectId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				const incomingSessionId = body.metadata?.sessionId?.trim() || null;
				const activityMetadata = toHookActivityPatch(body.metadata);
				const metadataOnlySessionMeta = isMetadataOnlySessionMeta(body.metadata);

				if (incomingSessionId) {
					log.debug("Hook ingest session_meta", {
						taskId,
						projectId,
						incomingSessionId,
						storedResumeSessionId: summary.resumeSessionId ?? null,
						metadataOnly: metadataOnlySessionMeta,
						hookEventName: body.metadata?.hookEventName ?? null,
						source: body.metadata?.source ?? null,
					});
				}

				// Record before transition guards. Even a no-op or blocked hook proves
				// the agent hook system is alive, so the "never started" reconciliation
				// path must not treat this session as pre-hook.
				manager.recordHookReceived(taskId);
				const canTransition = canTransitionTaskForHookEvent(summary, event);
				if (!canTransition) {
					log.debug("Hook blocked: cannot transition from current state", {
						...hookLogData,
						currentState: summary.state,
						currentReviewReason: summary.reviewReason,
					});
					if (body.metadata && metadataOnlySessionMeta) {
						store.applyHookMetadata(taskId, body.metadata);
						log.debug("Hook metadata-only session id applied", {
							...hookLogData,
							currentState: summary.state,
						});
						applyConversationSummaryFromMetadata(store, taskId, body.metadata);
						return {
							ok: true,
						} satisfies RuntimeHookIngestResponse;
					}
					if (activityMetadata) {
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
								hookEventName: activityMetadata.hookEventName ?? null,
								notificationType: activityMetadata.notificationType ?? null,
								activityText: activityMetadata.activityText ?? null,
								toolName: activityMetadata.toolName ?? null,
								toolInputSummary: activityMetadata.toolInputSummary ?? null,
								finalMessage: activityMetadata.finalMessage ?? null,
								source: activityMetadata.source ?? null,
								conversationSummaryText: activityMetadata.conversationSummaryText ?? null,
							};
							if (!isPermissionActivity(incomingActivity)) {
								log.debug("Hook blocked: permission guard prevented activity overwrite", {
									...hookLogData,
									incomingHookEvent: activityMetadata.hookEventName,
									currentPermissionActivity: currentActivity.hookEventName,
								});
								// Skip applyHookActivity — the incoming event is not permission-related
								// and would clobber the existing permission metadata.
								applyConversationSummaryFromMetadata(store, taskId, body.metadata);
								return {
									ok: true,
								} satisfies RuntimeHookIngestResponse;
							}
						}
					}
					if (body.metadata && (incomingSessionId || activityMetadata)) {
						store.applyHookMetadata(taskId, body.metadata);
						log.debug("Hook metadata applied without state transition", {
							...hookLogData,
							currentState: summary.state,
						});
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
						log.debug("Hook blocked: permission-aware transition guard prevented stale to_in_progress", {
							...hookLogData,
							incomingHookEvent,
							currentPermissionActivity: currentActivity.hookEventName,
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
				log.info("Hook transitioning", { ...hookLogData, ...transitionData });

				const transitionedSummary =
					event === "to_review" ? store.transitionToReview(taskId, "hook") : store.transitionToRunning(taskId);
				if (!transitionedSummary) {
					log.warn("Hook transition failed", { ...hookLogData, ...transitionData });
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (body.metadata && (incomingSessionId || activityMetadata)) {
					store.applyHookMetadata(taskId, body.metadata);
					log.debug("Hook metadata applied after transition", {
						...hookLogData,
						toState: transitionedSummary.state,
						toReviewReason: transitionedSummary.reviewReason,
					});
				}

				applyConversationSummaryFromMetadata(store, taskId, body.metadata);
				log.info("Hook transition applied", {
					...hookLogData,
					toState: transitionedSummary.state,
					toReviewReason: transitionedSummary.reviewReason,
					resumeSessionId: transitionedSummary.resumeSessionId,
				});

				// Patch B: Broadcast and return BEFORE checkpoint capture.
				// Checkpoint capture runs git operations (stash create) that routinely
				// exceed the hook CLI's 3s timeout. Returning early prevents timeout-
				// triggered retries while the state transition has already succeeded.
				// The checkpoint fires in the background and applies via store.update
				// which triggers onChange listeners for downstream consumers.
				const effects = createHookTransitionEffects({
					projectId,
					projectPath,
					taskId,
					event,
				});
				void applyRuntimeMutationEffects(deps.broadcaster, effects).catch((error) => {
					log.error("Failed to deliver hook transition effects", {
						...hookLogData,
						error: errorMessage(error),
						effectTypes: effects.map((effect) => effect.type),
					});
				});
				log.debug("Hook transition effects queued", {
					...hookLogData,
					effectTypes: effects.map((effect) => effect.type),
				});
				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.sessionLaunchPath ?? projectPath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					const checkpointLogData = {
						...hookLogData,
						checkpointCwd,
						checkpointTurn: nextTurn,
						staleCheckpointRef: staleRef,
					};
					log.debug("Hook turn checkpoint capture queued", checkpointLogData);
					void (async () => {
						try {
							const checkpoint = await checkpointCapture({
								cwd: checkpointCwd,
								taskId,
								turn: nextTurn,
							});
							store.applyTurnCheckpoint(taskId, checkpoint);
							log.info("Hook turn checkpoint captured", {
								...checkpointLogData,
								checkpointRef: checkpoint.ref,
								checkpointCommit: checkpoint.commit,
							});
							if (staleRef) {
								void checkpointRefDelete({
									cwd: checkpointCwd,
									ref: staleRef,
								})
									.then(() => {
										log.debug("Stale hook turn checkpoint ref deleted", checkpointLogData);
									})
									.catch((error) => {
										log.warn("Failed to delete stale hook turn checkpoint ref", {
											...checkpointLogData,
											error: errorMessage(error),
										});
									});
							}
						} catch (error) {
							log.warn("Hook turn checkpoint capture failed", {
								...checkpointLogData,
								error: errorMessage(error),
							});
						}
					})();
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = errorMessage(error);
				log.error("Hook ingest crashed", { error: message });
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
