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
	RuntimeTaskSessionSummary,
} from "../core";
import {
	createTaggedLogger,
	Disposable,
	getLogLevel,
	getRecentLogEntries,
	onLogEntry,
	pruneOrphanSessionsForNotification,
	toDisposable,
} from "../core";
import { loadProjectBoardById } from "../state";
import type { TerminalSessionManager } from "../terminal";
import { applyRuntimeMutationEffects, createTaskBaseRefUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { createProjectMetadataMonitor } from "./project-metadata-monitor";
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
} from "./runtime-state-messages";

const hubLog = createTaggedLogger("runtime-state-hub");

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
		| "listManagedProjects"
	>;
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
				void this.broadcastTaskNotifications(projectId, summaries);
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

		if (options.closeClientErrorMessage) {
			hubLog.warn(options.closeClientErrorMessage, { projectId });
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
			void this.metadataMonitor
				.updateProjectState({
					projectId,
					projectPath,
					board: projectState.board,
				})
				.catch(() => {
					// Metadata is eventual; the next scheduled/manual refresh will resync.
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

	setFocusedTask = (projectId: string, taskId: string | null): void => {
		this.metadataMonitor.setFocusedTask(projectId, taskId);
	};

	setDocumentVisible = (projectId: string, isDocumentVisible: boolean): void => {
		this.metadataMonitor.setDocumentVisible(projectId, isDocumentVisible);
	};

	requestTaskRefresh = (projectId: string, taskId: string): void => {
		this.metadataMonitor.requestTaskRefresh(projectId, taskId);
	};

	requestHomeRefresh = (projectId: string): void => {
		this.metadataMonitor.requestHomeRefresh(projectId);
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
					buildSnapshotMessage(
						snapshot.currentProjectId,
						snapshot.projects,
						snapshot.projectState,
						snapshot.notificationSummariesByProject,
					),
				);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				monitorProjectId = snapshot.projectId;
				if (monitorProjectId) {
					this.clients.registerProjectClient(monitorProjectId, client);
				}

				if (snapshot.projectStateError) {
					hubLog.error("Failed to load initial project state for client", {
						projectId: snapshot.projectId,
						projectPath: snapshot.projectPath,
						message: snapshot.projectStateError,
					});
					this.sendMessage(client, buildErrorMessage(snapshot.projectStateError));
				}

				if (snapshot.projectId && snapshot.projectPath && snapshot.projectState) {
					didConnectProjectMonitor = true;
					void this.metadataMonitor
						.connectProject({
							projectId: snapshot.projectId,
							projectPath: snapshot.projectPath,
							board: snapshot.projectState.board,
						})
						.catch(() => {
							// Non-fatal: metadata arrives on the next poll cycle.
						});
				}

				this.sendMessage(client, buildDebugLoggingStateMessage(getLogLevel(), getRecentLogEntries()));

				if (resolved.removedRequestedProjectPath) {
					const message = `Project no longer exists on disk and was removed: ${resolved.removedRequestedProjectPath}`;
					hubLog.warn(message);
					this.sendMessage(client, buildErrorMessage(message));
				}
				if (resolved.didPruneProjects) {
					void this.broadcastRuntimeProjectsUpdated(resolved.projectId);
				}
				if (
					snapshot.projectId &&
					snapshot.projectPath &&
					snapshot.projectState &&
					!this.resumeAttempted.has(snapshot.projectId)
				) {
					this.resumeAttempted.add(snapshot.projectId);
					void this.deps.projectRegistry.resumeInterruptedSessions(snapshot.projectId, snapshot.projectPath);
				}
			} catch (error) {
				if (didConnectProjectMonitor && monitorProjectId) {
					this.metadataMonitor.disconnectProject(monitorProjectId);
				}
				const message = error instanceof Error ? error.message : String(error);
				hubLog.error("Failed to load initial snapshot for client", { message, error });
				this.sendMessage(client, buildErrorMessage(message));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			hubLog.error("Failed to resolve project for client connection", { message, error });
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
		projectStateError: string | null;
		notificationSummariesByProject: Record<string, RuntimeTaskSessionSummary[]>;
	}> {
		if (resolved.projectId && resolved.projectPath) {
			const projectsPayload = await this.deps.projectRegistry.buildProjectsPayload(resolved.projectId);
			let projectState: RuntimeProjectStateResponse | null = null;
			let projectStateError: string | null = null;
			try {
				projectState = await this.deps.projectRegistry.buildProjectStateSnapshot(
					resolved.projectId,
					resolved.projectPath,
				);
			} catch (error) {
				projectStateError = error instanceof Error ? error.message : String(error);
			}
			const notificationSummariesByProject = await this.collectNotificationSummariesByProject();
			return {
				currentProjectId: projectsPayload.currentProjectId,
				projects: projectsPayload.projects,
				projectId: resolved.projectId,
				projectPath: resolved.projectPath,
				projectState,
				projectStateError,
				notificationSummariesByProject,
			};
		}

		const projectsPayload = await this.deps.projectRegistry.buildProjectsPayload(null);
		const notificationSummariesByProject = await this.collectNotificationSummariesByProject();
		return {
			currentProjectId: projectsPayload.currentProjectId,
			projects: projectsPayload.projects,
			projectId: null,
			projectPath: null,
			projectState: null,
			projectStateError: null,
			notificationSummariesByProject,
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

	private async broadcastTaskNotifications(projectId: string, summaries: RuntimeTaskSessionSummary[]): Promise<void> {
		if (summaries.length === 0) {
			return;
		}
		try {
			const board = await loadProjectBoardById(projectId);
			const summaryMap = Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
			const pruned = pruneOrphanSessionsForNotification(summaryMap, board);
			const prunedSummaries = Object.values(pruned);
			const removedTaskIds = summaries.map((summary) => summary.taskId).filter((taskId) => !(taskId in pruned));
			if (prunedSummaries.length === 0 && removedTaskIds.length === 0) {
				return;
			}
			this.clients.broadcastToAll(buildTaskNotificationMessage(projectId, prunedSummaries, { removedTaskIds }));
		} catch {
			// Board read failed — keep live notifications flowing. The next
			// authoritative snapshot/project-state update will repair stale entries.
			this.clients.broadcastToAll(buildTaskNotificationMessage(projectId, summaries));
		}
	}

	private async collectNotificationSummariesByProject(): Promise<Record<string, RuntimeTaskSessionSummary[]>> {
		const managedProjects = this.deps.projectRegistry.listManagedProjects();
		const projectEntries = await Promise.all(
			managedProjects.map(async (project) => {
				const summaries = project.terminalManager.store.listSummaries();
				if (summaries.length === 0) {
					return null;
				}
				// Filter out summaries whose cards are no longer on the board.
				// Without this, the connect-time notification snapshot grows in
				// proportion to every task ever run in the project.
				try {
					const board = await loadProjectBoardById(project.projectId);
					const summaryMap = Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
					const pruned = pruneOrphanSessionsForNotification(summaryMap, board);
					const prunedList = Object.values(pruned);
					if (prunedList.length === 0) {
						return {
							projectId: project.projectId,
							summaries: prunedList,
						};
					}
					return {
						projectId: project.projectId,
						summaries: prunedList,
					};
				} catch {
					// Board read failed — fall back to full list rather than
					// silently dropping notifications.
					return {
						projectId: project.projectId,
						summaries,
					};
				}
			}),
		);
		const summariesByProject: Record<string, RuntimeTaskSessionSummary[]> = {};
		for (const entry of projectEntries) {
			if (!entry) {
				continue;
			}
			if (entry.summaries.length > 0) {
				summariesByProject[entry.projectId] = entry.summaries;
			}
		}
		return summariesByProject;
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
