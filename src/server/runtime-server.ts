import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { getAgentAvailability, SUPPORTED_PI_VERSION, waitForPendingAgentAvailabilityProbes } from "../config";
import {
	ConversationSourceHintStore,
	type ConversationTaskSessionResolver,
	createConversationReadService,
} from "../conversation/index.js";
import type { IRuntimeHostIntegrations, RuntimeProjectStateResponse } from "../core";
import {
	areFileSystemPathsEqual,
	buildQuarterdeckRuntimeUrl,
	createTaggedLogger,
	findCardInBoard,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	getQuarterdeckRuntimePort,
	KeyedOperationCoordinator,
	normalizeDiagnosticErrorClass,
	QUARTERDECK_BUILD_ID,
	setQuarterdeckRuntimePort,
	shouldRejectLegacyRuntimeStreamClient,
	TaskResourceOperationCoordinator,
} from "../core";
import { handleDiagnosticsHttpRequest, type RuntimeDiagnostics } from "../diagnostics";
import {
	ClaudeStructuredOwnerRegistry,
	CodexStructuredOwnerRegistry,
	createStructuredShutdownPreparation,
	StructuredOwnerRegistry,
	TaskExecutionOwnershipService,
	TaskInteractionService,
} from "../execution";
import { createNativeTerminalInputWriter } from "../execution/native-terminal-input";
import { createHookTransitionOutboxReplayer } from "../hook-transition-outbox";
import { LanguageNavigationManager } from "../language-navigation/manager";
import type { ProjectBoardCommandService } from "../state";
import {
	listProjectIndexEntries,
	loadProjectBoardById,
	loadProjectScopeById,
	loadProjectState,
	loadSavedProjectStateById,
	ProjectExecutionOwnershipStore,
} from "../state";
import { readProjectRelocationJournal } from "../state/project-relocation-journal";
import type { TerminalSessionManager } from "../terminal";
import { createTerminalWebSocketBridge, getPiLifecycleExtensionFingerprint } from "../terminal";
import { AutomaticTitleGenerationCoordinator } from "../title";
import {
	createHooksApi,
	createProjectApi,
	createProjectsApi,
	createRuntimeApi,
	type RuntimeTrpcContext,
	type RuntimeTrpcProjectScope,
	runtimeAppRouter,
} from "../trpc";
import { createCodeNavigationApi } from "../trpc/code-navigation-api";
import { handleStartTaskSession } from "../trpc/handlers/start-task-session";
import { applyRuntimeMutationEffects, createTaskTitleUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { createAutomaticTaskTitlePostCommitListener } from "./automatic-task-title-scheduler";
import { createCodexTaskTitleMonitor } from "./codex-task-title-monitor";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import { stopRuntimeOwnedProcessTrees } from "./owned-process-shutdown";
import { ProjectLocationService } from "./project-location-service";
import { normalizeProjectMetadataClientId } from "./project-metadata-visibility";
import type { ProjectRegistry } from "./project-registry";
import { assertProjectRelocationRuntimeIsExclusive } from "./project-relocation-runtime-guard";
import { ProjectTaskLifecycleService } from "./project-task-lifecycle-service";
import type { RuntimeClientAccess } from "./runtime-client-access";
import { handleRuntimeHostEventRequest } from "./runtime-host-event-endpoint";
import type { RuntimeHostEventLedger } from "./runtime-host-event-ledger";
import { observeRuntimeApiRequest } from "./runtime-request-diagnostics";
import type { RuntimeSessionPersistence } from "./runtime-session-persistence";
import { RuntimeStartupCleanupError } from "./runtime-startup-cleanup";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { createTaskProgressPreview } from "./task-progress-preview";
import { prepareTaskSessionStart, type TaskSessionStartServiceResult } from "./task-session-start-service";
import { createTaskTitleService } from "./task-title-service";

const serverLog = createTaggedLogger("runtime-server");
const EXECUTION_OWNERSHIP_RECONCILIATION_INTERVAL_MS = 10_000;

interface DisposeTrackedProjectResult {
	terminalManager: TerminalSessionManager | null;
	projectPath: string | null;
}

export interface CreateRuntimeServerDependencies {
	beforeProcessSnapshot?: () => void;
	listenPort?: number;
	clientAccess?: RuntimeClientAccess;
	persistenceAllowed?: () => boolean;
	projectRegistry: ProjectRegistry;
	runtimeStateHub: RuntimeStateHub;
	runtimeSessionPersistence: Pick<RuntimeSessionPersistence, "persistRuntimeSessions" | "disposeProject" | "close">;
	initializeProjectsForStartup?: (runProjectOperation: RuntimeTrpcContext["runProjectOperation"]) => Promise<void>;
	boardCommands: ProjectBoardCommandService;
	diagnostics: RuntimeDiagnostics;
	warn: (message: string) => void;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	hostIntegrations: IRuntimeHostIntegrations;
	hostEventLedger?: RuntimeHostEventLedger;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => Promise<boolean>;
	disposeProject: (
		projectId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => Promise<DisposeTrackedProjectResult>;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeProjectStateResponse["board"]) => Set<string>;
}

export interface RuntimeServer {
	url: string;
	getQuitSummary: () => { liveProcessCount: number; pendingLaunches: boolean };
	/** Internal execution-owner boundary; intentionally not exposed through HTTP or tRPC. */
	executionOwnership: TaskExecutionOwnershipService;
	/** Internal structured interaction boundary; intentionally not exposed through HTTP or tRPC. */
	taskInteractions: TaskInteractionService;
	prepareForShutdown: (options?: { skipSessionCleanup?: boolean; persistenceAllowed?: boolean }) => Promise<void>;
	/** Signals owners only after the caller has captured exact-owned process trees. */
	stopTaskOwnersForShutdown: (options?: {
		skipSessionCleanup?: boolean;
		persistenceAllowed?: boolean;
	}) => Promise<void>;
	close: (options?: { persistenceAllowed?: boolean }) => Promise<void>;
}

export function createRuntimeConversationTaskSessionResolver(
	projectRegistry: Pick<ProjectRegistry, "resolveTaskSessionSummary">,
): ConversationTaskSessionResolver {
	return {
		resolveTaskSession: async (projectId, taskId) => {
			const summary = await projectRegistry.resolveTaskSessionSummary(projectId, taskId);
			return summary
				? {
						projectId,
						taskId,
						agentId: summary.agentId,
						providerSessionId: summary.resumeSessionId ?? null,
					}
				: null;
		},
	};
}

function readProjectIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-quarterdeck-project-id"];
	const headerProjectId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerProjectId === "string") {
		const normalized = headerProjectId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryProjectId = requestUrl.searchParams.get("projectId");
	if (typeof queryProjectId === "string") {
		const normalized = queryProjectId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	if (deps.hostEventLedger && deps.hostIntegrations.capabilities.hostIntegrationMode !== "simulated") {
		throw new Error("The Agent Lab host-event endpoint requires simulated host integrations.");
	}
	const startupCleanup: Array<() => void | Promise<void>> = [];
	const startupPreparation: Array<() => void | Promise<void>> = [];
	let shuttingDown = false;
	let startupStructuredOwners: StructuredOwnerRegistry | undefined;
	let startupCodeNavigation: LanguageNavigationManager | undefined;
	try {
		startupCleanup.push(() => deps.clientAccess?.clear());
		const webUiDir = getWebUiDir();
		const taskResourceOperations = new TaskResourceOperationCoordinator();
		const projectRegistrationOperations = new KeyedOperationCoordinator();
		const runRegistrationMutation = <T>(operation: () => Promise<T>): Promise<T> => {
			if (shuttingDown) return Promise.reject(new Error("Runtime is shutting down."));
			return projectRegistrationOperations.run("projects", operation);
		};
		deps.projectRegistry.setProjectOperationRunner((projectId, operation) => {
			if (shuttingDown) return Promise.reject(new Error("Runtime is shutting down."));
			return taskResourceOperations.runProject(projectId, operation);
		});
		const assertProjectScope = async (
			scope: RuntimeTrpcProjectScope,
			options?: Parameters<RuntimeTrpcContext["runProjectOperation"]>[2],
		): Promise<void> => {
			const current = await loadProjectScopeById(scope.projectId);
			if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Project no longer exists." });
			if (!areFileSystemPathsEqual(current.repoPath, scope.projectPath)) {
				throw new TRPCError({ code: "CONFLICT", message: "The project folder changed. Refresh and try again." });
			}
			if (!options?.allowUnavailable) {
				const availability = await deps.projectRegistry.checkProjectAvailability(scope.projectId);
				if (availability.status !== "available") {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Folder unavailable. Locate the project folder or check again.",
					});
				}
			}
		};
		const runProjectOperation: RuntimeTrpcContext["runProjectOperation"] = async (scope, operation, options) => {
			if (shuttingDown) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Runtime is shutting down." });
			return await taskResourceOperations.runProject(scope.projectId, async () => {
				await assertProjectScope(scope, options);
				return await operation();
			});
		};
		startupCleanup.push(async () => {
			await Promise.all([taskResourceOperations.waitForIdle(), projectRegistrationOperations.waitForIdle()]);
		});
		startupPreparation.push(async () => {
			await Promise.all([taskResourceOperations.waitForIdle(), projectRegistrationOperations.waitForIdle()]);
		});
		deps.boardCommands.setProjectOperationRunner((scope, operation) =>
			runProjectOperation(scope, operation, { allowUnavailable: true }),
		);
		const automaticTitleGeneration = new AutomaticTitleGenerationCoordinator();
		startupCleanup.push(() => automaticTitleGeneration.close());
		startupPreparation.push(() => automaticTitleGeneration.close());
		const conversationSourceHints = new ConversationSourceHintStore();
		const conversationReads = createConversationReadService({
			sessions: createRuntimeConversationTaskSessionResolver(deps.projectRegistry),
			hints: conversationSourceHints,
		});
		const progressPreviews = createTaskProgressPreview({
			hints: conversationSourceHints,
			isCurrentStore: (projectId, store) =>
				deps.projectRegistry
					.listManagedProjects()
					.some((project) => project.projectId === projectId && project.terminalManager.store === store),
		});
		startupCleanup.push(() => progressPreviews.close());
		startupPreparation.push(() => progressPreviews.close());
		const executionOwnershipStore = new ProjectExecutionOwnershipStore();
		const codexStructuredOwners = new CodexStructuredOwnerRegistry({
			clientVersion: deps.diagnostics.quarterdeckVersion,
		});
		const claudeStructuredOwners = new ClaudeStructuredOwnerRegistry();
		const structuredOwners = new StructuredOwnerRegistry(codexStructuredOwners, claudeStructuredOwners);
		startupStructuredOwners = structuredOwners;
		startupCleanup.push(async () => {
			const unconfirmed = await structuredOwners.stopAll();
			if (unconfirmed > 0) throw new Error("Structured provider shutdown remained unconfirmed.");
		});

		try {
			await readFile(join(webUiDir, "index.html"));
		} catch {
			throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
		}
		const codeNavigation = new LanguageNavigationManager({ diagnostics: deps.diagnostics });
		startupCodeNavigation = codeNavigation;
		startupCleanup.push(() => codeNavigation.close());
		const codeNavigationApi = createCodeNavigationApi(codeNavigation, deps.projectRegistry);
		const disposeCodeNavigationDiagnostics = deps.diagnostics.registerSnapshotProvider({
			name: "code_navigation",
			capture: (scope) => codeNavigation.getSnapshot(scope.projectId ?? undefined),
		});

		startupCleanup.push(disposeCodeNavigationDiagnostics);

		const resolveProjectScopeFromRequest = async (
			request: IncomingMessage,
			requestUrl: URL,
		): Promise<{
			requestedProjectId: string | null;
			projectScope: RuntimeTrpcProjectScope | null;
		}> => {
			const requestedProjectId = readProjectIdFromRequest(request, requestUrl);
			if (!requestedProjectId) {
				return {
					requestedProjectId: null,
					projectScope: null,
				};
			}
			const knownProjectPath = deps.projectRegistry.getProjectPathById(requestedProjectId);
			if (knownProjectPath) {
				return {
					requestedProjectId,
					projectScope: {
						projectId: requestedProjectId,
						projectPath: knownProjectPath,
					},
				};
			}
			const requestedProjectScope = await loadProjectScopeById(requestedProjectId);
			if (!requestedProjectScope) {
				return {
					requestedProjectId,
					projectScope: null,
				};
			}
			deps.projectRegistry.rememberProject(requestedProjectScope.projectId, requestedProjectScope.repoPath);
			return {
				requestedProjectId,
				projectScope: {
					projectId: requestedProjectScope.projectId,
					projectPath: requestedProjectScope.repoPath,
				},
			};
		};

		const getScopedTerminalManager = async (scope: RuntimeTrpcProjectScope): Promise<TerminalSessionManager> =>
			deps.projectRegistry.getTerminalManagerForProject(scope.projectId) ??
			(await deps.projectRegistry.ensureTerminalManagerForProject(scope.projectId, scope.projectPath));
		const prepareNativeResume = async (input: {
			scope: RuntimeTrpcProjectScope;
			taskId: string;
			operationId: string;
			providerSessionId: string;
			provider: "codex" | "claude";
			requiredExistingLaunchPath: string;
		}) => {
			const state = await loadProjectState(input.scope.projectPath);
			const card = findCardInBoard(state.board, input.taskId);
			if (!card) throw new Error("Task no longer exists.");
			return await prepareTaskSessionStart(
				input.scope,
				{
					taskId: card.id,
					launchOperationId: input.operationId,
					prompt: "",
					agentId: input.provider,
					resumeConversation: true,
					awaitReview: true,
					baseRef: card.baseRef,
					useWorktree: card.useWorktree,
				},
				{ config: deps.projectRegistry, getScopedTerminalManager },
				{
					resumeSessionIdOverride: input.providerSessionId,
					requiredExistingLaunchPath: input.requiredExistingLaunchPath,
				},
			);
		};
		const executionOwnership = new TaskExecutionOwnershipService({
			store: executionOwnershipStore,
			structuredOwners,
			getTerminalManager: getScopedTerminalManager,
			prepareNativeResume,
			taskResourceOperations,
			diagnostics: deps.diagnostics,
			assertDurableHistoryAvailable: async (scope, taskId) => {
				const result = await conversationReads.readRecent({ projectId: scope.projectId, taskId, maxMessages: 1 });
				return result.status === "available" || result.status === "degraded";
			},
		});
		const taskInteractions = new TaskInteractionService({
			store: executionOwnershipStore,
			structuredOwners,
			ownership: executionOwnership,
			taskResourceOperations,
		});
		const stopCurrentOwner = async (scope: RuntimeTrpcProjectScope, taskId: string, sessionInstanceId?: string) => {
			if (deps.projectRegistry.getTerminalManagerForProject(scope.projectId)) {
				return await executionOwnership.stopCurrentOwner(scope, taskId, sessionInstanceId);
			}
			const saved = await loadSavedProjectStateById(scope.projectId);
			return {
				summary: saved?.sessions[taskId] ?? null,
				requestedSessionInstanceId: sessionInstanceId ?? null,
				didExit: true,
				outcome: "not_running" as const,
			};
		};
		const projectLocations = new ProjectLocationService({
			runRegistrationMutation,
			operations: taskResourceOperations,
			registry: deps.projectRegistry,
			boardCommands: deps.boardCommands,
			assertRuntimeExclusive: () => assertProjectRelocationRuntimeIsExclusive(deps.diagnostics.runtimeInstanceId),
			stopProject: async (scope) => {
				const manager = deps.projectRegistry.getTerminalManagerForProject(scope.projectId);
				// Startup cleanup has already retired old-runtime processes. A manager is
				// present whenever this runtime owns native, structured, or shell execution.
				if (!manager) return;
				const prepared = await executionOwnership.prepareProjectRemoval(scope);
				if (!prepared.ok) throw new Error(prepared.error ?? "Task execution could not be stopped.");
				manager.stopReconciliation();
				const taskIds = manager.store.listSummaries().map((summary) => summary.taskId);
				manager.markInterruptedAndStopAll();
				await manager.waitForShutdownQuiescence();
				for (const taskId of taskIds) {
					const stopped = await manager.stopTaskSessionAndWaitForExit(taskId);
					if (!stopped.didExit)
						throw new Error(stopped.error ?? "A terminal did not stop. The folder was not changed.");
				}
				await deps.runtimeSessionPersistence.persistRuntimeSessions(scope.projectId);
			},
			suspendProject: async (projectId) => {
				await codeNavigation.stopProject(projectId);
				await deps.runtimeStateHub.suspendProject(projectId);
				await deps.runtimeSessionPersistence.disposeProject(projectId);
			},
			refreshProject: async (projectId, projectPath) => {
				codeNavigation.restoreProject(projectId);
				await deps.runtimeStateHub.refreshProject(projectId, projectPath);
			},
			publishProjects: () =>
				deps.runtimeStateHub.broadcastRuntimeProjectsUpdated(deps.projectRegistry.getActiveProjectId()),
			warn: deps.warn,
		});
		await projectLocations.recoverPendingProjects();
		await deps.initializeProjectsForStartup?.(runProjectOperation);
		deps.projectRegistry.setProjectRemovalPreparationHandler(async (projectId, projectPath) => {
			const result = await executionOwnership.prepareProjectRemoval({ projectId, projectPath });
			if (result.ok) await codeNavigation.stopProject(projectId);
			return result;
		});
		const nativeOwnershipHooks = {
			assertNativeStartAllowed: async (scope: RuntimeTrpcProjectScope, taskId: string) =>
				await executionOwnership.assertNativeStartAllowed(scope, taskId),
			onTaskSessionStarted: async (scope: RuntimeTrpcProjectScope, result: TaskSessionStartServiceResult) => {
				if (!result.summary.resumeSessionId) return;
				await executionOwnership
					.observeNativeOwner(scope, result.summary.taskId, result.terminalManager)
					.catch((error) => {
						serverLog.warn("native execution ownership observation failed", {
							projectId: scope.projectId,
							taskId: result.summary.taskId,
							errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						});
					});
			},
		};
		const ownershipRecoveryEntries = await listProjectIndexEntries();
		for (const entry of ownershipRecoveryEntries) {
			if ((await deps.projectRegistry.checkProjectAvailability(entry.projectId)).status !== "available") continue;
			await executionOwnership
				.recoverProject({ projectId: entry.projectId, projectPath: entry.repoPath })
				.catch((error) => {
					serverLog.warn("structured ownership startup recovery failed", {
						projectId: entry.projectId,
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
					});
				});
		}
		let executionOwnershipReconciliation: Promise<void> | null = null;
		const scheduleExecutionOwnershipReconciliation = (): void => {
			if (executionOwnershipReconciliation) return;
			executionOwnershipReconciliation = (async () => {
				let entries: Awaited<ReturnType<typeof listProjectIndexEntries>>;
				try {
					entries = await listProjectIndexEntries();
				} catch (error) {
					serverLog.warn("structured ownership reconciliation index read failed", {
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
					});
					return;
				}
				for (const entry of entries) {
					await taskResourceOperations
						.runProject(entry.projectId, async () => {
							const current = await loadProjectScopeById(entry.projectId);
							if (!current || !areFileSystemPathsEqual(current.repoPath, entry.repoPath)) return;
							await executionOwnership.reconcileProjectLaunchPaths({
								projectId: entry.projectId,
								projectPath: entry.repoPath,
							});
						})
						.catch((error) => {
							serverLog.warn("structured ownership reconciliation failed", {
								projectId: entry.projectId,
								errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
							});
						});
				}
			})().finally(() => {
				executionOwnershipReconciliation = null;
			});
		};
		let executionOwnershipReconciliationTimer: NodeJS.Timeout | null = null;
		startupCleanup.push(async () => {
			if (executionOwnershipReconciliationTimer) clearInterval(executionOwnershipReconciliationTimer);
			await executionOwnershipReconciliation;
		});
		startupPreparation.push(async () => {
			if (executionOwnershipReconciliationTimer) clearInterval(executionOwnershipReconciliationTimer);
			await executionOwnershipReconciliation;
		});
		const taskTitles = createTaskTitleService({
			boardCommands: deps.boardCommands,
			conversationReads,
			loadBoard: loadProjectBoardById,
			getSessionReader: async (scope) => {
				const manager = await getScopedTerminalManager(scope);
				return (taskId) => manager.store.getSummary(taskId);
			},
			publishTitleUpdated: ({ projectId, taskId, title }) =>
				applyRuntimeMutationEffects(
					deps.runtimeStateHub,
					createTaskTitleUpdatedEffects({ projectId, taskId, title, autoGenerated: true }),
				),
		});
		const codexTitles = createCodexTaskTitleMonitor({
			listManagedProjects: () => deps.projectRegistry.listManagedProjects(),
			loadBoard: loadProjectBoardById,
			boardCommands: deps.boardCommands,
			publishTitleUpdated: ({ projectId, taskId, title }) =>
				applyRuntimeMutationEffects(
					deps.runtimeStateHub,
					createTaskTitleUpdatedEffects({ projectId, taskId, title, autoGenerated: true }),
				),
		});
		startupCleanup.push(() => codexTitles.close());
		startupPreparation.push(() => codexTitles.close());
		const disposeAutomaticTitleListener = deps.boardCommands.subscribeToPostCommitEffects(
			createAutomaticTaskTitlePostCommitListener({
				automaticTitleGeneration,
				boardCommands: deps.boardCommands,
				diagnostics: deps.diagnostics,
				getDefaultAgentId: async (scope) =>
					(await deps.projectRegistry.loadScopedRuntimeConfig(scope)).selectedAgentId,
				publishTitleUpdated: ({ projectId, taskId, title }) =>
					applyRuntimeMutationEffects(
						deps.runtimeStateHub,
						createTaskTitleUpdatedEffects({ projectId, taskId, title, autoGenerated: true }),
					),
			}),
		);
		startupCleanup.push(disposeAutomaticTitleListener);
		startupPreparation.push(disposeAutomaticTitleListener);
		const taskLifecycle = new ProjectTaskLifecycleService({
			boardCommands: deps.boardCommands,
			startTaskSession: async (scope, input) =>
				await handleStartTaskSession(scope, input, {
					runProjectOperation,
					config: deps.projectRegistry,
					getScopedTerminalManager,
					taskResourceOperations,
					...nativeOwnershipHooks,
				}),
			stopTaskSession: async (scope, taskId, sessionInstanceId) => {
				return await taskResourceOperations.run(scope.projectId, taskId, async () => {
					return await stopCurrentOwner(scope, taskId, sessionInstanceId);
				});
			},
			restartStructuredTaskSession: async (scope, taskId, operationId) =>
				await taskResourceOperations.run(
					scope.projectId,
					taskId,
					async () => await executionOwnership.restartStructuredOwner(scope, taskId, operationId),
				),
			onTaskDeleted: async (scope, taskId) => await executionOwnership.removeTask(scope, taskId),
			getTaskSessionSummary: async (scope, taskId) => {
				const manager = await getScopedTerminalManager(scope);
				return manager.store.getSummary(taskId);
			},
			loadState: async (scope) => await deps.projectRegistry.buildProjectStateSnapshot(scope.projectId),
		});
		const recoveryEntries = await listProjectIndexEntries();
		const recoveryResults = await Promise.allSettled(
			recoveryEntries.map(async (entry) => {
				if ((await deps.projectRegistry.checkProjectAvailability(entry.projectId)).status !== "available") return;
				await taskResourceOperations.runProject(entry.projectId, () =>
					taskLifecycle.recover({ projectId: entry.projectId, projectPath: entry.repoPath }),
				);
			}),
		);
		for (const [index, result] of recoveryResults.entries()) {
			if (result.status === "fulfilled") {
				continue;
			}
			serverLog.warn("task lifecycle startup recovery failed for project", {
				projectId: recoveryEntries[index]?.projectId ?? null,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
		const unguardedHooksApi = createHooksApi({
			runProjectOperation,
			projects: deps.projectRegistry,
			terminals: deps.projectRegistry,
			config: deps.projectRegistry,
			persistSessionState: deps.runtimeSessionPersistence.persistRuntimeSessions,
			diagnostics: deps.diagnostics,
			conversationSourceHints,
			observeProgress: progressPreviews.observe,
			onNativeProviderSessionObserved: async ({ scope, taskId, manager }) => {
				await executionOwnership.observeNativeOwner(scope, taskId, manager);
			},
		});
		const hooksApi: RuntimeTrpcContext["hooksApi"] = {
			ingest: async (input) => {
				const scope = await loadProjectScopeById(input.projectId);
				if (!scope) return { ok: false, error: "Project no longer exists." };
				try {
					return await runProjectOperation({ projectId: input.projectId, projectPath: scope.repoPath }, () =>
						unguardedHooksApi.ingest(input),
					);
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
		};
		const hookTransitionOutboxReplayer = createHookTransitionOutboxReplayer({
			ingest: hooksApi.ingest,
			onReplayPassCompleted: ({ pendingTasks }) => {
				void deps.projectRegistry.releaseDeferredStartupRecoveries(pendingTasks).catch((error) => {
					serverLog.warn("deferred startup recovery release failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			},
		});
		startupCleanup.push(() => hookTransitionOutboxReplayer.close());
		startupPreparation.push(() => hookTransitionOutboxReplayer.close());
		const disposeHookOutboxDiagnosticProvider = deps.diagnostics.registerSnapshotProvider({
			name: "hook_outbox",
			capture: (scope) => hookTransitionOutboxReplayer.getDiagnosticSnapshot(scope),
		});
		startupCleanup.push(disposeHookOutboxDiagnosticProvider);
		const disposePiSupportDiagnosticProvider = deps.diagnostics.registerSnapshotProvider({
			name: "pi_support",
			capture: async () => {
				const availability = await getAgentAvailability("pi", {
					allowStale: false,
					forceRefresh: true,
					reuseCachedFailure: false,
				});
				let extensionFingerprint: string | null = null;
				try {
					extensionFingerprint = getPiLifecycleExtensionFingerprint();
				} catch {
					// Doctor reports the missing asset without exposing filesystem details.
				}
				return {
					supportedVersion: SUPPORTED_PI_VERSION,
					detectedVersion: availability.detectedVersion ?? null,
					installed: availability.installed,
					reason: availability.reason,
					transient: availability.transient,
					extensionAvailable: extensionFingerprint !== null,
					extensionFingerprint,
				};
			},
		});
		startupCleanup.push(disposePiSupportDiagnosticProvider);
		const runtimeApi = createRuntimeApi({
			runProjectOperation,
			onCodeNavigationConfigChanged: () => codeNavigation.reset(),
			config: deps.projectRegistry,
			broadcaster: deps.runtimeStateHub,
			getActiveProjectId: deps.projectRegistry.getActiveProjectId,
			getScopedTerminalManager,
			taskResourceOperations,
			resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
			hostIntegrations: deps.hostIntegrations,
			taskLifecycle,
			...nativeOwnershipHooks,
			assertNativeInputAllowed: async (scope, taskId) =>
				await executionOwnership.assertNativeStartAllowed(scope, taskId),
			stopTaskSession: async (scope, taskId, sessionInstanceId) =>
				await stopCurrentOwner(scope, taskId, sessionInstanceId),
		});
		const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const scope = await resolveProjectScopeFromRequest(req, requestUrl);
			const rawClientId = req.headers["x-quarterdeck-client-id"];
			const runtimeClientId = normalizeProjectMetadataClientId(
				Array.isArray(rawClientId) ? rawClientId[0] : rawClientId,
			);
			return {
				runProjectOperation,
				requestedProjectId: scope.requestedProjectId,
				projectScope: scope.projectScope,
				runtimeClientId,
				codeNavigationApi,
				runtimeApi,
				projectApi: createProjectApi({
					taskTitles,
					terminals: deps.projectRegistry,
					broadcaster: deps.runtimeStateHub,
					data: deps.projectRegistry,
					boardCommands: deps.boardCommands,
					diagnostics: deps.diagnostics,
					taskResourceOperations,
				}),
				projectsApi: createProjectsApi({
					runRegistrationMutation,
					runProjectRemoval: (projectId, operation) =>
						taskResourceOperations.runProjectExclusive(projectId, operation),
					projectLocations,
					onProjectAdded: (projectId) => codeNavigation.restoreProject(projectId),
					onProjectRemovalFailed: (projectId) => codeNavigation.restoreProject(projectId),
					boardCommands: deps.boardCommands,
					projects: deps.projectRegistry,
					terminals: deps.projectRegistry,
					broadcaster: deps.runtimeStateHub,
					data: deps.projectRegistry,
					resolveProjectInputPath: deps.resolveProjectInputPath,
					assertPathIsDirectory: deps.assertPathIsDirectory,
					hasGitRepository: deps.hasGitRepository,
					disposeProject: deps.disposeProject,
					prepareProjectRemoval: deps.projectRegistry.prepareProjectRemoval,
					collectProjectWorktreeTaskIdsForRemoval: deps.collectProjectWorktreeTaskIdsForRemoval,
					warn: deps.warn,
					hostIntegrations: deps.hostIntegrations,
				}),
				hooksApi,
			};
		};

		const trpcHttpHandler = createHTTPHandler({
			basePath: "/api/trpc/",
			router: runtimeAppRouter,
			createContext: async ({ req }) => await createTrpcContext(req),
		});

		if (deps.clientAccess) deps.runtimeStateHub.configureNotificationPresentation?.(deps.clientAccess.generation);
		const server = createServer(async (req, res) => {
			try {
				if (shuttingDown) {
					res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Runtime is shutting down.");
					return;
				}
				if (handleHttpRequest(req, res, deps.clientAccess !== undefined).end) {
					return;
				}

				const requestUrl = new URL(req.url ?? "/", "http://localhost");
				const pathname = normalizeRequestPath(requestUrl.pathname);
				requestUrl.pathname = pathname;
				if (
					await deps.clientAccess?.handleHttpRequest(req, res, requestUrl, async (projectPath) => {
						const context = await createTrpcContext(req);
						const result = await context.projectsApi.addProject(null, { path: projectPath });
						if (!result.ok || !result.project) throw new Error("Project could not be opened.");
						return { projectId: result.project.id };
					})
				) {
					return;
				}
				observeRuntimeApiRequest(req, res, pathname, deps.diagnostics);
				if (
					deps.hostEventLedger &&
					(await handleRuntimeHostEventRequest(req, res, requestUrl, deps.hostEventLedger))
				) {
					return;
				}
				if (await handleDiagnosticsHttpRequest(req, res, requestUrl, deps.diagnostics)) {
					return;
				}
				if (pathname === "/api/trpc" || pathname.startsWith("/api/trpc/")) {
					await trpcHttpHandler(req, res);
					return;
				}
				if (pathname.startsWith("/api/")) {
					res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
					res.end('{"error":"Not found"}');
					return;
				}

				const asset = await readAsset(webUiDir, pathname);
				res.writeHead(200, {
					"Content-Type": asset.contentType,
					"Cache-Control": "no-store",
				});
				res.end(asset.content);
			} catch {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not Found");
			}
		});
		startupCleanup.push(async () => {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => {
					if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) rejectClose(error);
					else resolveClose();
				}),
			);
		});
		server.on("upgrade", (request, socket, head) => {
			if (shuttingDown) {
				socket.destroy();
				return;
			}
			if (handleSocketUpgrade(request, socket, deps.clientAccess !== undefined).end) {
				(request as IncomingMessage & { __quarterdeckUpgradeHandled?: boolean }).__quarterdeckUpgradeHandled = true;
				return;
			}
			let requestUrl: URL;
			try {
				requestUrl = new URL(request.url ?? "/", getQuarterdeckRuntimeOrigin());
			} catch {
				socket.destroy();
				return;
			}
			requestUrl.pathname = normalizeRequestPath(requestUrl.pathname);
			if (deps.clientAccess?.handleSocketUpgrade(request, socket, requestUrl)) {
				(request as IncomingMessage & { __quarterdeckUpgradeHandled?: boolean }).__quarterdeckUpgradeHandled = true;
				return;
			}
			(request as IncomingMessage & { __quarterdeckUpgradeAdmitted?: boolean }).__quarterdeckUpgradeAdmitted = true;
			if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
				return;
			}
			(request as IncomingMessage & { __quarterdeckUpgradeHandled?: boolean }).__quarterdeckUpgradeHandled = true;
			const notificationOnly =
				requestUrl.searchParams.get("notificationOnly") === "true" &&
				requestUrl.searchParams.get("notificationPresentation") === "desktop" &&
				deps.clientAccess?.isDesktopSocketAdmitted(request) === true;
			const requestedProjectId = notificationOnly ? null : requestUrl.searchParams.get("projectId")?.trim() || null;
			const clientId = requestUrl.searchParams.get("clientId")?.trim() || null;
			const browserBuildId = requestUrl.searchParams.get("browserBuildId");
			if (!notificationOnly && shouldRejectLegacyRuntimeStreamClient(QUARTERDECK_BUILD_ID, browserBuildId)) {
				deps.diagnostics.recordEvent(
					"browser.runtime_stream_rejected",
					{
						reason: "missing_browser_build_identity",
						runtimeBuildId: QUARTERDECK_BUILD_ID,
					},
					clientId ? { clientId } : {},
					{ level: "warn", essential: true },
				);
				deps.warn("Rejected a legacy browser runtime stream without build identity. Refresh the Quarterdeck page.");
				const body = JSON.stringify({
					error: "Quarterdeck was rebuilt. Refresh this page to load the matching browser application.",
				});
				socket.end(
					[
						"HTTP/1.1 409 Conflict",
						"Connection: close",
						"Cache-Control: no-store",
						"Content-Type: application/json; charset=utf-8",
						`Content-Length: ${Buffer.byteLength(body)}`,
						"",
						body,
					].join("\r\n"),
				);
				return;
			}
			const isDocumentVisible = requestUrl.searchParams.get("documentVisible") !== "false";
			deps.runtimeStateHub.handleUpgrade(request, socket, head, {
				requestedProjectId,
				clientId,
				isDocumentVisible,
				notificationOnly,
			});
		});
		const terminalWebSocketBridge = createTerminalWebSocketBridge({
			server,
			diagnostics: deps.diagnostics,
			resolveTerminalManager: (projectId) => deps.projectRegistry.getTerminalManagerForProject(projectId),
			shouldRecoverStaleSession: async (projectId, taskId) => {
				if (structuredOwners.get(projectId, taskId)) return false;
				const projectPath = deps.projectRegistry.getProjectPathById(projectId);
				if (!projectPath) return false;
				const ownership = await executionOwnership.getOwnership({ projectId, projectPath }, taskId);
				return ownership === null || ownership.state === "native_tui";
			},
			createTaskInputWriter: ({ projectId, taskId, terminalManager }) => {
				const projectPath = deps.projectRegistry.getProjectPathById(projectId);
				const manager = deps.projectRegistry.getTerminalManagerForProject(projectId);
				if (!projectPath || !manager || manager !== terminalManager) {
					return { write: async () => null, dispose: () => {} };
				}
				const scope = { projectId, projectPath };
				const writer = createNativeTerminalInputWriter({
					scope,
					taskId,
					manager,
					authorization: executionOwnershipStore.createNativeInputAuthorization(scope, taskId),
					taskResourceOperations,
					hasStructuredOwner: () => Boolean(structuredOwners.get(projectId, taskId)),
					beforeWrite: async () => {
						// The native writer already owns project admission and task order.
						// Avoid asynchronous checks before reserving that exact PTY's input.
						await assertProjectScope(scope, { allowUnavailable: true });
						if (await readProjectRelocationJournal(projectId)) {
							throw new Error("Project folder relocation is awaiting recovery.");
						}
					},
				});
				return {
					write: (data) => {
						if (shuttingDown) {
							return Promise.reject(
								new TRPCError({ code: "PRECONDITION_FAILED", message: "Runtime is shutting down." }),
							);
						}
						return writer.write(data);
					},
					dispose: () => writer.dispose(),
				};
			},
			stopTaskSession: async ({ projectId, taskId }) => {
				await taskResourceOperations.run(projectId, taskId, async () => {
					const projectPath = deps.projectRegistry.getProjectPathById(projectId);
					if (!projectPath) throw new Error("Project is not available.");
					const stopped = await executionOwnership.stopCurrentOwner({ projectId, projectPath }, taskId);
					if (!stopped.didExit && stopped.outcome !== "not_running") {
						throw new Error(stopped.error ?? "Task execution owner did not stop.");
					}
				});
			},
			isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
			isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
		});
		startupCleanup.push(() => terminalWebSocketBridge.close());
		server.on("upgrade", (request, socket) => {
			const handled = (request as IncomingMessage & { __quarterdeckUpgradeHandled?: boolean })
				.__quarterdeckUpgradeHandled;
			if (handled) {
				return;
			}
			socket.destroy();
		});

		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(deps.listenPort ?? getQuarterdeckRuntimePort(), getQuarterdeckRuntimeHost(), () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});

		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Failed to start local server.");
		}
		const serverPort = typeof address === "object" ? address.port : null;
		if (serverPort === null) throw new Error("Failed to resolve local server port.");
		setQuarterdeckRuntimePort(serverPort);
		await deps.diagnostics.markReady(getQuarterdeckRuntimeHost(), serverPort);
		executionOwnershipReconciliationTimer = setInterval(
			scheduleExecutionOwnershipReconciliation,
			EXECUTION_OWNERSHIP_RECONCILIATION_INTERVAL_MS,
		);
		executionOwnershipReconciliationTimer.unref();
		serverLog.warn("server started", { port: serverPort, pid: process.pid });
		hookTransitionOutboxReplayer.start();
		const activeProjectId = deps.projectRegistry.getActiveProjectId();
		const url = activeProjectId
			? buildQuarterdeckRuntimeUrl(`/${encodeURIComponent(activeProjectId)}`)
			: getQuarterdeckRuntimeOrigin();

		const prepareTaskOwnersForShutdown = createStructuredShutdownPreparation({
			stopReconciliation: () => {
				if (executionOwnershipReconciliationTimer) {
					clearInterval(executionOwnershipReconciliationTimer);
					executionOwnershipReconciliationTimer = null;
				}
			},
			waitForReconciliation: async () => {
				await executionOwnershipReconciliation;
			},
			stopOwners: async () => {
				const failures: unknown[] = [];
				try {
					const entries = await listProjectIndexEntries();
					for (const entry of entries) {
						if (deps.persistenceAllowed?.() === false) break;
						try {
							await executionOwnership.shutdownProject({
								projectId: entry.projectId,
								projectPath: entry.repoPath,
							});
						} catch (error) {
							failures.push(error);
						}
					}
				} catch (error) {
					failures.push(error);
				}
				try {
					const unconfirmedOwnerCount = await structuredOwners.stopAll();
					if (unconfirmedOwnerCount > 0)
						failures.push(new Error("Structured execution owner shutdown remained unconfirmed."));
				} catch (error) {
					failures.push(error);
				}
				if (failures.length > 0) throw new AggregateError(failures, "Execution owner shutdown failed.");
			},
		});
		let preparation: Promise<void> | null = null;
		let shutdownPolicy: Parameters<RuntimeServer["prepareForShutdown"]>[0];
		const prepareForShutdown: RuntimeServer["prepareForShutdown"] = (options) => {
			shuttingDown = true;
			structuredOwners.fenceLaunches();
			codeNavigation.fenceLaunches();
			deps.projectRegistry.stopMaintenance();
			disposeAutomaticTitleListener();
			if (executionOwnershipReconciliationTimer) {
				clearInterval(executionOwnershipReconciliationTimer);
				executionOwnershipReconciliationTimer = null;
			}
			if (preparation) return preparation;
			shutdownPolicy = options;
			preparation = (async () => {
				const producerResults = await Promise.allSettled([
					hookTransitionOutboxReplayer.close(),
					progressPreviews.close(),
					codexTitles.close(),
					automaticTitleGeneration.close(),
					deps.projectRegistry.waitForMaintenance?.(),
					executionOwnershipReconciliation,
				]);
				await Promise.all([taskResourceOperations.waitForIdle(), projectRegistrationOperations.waitForIdle()]);
				// A drained request may have scheduled a detached stale refresh.
				await waitForPendingAgentAvailabilityProbes();
				const failures = producerResults.filter((result) => result.status === "rejected");
				if (failures.length > 0)
					throw new AggregateError(
						failures.map((result) => result.reason),
						"Runtime producer shutdown failed.",
					);
			})();
			return preparation;
		};
		let ownerStop: Promise<void> | null = null;
		const stopTaskOwnersForShutdown: RuntimeServer["stopTaskOwnersForShutdown"] = (options) => {
			ownerStop ??= (async () => {
				const prepared = await Promise.allSettled([prepareForShutdown(options)]);
				const policy = shutdownPolicy ?? options;
				const persistenceAllowed = policy?.persistenceAllowed !== false && deps.persistenceAllowed?.() !== false;
				const ownerResults = await Promise.allSettled([
					codeNavigation.close(),
					prepareTaskOwnersForShutdown({ skipSessionCleanup: policy?.skipSessionCleanup || !persistenceAllowed }),
					!persistenceAllowed
						? (async () => {
								const unconfirmed = await structuredOwners.stopAll();
								if (unconfirmed > 0)
									throw new Error("Structured execution owner shutdown remained unconfirmed.");
							})()
						: Promise.resolve(),
				]);
				const failures = [...prepared, ...ownerResults].filter((result) => result.status === "rejected");
				if (failures.length > 0)
					throw new AggregateError(
						failures.map((result) => result.reason),
						"Runtime owner shutdown failed.",
					);
			})();
			return ownerStop;
		};

		codexTitles.start();
		return {
			url,
			getQuitSummary: () => ({
				liveProcessCount: new Set([
					...deps.projectRegistry
						.listManagedProjects()
						.flatMap(({ terminalManager }) => terminalManager.getOwnedProcessRootPids()),
					...structuredOwners.getOwnedProcessRootPids(),
				]).size,
				pendingLaunches:
					structuredOwners.hasPendingLaunches() ||
					deps.projectRegistry
						.listManagedProjects()
						.some(({ terminalManager }) => terminalManager.hasPendingOwnedProcessLaunches()),
			}),
			executionOwnership,
			taskInteractions,
			prepareForShutdown,
			stopTaskOwnersForShutdown,
			close: async (options) => {
				const closeErrors: unknown[] = [];
				const runCloseStep = async (step: () => void | Promise<void>): Promise<void> => {
					try {
						await step();
					} catch (error) {
						closeErrors.push(error);
					}
				};

				// Fence ingress synchronously before waiting on any producer.
				await runCloseStep(async () => await prepareForShutdown(options));
				await runCloseStep(async () => await stopTaskOwnersForShutdown(options));
				await runCloseStep(() => disposeAutomaticTitleListener());
				await runCloseStep(() => automaticTitleGeneration.close());
				await runCloseStep(() => progressPreviews.close());
				await runCloseStep(() => codexTitles.close());
				await runCloseStep(async () => await hookTransitionOutboxReplayer.close());
				await runCloseStep(() => disposeHookOutboxDiagnosticProvider());
				await runCloseStep(() => disposePiSupportDiagnosticProvider());
				await runCloseStep(() => disposeCodeNavigationDiagnostics());
				await runCloseStep(
					async () =>
						await deps.runtimeSessionPersistence.close({
							skipPersistence: options?.persistenceAllowed === false,
						}),
				);
				await runCloseStep(() => deps.clientAccess?.clear());
				await runCloseStep(async () => await deps.runtimeStateHub.close());
				await runCloseStep(async () => await terminalWebSocketBridge.close());
				await runCloseStep(
					async () =>
						await new Promise<void>((resolveClose, rejectClose) => {
							server.close((error) => {
								if (error) {
									rejectClose(error);
									return;
								}
								resolveClose();
							});
						}),
				);
				await runCloseStep(() => deps.projectRegistry.setProjectRemovalPreparationHandler(null));

				if (closeErrors.length > 0) {
					await deps.diagnostics
						.markFailed(new AggregateError(closeErrors, "One or more runtime shutdown steps failed."))
						.catch(() => undefined);
				}
				await runCloseStep(async () => await deps.diagnostics.close());
				if (closeErrors.length > 0) {
					throw new AggregateError(closeErrors, "One or more runtime shutdown steps failed.");
				}
			},
		};
	} catch (error) {
		shuttingDown = true;
		startupStructuredOwners?.fenceLaunches();
		startupCodeNavigation?.fenceLaunches();
		const cleanup = (async () => {
			const failures: unknown[] = [];
			try {
				deps.projectRegistry.stopMaintenance();
				deps.projectRegistry.setProjectRemovalPreparationHandler(null);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			const prepared = await Promise.allSettled(
				startupPreparation.map((prepare) => Promise.resolve().then(prepare)),
			);
			failures.push(...prepared.filter((result) => result.status === "rejected").map((result) => result.reason));
			await waitForPendingAgentAvailabilityProbes();
			try {
				deps.beforeProcessSnapshot?.();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			const managers = deps.projectRegistry.listManagedProjects().map(({ terminalManager }) => terminalManager);
			for (const manager of managers) {
				try {
					manager.stopReconciliation();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			let ownerStop: Promise<PromiseSettledResult<unknown>[]> | undefined;
			const stopStartupOwners = () => {
				if (ownerStop) return;
				for (const manager of managers) {
					try {
						manager.markInterruptedAndStopAll();
					} catch (cleanupError) {
						failures.push(cleanupError);
					}
				}
				ownerStop = Promise.allSettled([startupStructuredOwners?.stopAll(), startupCodeNavigation?.close()]);
			};
			try {
				const stopped = await stopRuntimeOwnedProcessTrees({
					getRootPids: () => [
						...managers.flatMap((manager) => manager.getOwnedProcessRootPids()),
						...(startupStructuredOwners?.getOwnedProcessRootPids() ?? []),
					],
					hasPendingLaunches: () =>
						(startupStructuredOwners?.hasPendingLaunches() ?? false) ||
						managers.some((manager) => manager.hasPendingOwnedProcessLaunches()),
					includeRuntimeChildren: true,
					stopSessions: stopStartupOwners,
				});
				if (stopped.status !== "stopped")
					failures.push(new Error("Startup-owned process shutdown remained unconfirmed."));
			} catch (cleanupError) {
				failures.push(cleanupError);
			} finally {
				stopStartupOwners();
			}
			for (const result of (await ownerStop) ?? []) {
				if (result.status === "rejected") failures.push(result.reason);
				else if (typeof result.value === "number" && result.value > 0)
					failures.push(new Error("Startup structured owner shutdown remained unconfirmed."));
			}
			for (const dispose of startupCleanup.reverse()) {
				try {
					await dispose();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				await deps.projectRegistry.waitForMaintenance?.();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			return failures;
		})();
		let timeout: NodeJS.Timeout | undefined;
		const failures = await Promise.race([
			cleanup,
			new Promise<unknown[]>((resolve) => {
				timeout = setTimeout(() => resolve([new Error("Runtime startup cleanup deadline exceeded.")]), 7_000);
			}),
		]).catch((cleanupError: unknown) => [cleanupError]);
		if (timeout) clearTimeout(timeout);
		if (failures.length > 0) {
			throw new RuntimeStartupCleanupError(
				{
					status: "incomplete",
					safeToExit: false,
					safeToReleaseOwnership: false,
					reasons: ["quiescence_failed"],
				},
				new AggregateError([error, ...failures], "Runtime startup and cleanup failed."),
			);
		}
		throw error;
	}
}
