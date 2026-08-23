import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { IRuntimeHostIntegrations, RuntimeProjectStateResponse } from "../core";
import {
	buildQuarterdeckRuntimeUrl,
	createTaggedLogger,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	getQuarterdeckRuntimePort,
	TaskResourceOperationCoordinator,
} from "../core";
import { handleDiagnosticsHttpRequest, type RuntimeDiagnostics } from "../diagnostics";
import { createHookTransitionOutboxReplayer } from "../hook-transition-outbox";
import { loadProjectScopeById } from "../state";
import type { TerminalSessionManager } from "../terminal";
import { createTerminalWebSocketBridge } from "../terminal";
import {
	createHooksApi,
	createProjectApi,
	createProjectsApi,
	createRuntimeApi,
	type RuntimeTrpcContext,
	type RuntimeTrpcProjectScope,
	runtimeAppRouter,
} from "../trpc";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import { normalizeProjectMetadataClientId } from "./project-metadata-visibility";
import type { ProjectRegistry } from "./project-registry";
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
	diagnostics: RuntimeDiagnostics;
	warn: (message: string) => void;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	hostIntegrations: IRuntimeHostIntegrations;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => Promise<boolean>;
	disposeProject: (
		projectId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedProjectResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeProjectStateResponse["board"]) => Set<string>;
}

export interface RuntimeServer {
	url: string;
	close: () => Promise<void>;
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
	const webUiDir = getWebUiDir();
	const taskResourceOperations = new TaskResourceOperationCoordinator();

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
	const hooksApi = createHooksApi({
		projects: deps.projectRegistry,
		terminals: deps.projectRegistry,
		config: deps.projectRegistry,
		broadcaster: deps.runtimeStateHub,
		diagnostics: deps.diagnostics,
	});
	const hookTransitionOutboxReplayer = createHookTransitionOutboxReplayer({
		ingest: hooksApi.ingest,
	});
	const disposeHookOutboxDiagnosticProvider = deps.diagnostics.registerSnapshotProvider({
		name: "hook_outbox",
		capture: (scope) => hookTransitionOutboxReplayer.getDiagnosticSnapshot(scope),
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
			}),
			projectApi: createProjectApi({
				terminals: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				data: deps.projectRegistry,
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
		close: async () => {
			try {
				await hookTransitionOutboxReplayer.close();
				disposeHookOutboxDiagnosticProvider();
				await deps.runtimeStateHub.close();
				await terminalWebSocketBridge.close();
				await new Promise<void>((resolveClose, rejectClose) => {
					server.close((error) => {
						if (error) {
							rejectClose(error);
							return;
						}
						resolveClose();
					});
				});
				await deps.diagnostics.close();
			} catch (error) {
				await deps.diagnostics.markFailed(error).catch(() => undefined);
				throw error;
			}
		},
	};
}
