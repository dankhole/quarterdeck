import type { ConversationSourceHintRecorder } from "../conversation/index.js";
import type {
	IProjectResolver,
	ITerminalManagerProvider,
	RuntimeHookEvent,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeHookMetadata,
	RuntimeTaskSessionSummary,
} from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass, parseHookIngestRequest } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import { loadProjectScopeById } from "../state";
import {
	type SessionSummaryStore,
	shouldRetainHookEventOrderObservation,
	type TerminalSessionManager,
} from "../terminal";
import type { RuntimeTrpcContext } from "./app-router";

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

function applyCompletedResponseFromMetadata(
	store: SessionSummaryStore,
	taskId: string,
	metadata: { conversationSummaryText?: string | null; finalMessage?: string | null } | undefined,
): void {
	// Retain the response independently of latestHookActivity: subsequent hooks
	// clear its finalMessage. The legacy hook field remains an input fallback.
	const text = metadata?.finalMessage?.trim() || metadata?.conversationSummaryText?.trim();
	if (text) {
		store.appendCompletedResponse(taskId, {
			text,
			capturedAt: Date.now(),
		});
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

/**
 * Records whether the store changed while a hook was being applied. Hook
 * application is synchronous, so every change seen in that window belongs to
 * this hook and must be durable before it is acknowledged.
 */
function observeSessionStoreChanges(store: SessionSummaryStore): { changed: () => boolean; stop: () => void } {
	let changed = false;
	let unsubscribe: (() => void) | null = store.onChange(() => {
		changed = true;
	});
	return {
		changed: () => changed,
		stop: () => {
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}

type HookBackgroundTaskScheduler = (task: () => void) => void;

function scheduleHookBackgroundTask(task: () => void): void {
	const timeout = setTimeout(task, 0);
	timeout.unref?.();
}

export interface CreateHooksApiDependencies {
	projects: Pick<IProjectResolver, "getProjectPathById">;
	terminals: ITerminalManagerProvider;
	scheduleHookBackgroundTask?: HookBackgroundTaskScheduler;
	/** Resolves only after the latest session-store generation is durable. */
	persistSessionState?: (projectId: string) => Promise<void>;
	/**
	 * Resolves once session-store changes already made are durable without
	 * forcing a new write. Acknowledges hooks that changed nothing, such as a
	 * duplicate delivery whose first attempt may still be persisting. Falls back
	 * to `persistSessionState` when omitted.
	 */
	awaitSessionStateDurable?: (projectId: string) => Promise<void>;
	diagnostics?: RuntimeDiagnostics;
	conversationSourceHints?: ConversationSourceHintRecorder;
	observeProgress?: (input: {
		projectId: string;
		taskId: string;
		store: SessionSummaryStore;
		previous: RuntimeTaskSessionSummary;
	}) => void;
	onNativeProviderSessionObserved?: (input: {
		scope: { projectId: string; projectPath: string };
		taskId: string;
		manager: TerminalSessionManager;
	}) => Promise<void>;
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const scheduleBackgroundTask = deps.scheduleHookBackgroundTask ?? scheduleHookBackgroundTask;

	return {
		ingest: async (input) => {
			let diagnosticContext: {
				projectId?: string;
				taskId?: string;
				sessionInstanceId?: string;
				deliveryId?: string;
			} = {};
			let sessionChanges: ReturnType<typeof observeSessionStoreChanges> | null = null;
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

				const observedSessionChanges = observeSessionStoreChanges(store);
				sessionChanges = observedSessionChanges;
				let providerSessionIdentityAccepted = false;
				const completeHookIngest = async (advanceProviderOrder: boolean): Promise<RuntimeHookIngestResponse> => {
					manager.commitHookEventOrder(taskId, body, advanceProviderOrder);
					observedSessionChanges.stop();
					// A hook that changed nothing (duplicate, rejected, or foreign) still
					// waits for already-dirty state, which covers an earlier attempt of
					// the same delivery, but must not force its own write.
					const awaitDurable = observedSessionChanges.changed()
						? deps.persistSessionState
						: (deps.awaitSessionStateDurable ?? deps.persistSessionState);
					await awaitDurable?.(projectId);
					if (providerSessionIdentityAccepted && body.metadata?.sessionId?.trim()) {
						scheduleBackgroundTask(() => {
							void deps
								.onNativeProviderSessionObserved?.({
									scope: { projectId, projectPath },
									taskId,
									manager,
								})
								.catch((error) => {
									log.warn("Native provider session ownership observation failed", {
										projectId,
										taskId,
										errorClass:
											error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
									});
								});
						});
					}
					return { ok: true };
				};
				const expectedProvider =
					previousSummary.agentId === "codex" ||
					previousSummary.agentId === "claude" ||
					previousSummary.agentId === "pi"
						? previousSummary.agentId
						: null;
				const hookProvider = body.metadata?.source?.trim().toLowerCase() ?? null;
				const launchHandoffPending = manager.shouldDeferProviderHookUntilLaunchHandoff(taskId, body);
				if (expectedProvider && hookProvider !== expectedProvider && !launchHandoffPending) {
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
				if (launchHandoffPending) {
					log.info("Hook ingest deferred until task session launch handoff", hookLogData);
					return {
						ok: false,
						error: "Task session launch handoff is still in progress; retry this hook.",
					} satisfies RuntimeHookIngestResponse;
				}
				providerSessionIdentityAccepted = true;
				// A Codex subagent hook carries the root session id beside the child
				// thread's own transcript path; it must not redirect the task's
				// conversation source.
				if (!body.metadata?.providerAgentId?.trim()) {
					deps.conversationSourceHints?.recordProviderHookHint({
						projectId,
						taskId,
						expectedProviderSessionId: body.metadata?.sessionId ?? previousSummary.resumeSessionId ?? null,
						metadata: body.metadata,
					});
				}

				const transitionResult = manager.applyProviderHook(taskId, body);
				if (!transitionResult) {
					log.warn("Hook ingest failed: task disappeared before transition", hookLogData);
					return { ok: false, error: `Task "${taskId}" transition failed` };
				}
				const nextSummary = transitionResult.summary;
				const hasForegroundCompletionMetadata =
					transitionResult.hookMetadataMode === "apply" && isForegroundCompletionMetadata(body.metadata);
				if (hasForegroundCompletionMetadata) {
					applyCompletedResponseFromMetadata(store, taskId, body.metadata);
				}
				if (transitionResult.hookMetadataMode === "apply") {
					deps.observeProgress?.({ projectId, taskId, store, previous: previousSummary });
				}
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
			} finally {
				sessionChanges?.stop();
			}
		},
	};
}
