// Streams live runtime state to browser clients over websocket.
// It listens to terminal updates, normalizes them into the shared API contract,
// and fans out project-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type {
	IRuntimeBroadcaster,
	LogLevel,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
} from "../core";
import { Disposable, getLogLevel, getRecentLogEntries, onLogEntry, toDisposable } from "../core";
import type { TerminalSessionManager } from "../terminal";
import { applyRuntimeMutationEffects, createTaskBaseRefUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { createProjectMetadataMonitor, type ProjectMetadataPollIntervals } from "./project-metadata-monitor";
import type { ProjectRegistry } from "./project-registry";
import { RuntimeStateClientRegistry } from "./runtime-state-client-registry";
import { RuntimeStateMessageBatcher } from "./runtime-state-message-batcher";
import {
	buildDebugLogBatchMessage,
	buildDebugLoggingStateMessage,
	buildErrorMessage,
	buildProjectMetadataUpdatedMessage,
	buildProjectStateUpdatedMessage,
	buildProjectsUpdatedMessage,
	buildSnapshotMessage,
	buildTaskBaseRefUpdatedMessage,
	buildTaskNotificationMessage,
	buildTaskReadyForReviewMessage,
	buildTaskSessionsUpdatedMessage,
	buildTaskTitleUpdatedMessage,
	buildTaskWorkingDirectoryUpdatedMessage,
} from "./runtime-state-messages";

export interface DisposeRuntimeStateProjectOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	projectRegistry: Pick<
		ProjectRegistry,
		| "resolveProjectForStream"
		| "buildProjectsPayload"
		| "buildProjectStateSnapshot"
		| "resumeInterruptedSessions"
		| "getActiveRuntimeConfig"
	>;
	getActivePollIntervals: () => ProjectMetadataPollIntervals;
}

export interface RuntimeStateHub extends IRuntimeBroadcaster {
	trackTerminalManager: (projectId: string, manager: TerminalSessionManager) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedProjectId: string | null;
		},
	) => void;
	disposeProject: (projectId: string, options?: DisposeRuntimeStateProjectOptions) => void;
	close: () => Promise<void>;
}

export class RuntimeStateHubImpl extends Disposable implements RuntimeStateHub {
	private readonly resumeAttempted = new Set<string>();
	private readonly wss: WebSocketServer;
	private readonly clients: RuntimeStateClientRegistry;
	private readonly batcher: RuntimeStateMessageBatcher;
	private readonly metadataMonitor: ReturnType<typeof createProjectMetadataMonitor>;

	constructor(private readonly deps: CreateRuntimeStateHubDependencies) {
		super();

		this.wss = new WebSocketServer({ noServer: true });
		// wss is NOT registered with _register — it requires an async close
		// with a callback to properly drain connections. Handled in close().

		this.clients = new RuntimeStateClientRegistry({
			onProjectClientDisconnected: (projectId) => {
				this.metadataMonitor.disconnectProject(projectId);
			},
		});

		this.batcher = new RuntimeStateMessageBatcher({
			hasClients: () => this.clients.hasClients,
			onTaskSessionBatch: (projectId, summaries) => {
				this.clients.broadcastToProject(projectId, buildTaskSessionsUpdatedMessage(projectId, summaries));
			},
			onTaskNotificationBatch: (projectId, summaries) => {
				this.clients.broadcastToAll(buildTaskNotificationMessage(projectId, summaries));
			},
			onProjectsRefreshRequested: (preferredCurrentProjectId) => {
				void this.broadcastRuntimeProjectsUpdated(preferredCurrentProjectId);
			},
			onDebugLogBatch: (entries) => {
				this.clients.broadcastToAll(buildDebugLogBatchMessage(entries));
			},
		});

		this.metadataMonitor = createProjectMetadataMonitor({
			onMetadataUpdated: (projectId, projectMetadata) => {
				this.clients.broadcastToProject(projectId, buildProjectMetadataUpdatedMessage(projectId, projectMetadata));
			},
			onTaskBaseRefChanged: (projectId, taskId, newBaseRef) => {
				void applyRuntimeMutationEffects(
					this,
					createTaskBaseRefUpdatedEffects({
						projectId,
						taskId,
						baseRef: newBaseRef,
					}),
				);
			},
			getProjectDefaultBaseRef: () => {
				return this.deps.projectRegistry.getActiveRuntimeConfig().defaultBaseRef ?? "";
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

	trackTerminalManager = (projectId: string, manager: TerminalSessionManager): void => {
		this.batcher.trackTerminalManager(projectId, manager);
	};

	handleUpgrade = (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: { requestedProjectId: string | null },
	): void => {
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			this.wss.emit("connection", ws, context);
		});
	};

	disposeProject = (projectId: string, options?: DisposeRuntimeStateProjectOptions): void => {
		this.batcher.disposeProject(projectId);
		this.resumeAttempted.delete(projectId);
		this.metadataMonitor.disposeProject(projectId);

		if (!options?.disconnectClients) {
			return;
		}

		this.clients.disconnectProjectClients(projectId, {
			closeClientPayload: options.closeClientErrorMessage
				? buildErrorMessage(options.closeClientErrorMessage)
				: undefined,
		});
	};

	broadcastRuntimeProjectStateUpdated = async (projectId: string, projectPath: string): Promise<void> => {
		const clients = this.clients.getProjectClients(projectId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			const projectState = await this.deps.projectRegistry.buildProjectStateSnapshot(projectId, projectPath);
			this.clients.broadcastToProject(projectId, buildProjectStateUpdatedMessage(projectId, projectState));
			await this.metadataMonitor.updateProjectState({
				projectId,
				projectPath,
				board: projectState.board,
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
			const payload = await this.deps.projectRegistry.buildProjectsPayload(preferredCurrentProjectId);
			this.clients.broadcastToAll(buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects));
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	broadcastTaskReadyForReview = (projectId: string, taskId: string): void => {
		this.clients.broadcastToProject(projectId, buildTaskReadyForReviewMessage(projectId, taskId));
	};

	broadcastTaskTitleUpdated = (
		projectId: string,
		taskId: string,
		title: string,
		options?: { autoGenerated?: boolean },
	): void => {
		this.clients.broadcastToProject(projectId, buildTaskTitleUpdatedMessage(projectId, taskId, title, options));
	};

	broadcastTaskBaseRefUpdated = (projectId: string, taskId: string, baseRef: string): void => {
		this.clients.broadcastToProject(projectId, buildTaskBaseRefUpdatedMessage(projectId, taskId, baseRef));
	};

	broadcastTaskWorkingDirectoryUpdated = (
		projectId: string,
		taskId: string,
		workingDirectory: string,
		useWorktree: boolean,
	): void => {
		this.clients.broadcastToProject(
			projectId,
			buildTaskWorkingDirectoryUpdatedMessage(projectId, taskId, workingDirectory, useWorktree),
		);
	};

	setFocusedTask = (projectId: string, taskId: string | null): void => {
		this.metadataMonitor.setFocusedTask(projectId, taskId);
	};

	requestTaskRefresh = (projectId: string, taskId: string): void => {
		this.metadataMonitor.requestTaskRefresh(projectId, taskId);
	};

	requestHomeRefresh = (projectId: string): void => {
		this.metadataMonitor.requestHomeRefresh(projectId);
	};

	setPollIntervals = (projectId: string, intervals: ProjectMetadataPollIntervals): void => {
		this.metadataMonitor.setPollIntervals(projectId, intervals);
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
			const requestedProjectId = this.parseProjectId(context);
			const resolved = await this.deps.projectRegistry.resolveProjectForStream(requestedProjectId, {
				onRemovedProject: ({ projectId, message }) => {
					this.disposeProject(projectId, {
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
			let monitorProjectId: string | null = null;
			let didConnectProjectMonitor = false;

			try {
				const snapshot = await this.loadInitialSnapshot(resolved);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				this.sendMessage(
					client,
					buildSnapshotMessage(snapshot.currentProjectId, snapshot.projects, snapshot.projectState),
				);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				monitorProjectId = snapshot.projectId;
				if (monitorProjectId) {
					this.clients.registerProjectClient(monitorProjectId, client);
				}

				if (snapshot.projectId && snapshot.projectPath && snapshot.projectState) {
					didConnectProjectMonitor = true;
					void this.metadataMonitor
						.connectProject({
							projectId: snapshot.projectId,
							projectPath: snapshot.projectPath,
							board: snapshot.projectState.board,
							pollIntervals: this.deps.getActivePollIntervals(),
						})
						.catch(() => {
							// Non-fatal: metadata arrives on the next poll cycle.
						});
				}

				this.sendMessage(client, buildDebugLoggingStateMessage(getLogLevel(), getRecentLogEntries()));

				if (resolved.removedRequestedProjectPath) {
					this.sendMessage(
						client,
						buildErrorMessage(
							`Project no longer exists on disk and was removed: ${resolved.removedRequestedProjectPath}`,
						),
					);
				}
				if (resolved.didPruneProjects) {
					void this.broadcastRuntimeProjectsUpdated(resolved.projectId);
				}
				if (snapshot.projectId && snapshot.projectPath && !this.resumeAttempted.has(snapshot.projectId)) {
					this.resumeAttempted.add(snapshot.projectId);
					void this.deps.projectRegistry.resumeInterruptedSessions(snapshot.projectId, snapshot.projectPath);
				}
			} catch (error) {
				if (didConnectProjectMonitor && monitorProjectId) {
					this.metadataMonitor.disconnectProject(monitorProjectId);
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

	private async loadInitialSnapshot(resolved: { projectId: string | null; projectPath: string | null }): Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
		projectId: string | null;
		projectPath: string | null;
		projectState: RuntimeProjectStateResponse | null;
	}> {
		if (resolved.projectId && resolved.projectPath) {
			const [projectsPayload, projectState] = await Promise.all([
				this.deps.projectRegistry.buildProjectsPayload(resolved.projectId),
				this.deps.projectRegistry.buildProjectStateSnapshot(resolved.projectId, resolved.projectPath),
			]);
			return {
				currentProjectId: projectsPayload.currentProjectId,
				projects: projectsPayload.projects,
				projectId: resolved.projectId,
				projectPath: resolved.projectPath,
				projectState,
			};
		}

		const projectsPayload = await this.deps.projectRegistry.buildProjectsPayload(null);
		return {
			currentProjectId: projectsPayload.currentProjectId,
			projects: projectsPayload.projects,
			projectId: null,
			projectPath: null,
			projectState: null,
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

	private parseProjectId(context: unknown): string | null {
		if (
			typeof context === "object" &&
			context !== null &&
			"requestedProjectId" in context &&
			typeof (context as { requestedProjectId?: unknown }).requestedProjectId === "string"
		) {
			return (context as { requestedProjectId: string }).requestedProjectId || null;
		}
		return null;
	}
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	return new RuntimeStateHubImpl(deps);
}
