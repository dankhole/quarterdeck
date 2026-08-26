import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { getAgentAvailability, SUPPORTED_PI_VERSION } from "../config";
import {
	type ConversationReadService,
	ConversationSourceHintStore,
	type ConversationTaskSessionResolver,
	createConversationReadService,
} from "../conversation/index.js";
import type { IRuntimeHostIntegrations, RuntimeProjectStateResponse } from "../core";
import {
	buildQuarterdeckRuntimeUrl,
	createTaggedLogger,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	getQuarterdeckRuntimePort,
	QUARTERDECK_BUILD_ID,
	shouldRejectLegacyRuntimeStreamClient,
	TaskResourceOperationCoordinator,
} from "../core";
import { handleDiagnosticsHttpRequest, type RuntimeDiagnostics } from "../diagnostics";
import { createHookTransitionOutboxReplayer } from "../hook-transition-outbox";
import type { ProjectBoardCommandService } from "../state";
import { listProjectIndexEntries, loadProjectScopeById } from "../state";
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
import { handleStartTaskSession } from "../trpc/handlers/start-task-session";
import { applyRuntimeMutationEffects, createTaskTitleUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { createAutomaticTaskTitlePostCommitListener } from "./automatic-task-title-scheduler";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import { normalizeProjectMetadataClientId } from "./project-metadata-visibility";
import type { ProjectRegistry } from "./project-registry";
import { ProjectTaskLifecycleService } from "./project-task-lifecycle-service";
import { handleRuntimeHostEventRequest } from "./runtime-host-event-endpoint";
import type { RuntimeHostEventLedger } from "./runtime-host-event-ledger";
import { observeRuntimeApiRequest } from "./runtime-request-diagnostics";
import type { RuntimeStateHub } from "./runtime-state-hub";

const serverLog = createTaggedLogger("runtime-server");

interface DisposeTrackedProjectResult {
	terminalManager: TerminalSessionManager | null;
	projectPath: string | null;
}

export interface CreateRuntimeServerDependencies {
	projectRegistry: ProjectRegistry;
	runtimeStateHub: RuntimeStateHub;
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
	/** Internal read-only boundary for later remote projection and task interaction composition. */
	conversationReads: ConversationReadService;
	close: () => Promise<void>;
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
	const webUiDir = getWebUiDir();
	const taskResourceOperations = new TaskResourceOperationCoordinator();
	const automaticTitleGeneration = new AutomaticTitleGenerationCoordinator();
	const conversationSourceHints = new ConversationSourceHintStore();
	const conversationReads = createConversationReadService({
		sessions: createRuntimeConversationTaskSessionResolver(deps.projectRegistry),
		hints: conversationSourceHints,
	});

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

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
		await deps.projectRegistry.ensureTerminalManagerForProject(scope.projectId, scope.projectPath);
	const disposeAutomaticTitleListener = deps.boardCommands.subscribeToPostCommitEffects(
		createAutomaticTaskTitlePostCommitListener({
			automaticTitleGeneration,
			boardCommands: deps.boardCommands,
			diagnostics: deps.diagnostics,
			publishTitleUpdated: ({ projectId, taskId, title }) =>
				applyRuntimeMutationEffects(
					deps.runtimeStateHub,
					createTaskTitleUpdatedEffects({ projectId, taskId, title, autoGenerated: true }),
				),
		}),
	);
	const taskLifecycle = new ProjectTaskLifecycleService({
		boardCommands: deps.boardCommands,
		startTaskSession: async (scope, input) =>
			await handleStartTaskSession(scope, input, {
				config: deps.projectRegistry,
				getScopedTerminalManager,
				taskResourceOperations,
			}),
		stopTaskSession: async (scope, taskId, sessionInstanceId) => {
			return await taskResourceOperations.run(scope.projectId, taskId, async () => {
				const manager = await getScopedTerminalManager(scope);
				return await manager.stopTaskSessionAndWaitForExit(taskId, 3_000, sessionInstanceId);
			});
		},
		getTaskSessionSummary: async (scope, taskId) => {
			const manager = await getScopedTerminalManager(scope);
			return manager.store.getSummary(taskId);
		},
		loadState: async (scope) =>
			await deps.projectRegistry.buildProjectStateSnapshot(scope.projectId, scope.projectPath),
	});
	const recoveryEntries = await listProjectIndexEntries();
	const recoveryResults = await Promise.allSettled(
		recoveryEntries.map(
			async (entry) => await taskLifecycle.recover({ projectId: entry.projectId, projectPath: entry.repoPath }),
		),
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
	const hooksApi = createHooksApi({
		projects: deps.projectRegistry,
		terminals: deps.projectRegistry,
		config: deps.projectRegistry,
		persistSessionState: deps.runtimeStateHub.persistRuntimeSessions,
		diagnostics: deps.diagnostics,
		conversationSourceHints,
	});
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
	const disposeHookOutboxDiagnosticProvider = deps.diagnostics.registerSnapshotProvider({
		name: "hook_outbox",
		capture: (scope) => hookTransitionOutboxReplayer.getDiagnosticSnapshot(scope),
	});
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
	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveProjectScopeFromRequest(req, requestUrl);
		const rawClientId = req.headers["x-quarterdeck-client-id"];
		const runtimeClientId = normalizeProjectMetadataClientId(
			Array.isArray(rawClientId) ? rawClientId[0] : rawClientId,
		);
		return {
			requestedProjectId: scope.requestedProjectId,
			projectScope: scope.projectScope,
			runtimeClientId,
			runtimeApi: createRuntimeApi({
				config: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				getActiveProjectId: deps.projectRegistry.getActiveProjectId,
				getScopedTerminalManager,
				taskResourceOperations,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				hostIntegrations: deps.hostIntegrations,
				taskLifecycle,
			}),
			projectApi: createProjectApi({
				terminals: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				data: deps.projectRegistry,
				boardCommands: deps.boardCommands,
				diagnostics: deps.diagnostics,
				taskResourceOperations,
			}),
			projectsApi: createProjectsApi({
				projects: deps.projectRegistry,
				terminals: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				data: deps.projectRegistry,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				disposeProject: deps.disposeProject,
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

	const server = createServer(async (req, res) => {
		try {
			if (handleHttpRequest(req, res).end) {
				return;
			}

			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);
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
			if (pathname.startsWith("/api/trpc")) {
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
	server.on("upgrade", (request, socket, head) => {
		if (handleSocketUpgrade(request, socket).end) {
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
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		(request as IncomingMessage & { __quarterdeckUpgradeHandled?: boolean }).__quarterdeckUpgradeHandled = true;
		const requestedProjectId = requestUrl.searchParams.get("projectId")?.trim() || null;
		const clientId = requestUrl.searchParams.get("clientId")?.trim() || null;
		const browserBuildId = requestUrl.searchParams.get("browserBuildId");
		if (shouldRejectLegacyRuntimeStreamClient(QUARTERDECK_BUILD_ID, browserBuildId)) {
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
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedProjectId, clientId, isDocumentVisible });
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		diagnostics: deps.diagnostics,
		resolveTerminalManager: (projectId) => deps.projectRegistry.getTerminalManagerForProject(projectId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
	});
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
		server.listen(getQuarterdeckRuntimePort(), getQuarterdeckRuntimeHost(), () => {
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
	await deps.diagnostics.markReady(getQuarterdeckRuntimeHost(), serverPort);
	serverLog.warn("server started", { port: serverPort, pid: process.pid });
	hookTransitionOutboxReplayer.start();
	const activeProjectId = deps.projectRegistry.getActiveProjectId();
	const url = activeProjectId
		? buildQuarterdeckRuntimeUrl(`/${encodeURIComponent(activeProjectId)}`)
		: getQuarterdeckRuntimeOrigin();

	return {
		url,
		conversationReads,
		close: async () => {
			const closeErrors: unknown[] = [];
			const runCloseStep = async (step: () => void | Promise<void>): Promise<void> => {
				try {
					await step();
				} catch (error) {
					closeErrors.push(error);
				}
			};

			await runCloseStep(() => disposeAutomaticTitleListener());
			await runCloseStep(async () => await hookTransitionOutboxReplayer.close());
			await runCloseStep(() => disposeHookOutboxDiagnosticProvider());
			await runCloseStep(() => disposePiSupportDiagnosticProvider());
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
}
