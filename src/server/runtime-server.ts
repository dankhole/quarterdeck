import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { RuntimeCommandRunResponse, RuntimeProjectStateResponse } from "../core";
import {
	buildQuarterdeckRuntimeUrl,
	createTaggedLogger,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	getQuarterdeckRuntimePort,
} from "../core";
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
import type { ProjectRegistry } from "./project-registry";
import type { RuntimeStateHub } from "./runtime-state-hub";

const serverLog = createTaggedLogger("runtime-server");

interface DisposeTrackedProjectResult {
	terminalManager: TerminalSessionManager | null;
	projectPath: string | null;
}

export interface CreateRuntimeServerDependencies {
	projectRegistry: ProjectRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeProject: (
		projectId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedProjectResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeProjectStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => string | null;
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
	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveProjectScopeFromRequest(req, requestUrl);
		return {
			requestedProjectId: scope.requestedProjectId,
			projectScope: scope.projectScope,
			runtimeApi: createRuntimeApi({
				config: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				getActiveProjectId: deps.projectRegistry.getActiveProjectId,
				getScopedTerminalManager,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				runCommand: deps.runCommand,
			}),
			projectApi: createProjectApi({
				terminals: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
				data: deps.projectRegistry,
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
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
			}),
			hooksApi: createHooksApi({
				projects: deps.projectRegistry,
				terminals: deps.projectRegistry,
				broadcaster: deps.runtimeStateHub,
			}),
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);
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
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedProjectId });
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
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
	serverLog.warn("server started", { port: serverPort, pid: process.pid });
	const activeProjectId = deps.projectRegistry.getActiveProjectId();
	const url = activeProjectId
		? buildQuarterdeckRuntimeUrl(`/${encodeURIComponent(activeProjectId)}`)
		: getQuarterdeckRuntimeOrigin();

	return {
		url,
		close: async () => {
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
		},
	};
}
