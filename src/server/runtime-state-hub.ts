// Streams live runtime state to browser clients over websocket.
// It listens to terminal updates, normalizes them into the shared API contract,
// and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type {
	IRuntimeBroadcaster,
	LogLevel,
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
	RuntimeWorkspaceStateResponse,
} from "../core";
import { Disposable, getLogLevel, getRecentLogEntries, onLogEntry, toDisposable } from "../core";
import type { TerminalSessionManager } from "../terminal";
import { RuntimeStateClientRegistry } from "./runtime-state-client-registry";
import { RuntimeStateMessageBatcher } from "./runtime-state-message-batcher";
import {
	buildDebugLogBatchMessage,
	buildDebugLoggingStateMessage,
	buildErrorMessage,
	buildProjectsUpdatedMessage,
	buildSnapshotMessage,
	buildTaskBaseRefUpdatedMessage,
	buildTaskNotificationMessage,
	buildTaskReadyForReviewMessage,
	buildTaskSessionsUpdatedMessage,
	buildTaskTitleUpdatedMessage,
	buildTaskWorkingDirectoryUpdatedMessage,
	buildWorkspaceMetadataUpdatedMessage,
	buildWorkspaceStateUpdatedMessage,
} from "./runtime-state-messages";
import { createWorkspaceMetadataMonitor, type WorkspaceMetadataPollIntervals } from "./workspace-metadata-monitor";
import type { WorkspaceRegistry } from "./workspace-registry";

export interface DisposeRuntimeStateWorkspaceOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		| "resolveWorkspaceForStream"
		| "buildProjectsPayload"
		| "buildWorkspaceStateSnapshot"
		| "resumeInterruptedSessions"
		| "getActiveRuntimeConfig"
	>;
	getActivePollIntervals: () => WorkspaceMetadataPollIntervals;
}

export interface RuntimeStateHub extends IRuntimeBroadcaster {
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
		},
	) => void;
	disposeWorkspace: (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => void;
	close: () => Promise<void>;
}

export class RuntimeStateHubImpl extends Disposable implements RuntimeStateHub {
	private readonly resumeAttempted = new Set<string>();
	private readonly wss: WebSocketServer;
	private readonly clients: RuntimeStateClientRegistry;
	private readonly batcher: RuntimeStateMessageBatcher;
	private readonly metadataMonitor: ReturnType<typeof createWorkspaceMetadataMonitor>;

	constructor(private readonly deps: CreateRuntimeStateHubDependencies) {
		super();

		this.wss = new WebSocketServer({ noServer: true });
		// wss is NOT registered with _register — it requires an async close
		// with a callback to properly drain connections. Handled in close().

		this.clients = new RuntimeStateClientRegistry({
			onWorkspaceClientDisconnected: (workspaceId) => {
				this.metadataMonitor.disconnectWorkspace(workspaceId);
			},
		});

		this.batcher = new RuntimeStateMessageBatcher({
			hasClients: () => this.clients.hasClients,
			onTaskSessionBatch: (workspaceId, summaries) => {
				this.clients.broadcastToWorkspace(workspaceId, buildTaskSessionsUpdatedMessage(workspaceId, summaries));
			},
			onTaskNotificationBatch: (workspaceId, summaries) => {
				this.clients.broadcastToAll(buildTaskNotificationMessage(workspaceId, summaries));
			},
			onProjectsRefreshRequested: (preferredCurrentProjectId) => {
				void this.broadcastRuntimeProjectsUpdated(preferredCurrentProjectId);
			},
			onDebugLogBatch: (entries) => {
				this.clients.broadcastToAll(buildDebugLogBatchMessage(entries));
			},
		});

		this.metadataMonitor = createWorkspaceMetadataMonitor({
			onMetadataUpdated: (workspaceId, workspaceMetadata) => {
				this.clients.broadcastToWorkspace(
					workspaceId,
					buildWorkspaceMetadataUpdatedMessage(workspaceId, workspaceMetadata),
				);
			},
			onTaskBaseRefChanged: (workspaceId, taskId, newBaseRef) => {
				this.broadcastTaskBaseRefUpdated(workspaceId, taskId, newBaseRef);
			},
			getProjectDefaultBaseRef: () => {
				return this.deps.workspaceRegistry.getActiveRuntimeConfig().defaultBaseRef ?? "";
			},
		});
		this._register(toDisposable(() => this.metadataMonitor.close()));

		this._register(
			toDisposable(
				onLogEntry((entry) => {
					this.batcher.queueDebugLogEntry(entry);
				}),
			),
		);

		this.wss.on("connection", (client: WebSocket, context: unknown) => this.handleConnection(client, context));
	}

	// ── Public API (arrow fields for stable `this` when passed as refs) ──

	trackTerminalManager = (workspaceId: string, manager: TerminalSessionManager): void => {
		this.batcher.trackTerminalManager(workspaceId, manager);
	};

	handleUpgrade = (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: { requestedWorkspaceId: string | null },
	): void => {
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			this.wss.emit("connection", ws, context);
		});
	};

	disposeWorkspace = (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions): void => {
		this.batcher.disposeWorkspace(workspaceId);
		this.resumeAttempted.delete(workspaceId);
		this.metadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		this.clients.disconnectWorkspaceClients(workspaceId, {
			closeClientPayload: options.closeClientErrorMessage
				? buildErrorMessage(options.closeClientErrorMessage)
				: undefined,
		});
	};

	broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		const clients = this.clients.getWorkspaceClients(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			const workspaceState = await this.deps.workspaceRegistry.buildWorkspaceStateSnapshot(
				workspaceId,
				workspacePath,
			);
			this.clients.broadcastToWorkspace(workspaceId, buildWorkspaceStateUpdatedMessage(workspaceId, workspaceState));
			await this.metadataMonitor.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			});
		} catch {
			// Ignore transient state read failures; next update will resync.
		}
	};

	broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (!this.clients.hasClients) {
			return;
		}
		try {
			const payload = await this.deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			this.clients.broadcastToAll(buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects));
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	broadcastTaskReadyForReview = (workspaceId: string, taskId: string): void => {
		this.clients.broadcastToWorkspace(workspaceId, buildTaskReadyForReviewMessage(workspaceId, taskId));
	};

	broadcastTaskTitleUpdated = (
		workspaceId: string,
		taskId: string,
		title: string,
		options?: { autoGenerated?: boolean },
	): void => {
		this.clients.broadcastToWorkspace(workspaceId, buildTaskTitleUpdatedMessage(workspaceId, taskId, title, options));
	};

	broadcastTaskBaseRefUpdated = (workspaceId: string, taskId: string, baseRef: string): void => {
		this.clients.broadcastToWorkspace(workspaceId, buildTaskBaseRefUpdatedMessage(workspaceId, taskId, baseRef));
	};

	broadcastTaskWorkingDirectoryUpdated = (
		workspaceId: string,
		taskId: string,
		workingDirectory: string,
		useWorktree: boolean,
	): void => {
		this.clients.broadcastToWorkspace(
			workspaceId,
			buildTaskWorkingDirectoryUpdatedMessage(workspaceId, taskId, workingDirectory, useWorktree),
		);
	};

	setFocusedTask = (workspaceId: string, taskId: string | null): void => {
		this.metadataMonitor.setFocusedTask(workspaceId, taskId);
	};

	requestTaskRefresh = (workspaceId: string, taskId: string): void => {
		this.metadataMonitor.requestTaskRefresh(workspaceId, taskId);
	};

	requestHomeRefresh = (workspaceId: string): void => {
		this.metadataMonitor.requestHomeRefresh(workspaceId);
	};

	setPollIntervals = (workspaceId: string, intervals: WorkspaceMetadataPollIntervals): void => {
		this.metadataMonitor.setPollIntervals(workspaceId, intervals);
	};

	broadcastLogLevel = (level: LogLevel): void => {
		this.clients.broadcastToAll(buildDebugLoggingStateMessage(level, getRecentLogEntries()));
	};

	close = async (): Promise<void> => {
		// Dispose base class resources (metadata monitor, debug log subscription)
		this.dispose();
		this.batcher.close();
		this.clients.terminateAllClients();

		// Wait for the WebSocketServer to finish closing (must be last —
		// it needs connections terminated first for a clean shutdown).
		await new Promise<void>((resolveClose) => {
			this.wss.close(() => {
				resolveClose();
			});
		});
	};

	// ── Private helpers ───────────────────────────────────────────────────

	private async handleConnection(client: WebSocket, context: unknown): Promise<void> {
		client.on("close", () => {
			this.clients.removeClient(client);
		});

		try {
			const requestedWorkspaceId = this.parseWorkspaceId(context);
			const workspace = await this.deps.workspaceRegistry.resolveWorkspaceForStream(requestedWorkspaceId, {
				onRemovedWorkspace: ({ workspaceId, message }) => {
					this.disposeWorkspace(workspaceId, {
						disconnectClients: true,
						closeClientErrorMessage: message,
					});
				},
			});
			if (client.readyState !== WebSocket.OPEN) {
				this.clients.removeClient(client);
				return;
			}

			this.clients.registerGlobalClient(client);
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				const snapshot = await this.loadInitialSnapshot(workspace);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				this.sendMessage(
					client,
					buildSnapshotMessage(snapshot.currentProjectId, snapshot.projects, snapshot.workspaceState),
				);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				monitorWorkspaceId = snapshot.workspaceId;
				if (monitorWorkspaceId) {
					this.clients.registerWorkspaceClient(monitorWorkspaceId, client);
				}

				if (snapshot.workspaceId && snapshot.workspacePath && snapshot.workspaceState) {
					didConnectWorkspaceMonitor = true;
					void this.metadataMonitor
						.connectWorkspace({
							workspaceId: snapshot.workspaceId,
							workspacePath: snapshot.workspacePath,
							board: snapshot.workspaceState.board,
							pollIntervals: this.deps.getActivePollIntervals(),
						})
						.catch(() => {
							// Non-fatal: metadata arrives on the next poll cycle.
						});
				}

				this.sendMessage(client, buildDebugLoggingStateMessage(getLogLevel(), getRecentLogEntries()));

				if (workspace.removedRequestedWorkspacePath) {
					this.sendMessage(
						client,
						buildErrorMessage(
							`Project no longer exists on disk and was removed: ${workspace.removedRequestedWorkspacePath}`,
						),
					);
				}
				if (workspace.didPruneProjects) {
					void this.broadcastRuntimeProjectsUpdated(workspace.workspaceId);
				}
				if (snapshot.workspaceId && snapshot.workspacePath && !this.resumeAttempted.has(snapshot.workspaceId)) {
					this.resumeAttempted.add(snapshot.workspaceId);
					void this.deps.workspaceRegistry.resumeInterruptedSessions(snapshot.workspaceId, snapshot.workspacePath);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					this.metadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				this.sendMessage(client, buildErrorMessage(message));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendMessage(client, buildErrorMessage(message));
			client.close();
		}
	}

	private async loadInitialSnapshot(workspace: { workspaceId: string | null; workspacePath: string | null }): Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
		workspaceId: string | null;
		workspacePath: string | null;
		workspaceState: RuntimeWorkspaceStateResponse | null;
	}> {
		if (workspace.workspaceId && workspace.workspacePath) {
			const [projectsPayload, workspaceState] = await Promise.all([
				this.deps.workspaceRegistry.buildProjectsPayload(workspace.workspaceId),
				this.deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.workspaceId, workspace.workspacePath),
			]);
			return {
				currentProjectId: projectsPayload.currentProjectId,
				projects: projectsPayload.projects,
				workspaceId: workspace.workspaceId,
				workspacePath: workspace.workspacePath,
				workspaceState,
			};
		}

		const projectsPayload = await this.deps.workspaceRegistry.buildProjectsPayload(null);
		return {
			currentProjectId: projectsPayload.currentProjectId,
			projects: projectsPayload.projects,
			workspaceId: null,
			workspacePath: null,
			workspaceState: null,
		};
	}

	private sendMessage(client: WebSocket, payload: RuntimeStateStreamMessage): void {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	}

	private parseWorkspaceId(context: unknown): string | null {
		if (
			typeof context === "object" &&
			context !== null &&
			"requestedWorkspaceId" in context &&
			typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
		) {
			return (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null;
		}
		return null;
	}
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	return new RuntimeStateHubImpl(deps);
}
