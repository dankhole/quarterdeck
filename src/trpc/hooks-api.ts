import type { ConversationSourceHintRecorder } from "../conversation/index.js";
import type {
	IProjectResolver,
	IRuntimeConfigProvider,
	ITerminalManagerProvider,
	RuntimeHookEvent,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeHookMetadata,
	RuntimeTaskTurnCheckpoint,
} from "../core";
import {
	createTaggedLogger,
	didEnterTaskReviewReady,
	normalizeDiagnosticErrorClass,
	parseHookIngestRequest,
} from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import { loadProjectScopeById } from "../state";
import { type SessionSummaryStore, shouldRetainHookEventOrderObservation } from "../terminal";
import { compactDisplaySummaryText } from "../title";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workdir";
import type { RuntimeTrpcContext } from "./app-router";
import { queueTaskDisplaySummaryPolish } from "./display-summary-polish";

const log = createTaggedLogger("hooks");

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildHookLogData(input: {
	projectId: string;
	taskId: string;
	event: RuntimeHookEvent;
	metadata: RuntimeHookMetadata | undefined;
	delivery: RuntimeHookIngestRequest["delivery"];
}): Record<string, unknown> {
	const metadata = input.metadata;
	return {
		projectId: input.projectId,
		taskId: input.taskId,
		event: input.event,
		source: metadata?.source ?? null,
		hasSessionId: Boolean(metadata?.sessionId),
		hasSessionInstanceId: Boolean(metadata?.sessionInstanceId),
		hasTurnId: Boolean(metadata?.turnId),
		hasPromptId: Boolean(metadata?.promptId),
		hasToolUseId: Boolean(metadata?.toolUseId),
		hasElicitationId: Boolean(metadata?.elicitationId),
		hasProviderAgentId: Boolean(metadata?.providerAgentId),
		deliveryId: input.delivery?.id ?? null,
		occurredAt: input.delivery?.occurredAt ?? null,
		hookEventName: metadata?.hookEventName ?? null,
		notificationType: metadata?.notificationType ?? null,
		toolName: metadata?.toolName ?? null,
		hasActivityText: Boolean(metadata?.activityText),
		hasToolInputSummary: Boolean(metadata?.toolInputSummary),
		hasFinalMessage: Boolean(metadata?.finalMessage),
		hasConversationSummaryText: Boolean(metadata?.conversationSummaryText),
		hasTranscriptPath: Boolean(metadata?.transcriptPath),
	};
}

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
		return;
	}
	if (metadata?.finalMessage) {
		const display = compactDisplaySummaryText(metadata.finalMessage);
		if (display) store.setDisplaySummary(taskId, display, null);
	}
}

function isForegroundCompletionMetadata(metadata: RuntimeHookMetadata | undefined): boolean {
	const source = metadata?.source?.trim().toLowerCase();
	return (
		(source === "codex" || source === "claude" || source === "pi") &&
		(metadata?.hookEventName?.trim().toLowerCase() === "stop" ||
			metadata?.hookEventName?.trim().toLowerCase() === "agentsettled") &&
		!metadata.providerAgentId?.trim()
	);
}

type HookBackgroundTaskScheduler = (task: () => void) => void;

function scheduleHookBackgroundTask(task: () => void): void {
	const timeout = setTimeout(task, 0);
	timeout.unref?.();
}

export interface CreateHooksApiDependencies {
	projects: Pick<IProjectResolver, "getProjectPathById">;
	terminals: ITerminalManagerProvider;
	config?: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
	scheduleHookBackgroundTask?: HookBackgroundTaskScheduler;
	/** Resolves only after the latest session-store generation is durable. */
	persistSessionState?: (projectId: string) => Promise<void>;
	diagnostics?: RuntimeDiagnostics;
	conversationSourceHints?: ConversationSourceHintRecorder;
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;
	const scheduleBackgroundTask = deps.scheduleHookBackgroundTask ?? scheduleHookBackgroundTask;

	return {
		ingest: async (input) => {
			let diagnosticContext: {
				projectId?: string;
				taskId?: string;
				sessionInstanceId?: string;
				deliveryId?: string;
			} = {};
			try {
				const body = parseHookIngestRequest(input);
				const { taskId, projectId, event } = body;
				diagnosticContext = {
					projectId,
					taskId,
					...(body.metadata?.sessionInstanceId ? { sessionInstanceId: body.metadata.sessionInstanceId } : {}),
					...(body.delivery?.id ? { deliveryId: body.delivery.id } : {}),
				};
				deps.diagnostics?.recordEvent(
					"hook.received",
					{
						event,
						source: body.metadata?.source ?? null,
						hookEventName: body.metadata?.hookEventName ?? null,
						notificationType: body.metadata?.notificationType ?? null,
						hasTurnId: Boolean(body.metadata?.turnId),
						hasPromptId: Boolean(body.metadata?.promptId),
						hasToolUseId: Boolean(body.metadata?.toolUseId),
						hasSessionId: Boolean(body.metadata?.sessionId),
					},
					diagnosticContext,
					{ essential: true },
				);
				const hookLogData = buildHookLogData({
					projectId,
					taskId,
					event,
					metadata: body.metadata,
					delivery: body.delivery,
				});
				log.info("Hook ingest received", hookLogData);

				const knownProjectPath = deps.projects.getProjectPathById(projectId);
				const loadedProjectScope = knownProjectPath ? null : await loadProjectScopeById(projectId);
				const projectPath = knownProjectPath ?? loadedProjectScope?.repoPath ?? null;
				if (!projectPath) {
					log.warn("Hook ingest rejected: project not found", hookLogData);
					return { ok: false, error: `Project "${projectId}" not found` } satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.terminals.ensureTerminalManagerForProject(projectId, projectPath);
				const { store } = manager;
				const previousSummary = store.getSummary(taskId);
				if (!previousSummary) {
					log.warn("Hook ingest rejected: task not found", {
						...hookLogData,
						hasProjectPath: projectPath.length > 0,
					});
					return {
						ok: false,
						error: `Task "${taskId}" not found in project "${projectId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				const completeHookIngest = async (advanceProviderOrder: boolean): Promise<RuntimeHookIngestResponse> => {
					manager.commitHookEventOrder(taskId, body, advanceProviderOrder);
					await deps.persistSessionState?.(projectId);
					return { ok: true };
				};
				const expectedProvider =
					previousSummary.agentId === "codex" ||
					previousSummary.agentId === "claude" ||
					previousSummary.agentId === "pi"
						? previousSummary.agentId
						: null;
				const hookProvider = body.metadata?.source?.trim().toLowerCase() ?? null;
				if (expectedProvider && hookProvider !== expectedProvider) {
					log.warn("Hook ignored: provider does not own the active task session", {
						...hookLogData,
						expectedProvider,
					});
					return await completeHookIngest(false);
				}
				const orderDecision = manager.evaluateHookEventOrder(taskId, body);
				if (!orderDecision.accepted) {
					log.info("Hook ingest ignored by delivery ordering", {
						...hookLogData,
						reason: orderDecision.reason,
					});
					return await completeHookIngest(shouldRetainHookEventOrderObservation(orderDecision));
				}

				manager.recordHookReceived(taskId);
				if (!manager.observeTaskSessionLaunchHook(taskId, body.metadata)) {
					log.warn("Hook ignored: startup resume opened an unexpected conversation", hookLogData);
					return await completeHookIngest(false);
				}
				deps.conversationSourceHints?.recordClaudeHookHint({
					projectId,
					taskId,
					expectedProviderSessionId: body.metadata?.sessionId ?? previousSummary.resumeSessionId ?? null,
					metadata: body.metadata,
				});

				const transitionResult = manager.applyProviderHook(taskId, body);
				if (!transitionResult) {
					log.warn("Hook ingest failed: task disappeared before transition", hookLogData);
					return { ok: false, error: `Task "${taskId}" transition failed` };
				}
				const nextSummary = transitionResult.summary;
				const hasForegroundCompletionMetadata = isForegroundCompletionMetadata(body.metadata);
				if (hasForegroundCompletionMetadata) {
					applyConversationSummaryFromMetadata(store, taskId, body.metadata);
				}
				const hasSummarySourceMetadata = Boolean(
					hasForegroundCompletionMetadata &&
						(body.metadata?.conversationSummaryText?.trim() || body.metadata?.finalMessage?.trim()),
				);
				if (deps.config && (transitionResult.changed || hasSummarySourceMetadata)) {
					queueTaskDisplaySummaryPolish({
						projectScope: { projectId, projectPath },
						taskId,
						reason: transitionResult.changed ? `hook.${event}` : "hook.metadata",
						deps: {
							config: deps.config,
							getScopedTerminalManager: async (scope) =>
								await deps.terminals.ensureTerminalManagerForProject(scope.projectId, scope.projectPath),
							scheduleBackgroundTask,
						},
					});
				}
				const enteredOrdinaryReview = didEnterTaskReviewReady(previousSummary, nextSummary);
				// Ordering is committed after the canonical mutation so correlation for
				// PermissionRequest observes the preceding PreToolUse, not itself. The
				// reducer explicitly retains identity-bearing Claude observations that
				// cannot change task meaning (for example, an unrelated completion),
				// while mismatched Codex turns remain delivery-only.
				const response = await completeHookIngest(
					transitionResult.hookMetadataMode === "apply" || transitionResult.hookOrderingMode === "advance",
				);
				log.info(
					transitionResult.changed ? "Hook transition applied" : "Hook accepted without semantic transition",
					{
						...hookLogData,
						fromState: previousSummary.state,
						fromReviewReason: previousSummary.reviewReason,
						toState: nextSummary.state,
						toReviewReason: nextSummary.reviewReason,
						interactionStatus: nextSummary.outstandingInteraction?.status ?? null,
					},
				);

				if (enteredOrdinaryReview) {
					const nextTurn = (nextSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = nextSummary.sessionLaunchPath ?? projectPath;
					const staleRef = nextSummary.previousTurnCheckpoint?.ref ?? null;
					const checkpointLogData = {
						...hookLogData,
						hasCheckpointCwd: checkpointCwd.length > 0,
						checkpointTurn: nextTurn,
						hasStaleCheckpointRef: staleRef !== null,
					};
					void (async () => {
						try {
							const checkpoint = await checkpointCapture({ cwd: checkpointCwd, taskId, turn: nextTurn });
							store.applyTurnCheckpoint(taskId, checkpoint);
							if (staleRef) {
								void checkpointRefDelete({ cwd: checkpointCwd, ref: staleRef }).catch((error) => {
									log.warn("Failed to delete stale hook turn checkpoint ref", {
										...checkpointLogData,
										errorClass:
											error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
									});
								});
							}
						} catch (error) {
							log.warn("Hook turn checkpoint capture failed", {
								...checkpointLogData,
								errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
							});
						}
					})();
				}

				return response;
			} catch (error) {
				const message = errorMessage(error);
				log.error("Hook ingest crashed", {
					errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
				});
				deps.diagnostics?.recordEvent(
					"hook.ingest_failed",
					{ errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError" },
					diagnosticContext,
					{ level: "error", essential: true },
				);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
