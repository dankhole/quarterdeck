// Streams live runtime state to browser clients over websocket.
// It listens to terminal updates, normalizes them into the shared API contract,
// and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
	IRuntimeBroadcaster,
	LogEntry,
	LogLevel,
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core";
import { Disposable, getLogLevel, getRecentLogEntries, onLogEntry, toDisposable } from "../core";
import type { TerminalSessionManager } from "../terminal";
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

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

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
	private readonly terminalSummaryUnsubscribes = new Map<string, () => void>();
	private readonly pendingSummaries = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	private readonly broadcastTimers = new Map<string, NodeJS.Timeout>();
	private readonly clientsByWorkspace = new Map<string, Set<WebSocket>>();
	private readonly allClients = new Set<WebSocket>();
	private readonly clientToWorkspace = new Map<WebSocket, string>();
	private readonly resumeAttempted = new Set<string>();
	private readonly wss: WebSocketServer;
	private readonly metadataMonitor: ReturnType<typeof createWorkspaceMetadataMonitor>;

	// Debug log batching
	private readonly pendingDebugLogEntries: LogEntry[] = [];
	private debugLogBroadcastTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: CreateRuntimeStateHubDependencies) {
		super();

		this.wss = new WebSocketServer({ noServer: true });
		// wss is NOT registered with _register — it requires an async close
		// with a callback to properly drain connections. Handled in close().

		this.metadataMonitor = createWorkspaceMetadataMonitor({
			onMetadataUpdated: (workspaceId, workspaceMetadata) => {
				this.broadcastToWorkspace(
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
					if (this.allClients.size === 0) {
						return;
					}
					this.pendingDebugLogEntries.push(entry);
					if (this.debugLogBroadcastTimer === null) {
						this.debugLogBroadcastTimer = setTimeout(() => this.flushDebugLogEntries(), DEBUG_LOG_BATCH_MS);
						this.debugLogBroadcastTimer.unref();
					}
				}),
			),
		);

		this.wss.on("connection", (client: WebSocket, context: unknown) => this.handleConnection(client, context));
	}

	// ── Public API (arrow fields for stable `this` when passed as refs) ──

	trackTerminalManager = (workspaceId: string, manager: TerminalSessionManager): void => {
		if (this.terminalSummaryUnsubscribes.has(workspaceId)) {
			return;
		}
		const unsubscribe = manager.store.onChange((summary) => {
			this.queueSummaryBroadcast(workspaceId, summary);
		});
		this.terminalSummaryUnsubscribes.set(workspaceId, unsubscribe);
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
		const unsubscribe = this.terminalSummaryUnsubscribes.get(workspaceId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		this.terminalSummaryUnsubscribes.delete(workspaceId);
		this.disposeSummaryBroadcast(workspaceId);
		this.resumeAttempted.delete(workspaceId);
		this.metadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		const runtimeClients = this.clientsByWorkspace.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			this.clientsByWorkspace.delete(workspaceId);
			return;
		}

		for (const runtimeClient of runtimeClients) {
			if (options.closeClientErrorMessage) {
				this.send(runtimeClient, buildErrorMessage(options.closeClientErrorMessage));
			}
			try {
				runtimeClient.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			this.cleanupClient(runtimeClient);
		}
		this.clientsByWorkspace.delete(workspaceId);
	};

	broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		const clients = this.clientsByWorkspace.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			const workspaceState = await this.deps.workspaceRegistry.buildWorkspaceStateSnapshot(
				workspaceId,
				workspacePath,
			);
			const payload = buildWorkspaceStateUpdatedMessage(workspaceId, workspaceState);
			for (const client of clients) {
				this.send(client, payload);
			}
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
		if (this.allClients.size === 0) {
			return;
		}
		try {
			const payload = await this.deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			const message = buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects);
			for (const client of this.allClients) {
				this.send(client, message);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	broadcastTaskReadyForReview = (workspaceId: string, taskId: string): void => {
		this.broadcastToWorkspace(workspaceId, buildTaskReadyForReviewMessage(workspaceId, taskId));
	};

	broadcastTaskTitleUpdated = (
		workspaceId: string,
		taskId: string,
		title: string,
		options?: { autoGenerated?: boolean },
	): void => {
		this.broadcastToWorkspace(workspaceId, buildTaskTitleUpdatedMessage(workspaceId, taskId, title, options));
	};

	broadcastTaskBaseRefUpdated = (workspaceId: string, taskId: string, baseRef: string): void => {
		this.broadcastToWorkspace(workspaceId, buildTaskBaseRefUpdatedMessage(workspaceId, taskId, baseRef));
	};

	broadcastTaskWorkingDirectoryUpdated = (
		workspaceId: string,
		taskId: string,
		workingDirectory: string,
		useWorktree: boolean,
	): void => {
		this.broadcastToWorkspace(
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
		const payload = buildDebugLoggingStateMessage(level, getRecentLogEntries());
		for (const client of this.allClients) {
			this.send(client, payload);
		}
	};

	close = async (): Promise<void> => {
		// Dispose base class resources (metadata monitor, debug log subscription)
		this.dispose();

		// Dispose debug log resources
		if (this.debugLogBroadcastTimer) {
			clearTimeout(this.debugLogBroadcastTimer);
			this.debugLogBroadcastTimer = null;
		}
		this.pendingDebugLogEntries.length = 0;

		// Dispose broadcast timers
		for (const timer of this.broadcastTimers.values()) {
			clearTimeout(timer);
		}
		this.broadcastTimers.clear();
		this.pendingSummaries.clear();

		// Dispose terminal summary subscriptions
		for (const unsubscribe of this.terminalSummaryUnsubscribes.values()) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during shutdown.
			}
		}
		this.terminalSummaryUnsubscribes.clear();

		// Terminate all clients
		for (const client of this.allClients) {
			try {
				client.terminate();
			} catch {
				// Ignore websocket termination errors during shutdown.
			}
		}
		this.allClients.clear();
		this.clientsByWorkspace.clear();
		this.clientToWorkspace.clear();

		// Wait for the WebSocketServer to finish closing (must be last —
		// it needs connections terminated first for a clean shutdown).
		await new Promise<void>((resolveClose) => {
			this.wss.close(() => {
				resolveClose();
			});
		});
	};

	// ── Private helpers ───────────────────────────────────────────────────

	private send(client: WebSocket, payload: RuntimeStateStreamMessage): void {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	}

	private broadcastToWorkspace(workspaceId: string, payload: RuntimeStateStreamMessage): void {
		const clients = this.clientsByWorkspace.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		for (const client of clients) {
			this.send(client, payload);
		}
	}

	private broadcastTaskNotification(workspaceId: string, summaries: RuntimeTaskSessionSummary[]): void {
		if (this.allClients.size === 0) {
			return;
		}
		const payload = buildTaskNotificationMessage(workspaceId, summaries);
		for (const client of this.allClients) {
			this.send(client, payload);
		}
	}

	private queueSummaryBroadcast(workspaceId: string, summary: RuntimeTaskSessionSummary): void {
		const pending = this.pendingSummaries.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		this.pendingSummaries.set(workspaceId, pending);
		if (this.broadcastTimers.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.broadcastTimers.delete(workspaceId);
			this.flushSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		this.broadcastTimers.set(workspaceId, timer);
	}

	private flushSummaries(workspaceId: string): void {
		const pending = this.pendingSummaries.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		this.pendingSummaries.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const runtimeClients = this.clientsByWorkspace.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload = buildTaskSessionsUpdatedMessage(workspaceId, summaries);
			for (const client of runtimeClients) {
				this.send(client, payload);
			}
		}
		this.broadcastTaskNotification(workspaceId, summaries);
		void this.broadcastRuntimeProjectsUpdated(workspaceId);
	}

	private disposeSummaryBroadcast(workspaceId: string): void {
		const timer = this.broadcastTimers.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		this.broadcastTimers.delete(workspaceId);
		this.pendingSummaries.delete(workspaceId);
	}

	private cleanupClient(client: WebSocket): void {
		const workspaceId = this.clientToWorkspace.get(client);
		if (workspaceId) {
			this.metadataMonitor.disconnectWorkspace(workspaceId);
			const clients = this.clientsByWorkspace.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					this.clientsByWorkspace.delete(workspaceId);
				}
			}
		}
		this.clientToWorkspace.delete(client);
		this.allClients.delete(client);
	}

	private flushDebugLogEntries(): void {
		this.debugLogBroadcastTimer = null;
		if (this.pendingDebugLogEntries.length === 0 || this.allClients.size === 0) {
			this.pendingDebugLogEntries.length = 0;
			return;
		}
		const entries = this.pendingDebugLogEntries.splice(0);
		const payload = buildDebugLogBatchMessage(entries);
		for (const client of this.allClients) {
			this.send(client, payload);
		}
	}

	private async handleConnection(client: WebSocket, context: unknown): Promise<void> {
		client.on("close", () => {
			this.cleanupClient(client);
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
				this.cleanupClient(client);
				return;
			}

			this.allClients.add(client);
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeProjectSummary[];
				};
				let workspaceState: RuntimeWorkspaceStateResponse | null;
				if (workspace.workspaceId && workspace.workspacePath) {
					monitorWorkspaceId = workspace.workspaceId;
					[projectsPayload, workspaceState] = await Promise.all([
						this.deps.workspaceRegistry.buildProjectsPayload(workspace.workspaceId),
						this.deps.workspaceRegistry.buildWorkspaceStateSnapshot(
							workspace.workspaceId,
							workspace.workspacePath,
						),
					]);
				} else {
					projectsPayload = await this.deps.workspaceRegistry.buildProjectsPayload(null);
					workspaceState = null;
				}
				if (client.readyState !== WebSocket.OPEN) {
					this.cleanupClient(client);
					return;
				}
				// Workspace metadata is delivered asynchronously via workspace_metadata_updated
				// after connectWorkspace resolves, avoiding git probe latency on the snapshot.
				this.send(
					client,
					buildSnapshotMessage(projectsPayload.currentProjectId, projectsPayload.projects, workspaceState),
				);
				if (client.readyState !== WebSocket.OPEN) {
					this.cleanupClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients = this.clientsByWorkspace.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					this.clientsByWorkspace.set(monitorWorkspaceId, workspaceClients);
					this.clientToWorkspace.set(client, monitorWorkspaceId);
				}
				// Connect the workspace metadata monitor after registering the client
				// so the onMetadataUpdated callback can deliver results to it.
				if (monitorWorkspaceId && workspace.workspacePath && workspaceState) {
					didConnectWorkspaceMonitor = true;
					void this.metadataMonitor
						.connectWorkspace({
							workspaceId: monitorWorkspaceId,
							workspacePath: workspace.workspacePath,
							board: workspaceState.board,
							pollIntervals: this.deps.getActivePollIntervals(),
						})
						.catch(() => {
							// Non-fatal: metadata arrives on the next poll cycle.
						});
				}
				// Send current log level so newly connected clients can show it.
				this.send(client, buildDebugLoggingStateMessage(getLogLevel(), getRecentLogEntries()));

				if (workspace.removedRequestedWorkspacePath) {
					this.send(
						client,
						buildErrorMessage(
							`Project no longer exists on disk and was removed: ${workspace.removedRequestedWorkspacePath}`,
						),
					);
				}
				if (workspace.didPruneProjects) {
					void this.broadcastRuntimeProjectsUpdated(workspace.workspaceId);
				}
				// Resume interrupted sessions on first UI connection per workspace.
				// Fire-and-forget — resumed sessions broadcast state changes via
				// the normal onChange subscription, so the client sees them arrive.
				if (monitorWorkspaceId && workspace.workspacePath && !this.resumeAttempted.has(monitorWorkspaceId)) {
					this.resumeAttempted.add(monitorWorkspaceId);
					void this.deps.workspaceRegistry.resumeInterruptedSessions(monitorWorkspaceId, workspace.workspacePath);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					this.metadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				this.send(client, buildErrorMessage(message));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.send(client, buildErrorMessage(message));
			client.close();
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
