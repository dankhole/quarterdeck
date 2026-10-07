import type { ProjectOrganization } from "../core/api/project-organization.js";
// Streams live runtime state to browser clients over websocket.
// It listens to terminal updates, normalizes them into the shared API contract,
// and fans out project-scoped snapshots and deltas.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type {
	DiagnosticCaptureScope,
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
	deriveProjectSummary,
	getLogLevel,
	pruneOrphanSessionsForNotification,
	pruneOrphanSessionsForNotificationDelta,
	QUARTERDECK_BUILD_ID,
	toDisposable,
} from "../core";
import {
	type RuntimeNotificationPreferences,
	runtimeNotificationPresentationRenewSchema,
} from "../core/api/notification-presentation";
import type { RuntimeDiagnostics } from "../diagnostics";
import type { ProjectBoardCommandService } from "../state";
import { loadProjectBoardById } from "../state";
import type { TerminalSessionManager } from "../terminal";
import { applyRuntimeMutationEffects, createTaskBaseRefUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { createProjectMetadataMonitor } from "./project-metadata-monitor";
import { normalizeProjectMetadataClientId } from "./project-metadata-visibility";
import type { ProjectRegistry } from "./project-registry";
import { RuntimeNotificationPresentationLease } from "./runtime-notification-presentation";
import { RuntimeStateClientRegistry } from "./runtime-state-client-registry";
import { RuntimeStateMessageBatcher } from "./runtime-state-message-batcher";
import {
	buildDiagnosticCaptureStateMessage,
	buildDiagnosticRecordBatchMessage,
	buildDiagnosticSnapshotRequestMessage,
	buildDiagnosticsStateMessage,
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
const SLOW_REMOTE_FETCH_MS = 2_000;

interface RuntimeNotificationPublicationState {
	tail: Promise<void>;
	disposed: boolean;
}

export interface DisposeRuntimeStateProjectOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface RuntimeStateHubDiagnosticSnapshot {
	clients: ReturnType<RuntimeStateClientRegistry["getDiagnosticSnapshot"]>;
	batcher: ReturnType<RuntimeStateMessageBatcher["getDiagnosticSnapshot"]>;
}

export interface CreateRuntimeStateHubDependencies {
	projectRegistry: Pick<
		ProjectRegistry,
		| "resolveProjectForStream"
		| "buildProjectsPayload"
		| "buildProjectStateSnapshot"
		| "getActiveRuntimeConfig"
		| "listManagedProjects"
		| "getProjectPathById"
	>;
	boardCommands: Pick<ProjectBoardCommandService, "reconcileRuntimeMetadata" | "reconcileRuntimeTaskBaseRef">;
	diagnostics: RuntimeDiagnostics;
}

export interface RuntimeStateHub extends IRuntimeBroadcaster {
	configureNotificationPresentation?: (runtimeGeneration: string) => void;
	trackTerminalManager: (projectId: string, manager: TerminalSessionManager) => void;
	broadcastRuntimeProjectStateSnapshot: (projectId: string, state: RuntimeProjectStateResponse) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedProjectId: string | null;
			clientId: string | null;
			isDocumentVisible: boolean;
			notificationOnly?: boolean;
		},
	) => void;
	disposeProject: (projectId: string, options?: DisposeRuntimeStateProjectOptions) => Promise<void>;
	suspendProject: (projectId: string) => Promise<void>;
	refreshProject: (projectId: string, projectPath: string) => Promise<void>;
	close: () => Promise<void>;
	getDiagnosticSnapshot: (scope?: Readonly<DiagnosticCaptureScope>) => RuntimeStateHubDiagnosticSnapshot;
}

export class RuntimeStateHubImpl extends Disposable implements RuntimeStateHub {
	private readonly wss: WebSocketServer;
	private readonly clients: RuntimeStateClientRegistry;
	private readonly batcher: RuntimeStateMessageBatcher;
	private readonly metadataMonitor: ReturnType<typeof createProjectMetadataMonitor>;
	private readonly notificationRevisionsByProject = new Map<string, number>();
	private notificationPresentation: RuntimeNotificationPresentationLease<WebSocket> | null = null;
	private readonly notificationPublicationStates = new Map<string, RuntimeNotificationPublicationState>();
	private readonly suspendedProjects = new Set<string>();
	private readonly metadataWrites = new Map<string, Set<Promise<void>>>();
	private readonly diagnosticClientBySocket = new WeakMap<
		WebSocket,
		{ clientId: string; capability: string; connectionId: string }
	>();

	constructor(private readonly deps: CreateRuntimeStateHubDependencies) {
		super();

		this.wss = new WebSocketServer({ noServer: true });
		// wss is NOT registered with _register — it requires an async close
		// with a callback to properly drain connections. Handled in close().

		this.clients = new RuntimeStateClientRegistry({
			onProjectClientDisconnected: (projectId, clientId) => {
				this.metadataMonitor.disconnectProject(projectId, clientId);
			},
		});

		this.batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => this.deps.diagnostics.hasBrowserLiveSubscribers(),
			onTaskSessionBatch: (projectId, summaries) => {
				this.clients.broadcastToProject(projectId, buildTaskSessionsUpdatedMessage(projectId, summaries));
			},
			onTaskNotificationBatch: (projectId, summaries) => {
				void this.enqueueNotificationPublication(projectId, async (state, notificationRevision) => {
					await this.broadcastTaskNotifications(projectId, state, notificationRevision, summaries);
				});
			},
			onTasksReadyForReview: (projectId, taskIds) => {
				for (const taskId of taskIds) this.broadcastTaskReadyForReview(projectId, taskId);
			},
			onProjectsRefreshRequested: (preferredCurrentProjectId) => {
				void this.broadcastRuntimeProjectsUpdated(preferredCurrentProjectId);
			},
			onDiagnosticRecordBatch: (records) => {
				const message = buildDiagnosticRecordBatchMessage(records);
				this.clients.forEachClient((client) => {
					const diagnosticClient = this.diagnosticClientBySocket.get(client);
					if (
						!diagnosticClient ||
						!this.deps.diagnostics.isBrowserLiveSubscribed(diagnosticClient.clientId, diagnosticClient.capability)
					)
						return;
					this.clients.sendDiagnosticToClient(client, message);
				});
			},
		});

		this.metadataMonitor = createProjectMetadataMonitor({
			onMetadataUpdated: (projectId, projectMetadata) => {
				if (this.suspendedProjects.has(projectId)) return;
				this.clients.broadcastToProject(projectId, buildProjectMetadataUpdatedMessage(projectId, projectMetadata));
				const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
				if (projectPath) {
					this.trackMetadataWrite(
						projectId,
						this.deps.boardCommands
							.reconcileRuntimeMetadata({ projectId, projectPath }, projectMetadata)
							.catch((error) => {
								hubLog.warn("runtime task metadata persistence failed", {
									projectId,
									error: error instanceof Error ? error.message : String(error),
								});
							})
							.then(() => undefined),
					);
				}
			},
			onTaskBaseRefChanged: (projectId, taskId, newBaseRef) => {
				if (this.suspendedProjects.has(projectId)) return;
				const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
				if (!projectPath) {
					return;
				}
				this.trackMetadataWrite(
					projectId,
					this.deps.boardCommands
						.reconcileRuntimeTaskBaseRef({ projectId, projectPath }, taskId, newBaseRef)
						.then(async () => {
							await applyRuntimeMutationEffects(
								this,
								createTaskBaseRefUpdatedEffects({
									projectId,
									taskId,
									baseRef: newBaseRef,
								}),
							);
						})
						.catch((error) => {
							hubLog.warn("runtime task base ref persistence failed", {
								projectId,
								taskId,
								error: error instanceof Error ? error.message : String(error),
							});
						}),
				);
			},
			onRemoteFetchCompleted: (projectId, result) => {
				if (!result.succeeded) {
					this.deps.diagnostics.recordEvent(
						"metadata.remote_fetch_failed",
						{ durationMs: result.durationMs, errorClass: result.errorClass },
						{ projectId },
						{ level: "warn", essential: true },
					);
					return;
				}
				if (result.durationMs >= SLOW_REMOTE_FETCH_MS) {
					this.deps.diagnostics.recordEvent(
						"metadata.remote_fetch_slow",
						{ durationMs: result.durationMs },
						{ projectId },
						{ essential: false },
					);
				}
			},
			getProjectDefaultBaseRef: () => {
				return this.deps.projectRegistry.getActiveRuntimeConfig().defaultBaseRef ?? "";
			},
		});
		this._register(toDisposable(() => this.metadataMonitor.close()));

		this._register(
			toDisposable(
				this.deps.diagnostics.recorder.onRecord((record) => {
					this.batcher.queueDiagnosticRecord(record);
				}),
			),
		);
		this._register(
			toDisposable(
				this.deps.diagnostics.recorder.onRecordingStateChange((recording) => {
					this.clients.broadcastToAll(buildDiagnosticCaptureStateMessage(getLogLevel(), recording));
				}),
			),
		);
		this._register(
			toDisposable(
				this.deps.diagnostics.registerSnapshotProvider({
					name: "runtime_stream",
					capture: (scope) => this.getDiagnosticSnapshot(scope),
				}),
			),
		);
		this._register(
			toDisposable(
				this.deps.diagnostics.registerSnapshotProvider({
					name: "project_metadata",
					capture: (scope) => this.metadataMonitor.getDiagnosticSnapshot(scope),
				}),
			),
		);
		this.deps.diagnostics.setBrowserSnapshotRequester(({ nonce, deadline }) => {
			this.clients.broadcastToAll(buildDiagnosticSnapshotRequestMessage(nonce, deadline));
		});
		this._register(toDisposable(() => this.deps.diagnostics.setBrowserSnapshotRequester(null)));

		this.wss.on("connection", (client: WebSocket, context: unknown) => this.handleConnection(client, context));
	}

	// ── Public API (arrow fields for stable `this` when passed as refs) ──
	configureNotificationPresentation = (runtimeGeneration: string): void => {
		if (this.notificationPresentation) throw new Error("Notification presentation is already configured");
		this.notificationPresentation = new RuntimeNotificationPresentationLease(runtimeGeneration, (state) => {
			this.clients.broadcastToAll({ type: "notification_presentation", state });
		});
	};

	trackTerminalManager = (projectId: string, manager: TerminalSessionManager): void => {
		this.batcher.trackTerminalManager(projectId, manager);
	};

	handleUpgrade = (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedProjectId: string | null;
			clientId: string | null;
			isDocumentVisible: boolean;
			notificationOnly?: boolean;
		},
	): void => {
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			this.wss.emit("connection", ws, context);
		});
	};

	disposeProject = async (projectId: string, options?: DisposeRuntimeStateProjectOptions): Promise<void> => {
		await this.suspendProject(projectId);
		this.suspendedProjects.delete(projectId);
		this.batcher.disposeProject(projectId);
		await this.disposeNotificationPublications(projectId);
		this.notificationRevisionsByProject.delete(projectId);
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

	suspendProject = async (projectId: string): Promise<void> => {
		this.suspendedProjects.add(projectId);
		this.batcher.disposeProject(projectId);
		await this.metadataMonitor.suspendProject(projectId);
		await Promise.allSettled(Array.from(this.metadataWrites.get(projectId) ?? []));
		await this.disposeNotificationPublications(projectId);
	};

	refreshProject = async (projectId: string, projectPath: string): Promise<void> => {
		this.suspendedProjects.delete(projectId);
		for (const project of this.deps.projectRegistry.listManagedProjects()) {
			if (project.projectId === projectId) this.trackTerminalManager(projectId, project.terminalManager);
		}
		await this.broadcastRuntimeProjectStateUpdated(projectId, projectPath);
		await this.broadcastRuntimeProjectNotificationsUpdated(projectId);
	};

	broadcastRuntimeProjectStateUpdated = async (projectId: string, projectPath: string): Promise<void> => {
		if (!this.clients.hasClients) {
			return;
		}
		try {
			const projectState = await this.deps.projectRegistry.buildProjectStateSnapshot(projectId);
			this.broadcastRuntimeProjectStateSnapshot(projectId, projectState);
		} catch (error) {
			hubLog.warn("runtime project state publication failed", {
				projectId,
				projectPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	broadcastRuntimeProjectStateSnapshot = (projectId: string, projectState: RuntimeProjectStateResponse): void => {
		if (this.suspendedProjects.has(projectId)) return;
		const clients = this.clients.getProjectClients(projectId);
		if (clients && clients.size > 0) {
			this.clients.broadcastToProject(projectId, buildProjectStateUpdatedMessage(projectId, projectState));
			void this.metadataMonitor
				.updateProjectState({
					projectId,
					projectPath: projectState.repoPath,
					board: projectState.board,
					folderOnly: projectState.git.folderOnly,
					metadataRevision: projectState.metadataRevision,
					available: projectState.availability?.status !== "unavailable",
				})
				.catch((error) => {
					hubLog.warn("runtime project metadata refresh failed", {
						projectId,
						boardRevision: projectState.revision,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}
		void this.broadcastRuntimeProjectsForState(projectId, projectState);
	};

	broadcastRuntimeProjectNotificationsUpdated = async (projectId: string): Promise<void> => {
		if (!this.clients.hasClients) {
			return;
		}
		await this.enqueueNotificationPublication(projectId, async (state, notificationRevision) => {
			const summaries = await this.collectNotificationSummariesForProject(projectId);
			if (!this.isCurrentNotificationPublication(projectId, state)) return;
			this.clients.broadcastToAll(
				buildTaskNotificationMessage(projectId, notificationRevision, summaries, { replace: true }),
			);
		});
	};

	broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (!this.clients.hasClients) {
			return;
		}
		try {
			const payload = await this.deps.projectRegistry.buildProjectsPayload(preferredCurrentProjectId);
			this.clients.broadcastToAll(
				buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects, payload.organization),
			);
		} catch (error) {
			hubLog.warn("runtime project list publication failed", {
				preferredCurrentProjectId,
				error: error instanceof Error ? error.message : String(error),
			});
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

	setDocumentVisible = (projectId: string, clientId: string, isDocumentVisible: boolean): void => {
		this.metadataMonitor.setDocumentVisible(projectId, clientId, isDocumentVisible);
	};

	requestTaskRefresh = (projectId: string, taskId: string): void => {
		this.metadataMonitor.requestTaskRefresh(projectId, taskId);
	};

	requestHomeRefresh = (projectId: string): void => {
		this.metadataMonitor.requestHomeRefresh(projectId);
	};

	broadcastLogLevel = (level: LogLevel): void => {
		this.clients.broadcastToAll(
			buildDiagnosticCaptureStateMessage(level, this.deps.diagnostics.recorder.getRecordingState()),
		);
		if (this.notificationPresentation) {
			this.clients.broadcastToAll({
				type: "notification_preferences",
				preferences: this.getNotificationPreferences(),
			});
		}
	};

	getDiagnosticSnapshot = (scope: Readonly<DiagnosticCaptureScope> = {}): RuntimeStateHubDiagnosticSnapshot => ({
		clients: this.clients.getDiagnosticSnapshot(scope),
		batcher: this.batcher.getDiagnosticSnapshot(scope),
	});

	close = async (): Promise<void> => {
		this.notificationPresentation?.dispose();
		const notificationPublications = Array.from(this.notificationPublicationStates.values());
		for (const state of notificationPublications) state.disposed = true;
		this.notificationPublicationStates.clear();
		await Promise.allSettled(notificationPublications.map(async (state) => await state.tail));
		// Dispose base class resources (metadata monitor and diagnostics subscriptions).
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

	private trackMetadataWrite(projectId: string, write: Promise<void>): void {
		const pending = this.metadataWrites.get(projectId) ?? new Set<Promise<void>>();
		this.metadataWrites.set(projectId, pending);
		pending.add(write);
		void write.finally(() => {
			pending.delete(write);
			if (pending.size === 0 && this.metadataWrites.get(projectId) === pending)
				this.metadataWrites.delete(projectId);
		});
	}

	private async handleConnection(client: WebSocket, context: unknown): Promise<void> {
		client.on("close", () => {
			this.notificationPresentation?.release(client);
			const diagnosticClient = this.diagnosticClientBySocket.get(client);
			if (diagnosticClient) {
				this.deps.diagnostics.revokeBrowserCapability(diagnosticClient.clientId, diagnosticClient.capability);
				this.deps.diagnostics.recordEvent(
					"browser.runtime_stream_disconnected",
					{},
					{ clientId: diagnosticClient.clientId, connectionId: diagnosticClient.connectionId },
					{ essential: true },
				);
			}
			this.clients.removeClient(client);
		});

		try {
			if (
				context &&
				typeof context === "object" &&
				"notificationOnly" in context &&
				context.notificationOnly === true
			) {
				await this.handleNotificationConnection(client);
				return;
			}
			const requestedProjectId = this.parseProjectId(context);
			const runtimeClientId = this.parseClientId(context);
			const connectionId = randomUUID();
			const browserCapability = this.deps.diagnostics.issueBrowserCapability(runtimeClientId);
			this.diagnosticClientBySocket.set(client, {
				clientId: runtimeClientId,
				capability: browserCapability,
				connectionId,
			});
			this.deps.diagnostics.recordEvent(
				"browser.runtime_stream_connected",
				{},
				{ clientId: runtimeClientId, connectionId },
				{ essential: true },
			);
			const isDocumentVisible = this.parseDocumentVisible(context);
			const resolved = await this.deps.projectRegistry.resolveProjectForStream(requestedProjectId);
			if (client.readyState !== WebSocket.OPEN) {
				this.clients.removeClient(client);
				return;
			}

			let monitorProjectId: string | null = null;
			let didConnectProjectMonitor = false;

			try {
				const snapshot = await this.loadInitialSnapshot(resolved);
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
				}

				this.sendMessage(client, {
					...buildSnapshotMessage(
						QUARTERDECK_BUILD_ID,
						snapshot.currentProjectId,
						snapshot.projects,
						snapshot.projectState,
						snapshot.notificationSummariesByProject,
						snapshot.notificationRevisionsByProject,
						snapshot.organization,
					),
					...this.getNotificationSnapshotFields(),
				});
				monitorProjectId = snapshot.projectId;
				// Do not expose a half-hydrated client to live publications. Register
				// immediately after the snapshot send, then issue revision-fenced
				// catch-ups for every durable projection. This closes the async load
				// window without allowing an older snapshot to overwrite a live delta.
				this.clients.registerGlobalClient(client);
				if (monitorProjectId) {
					this.clients.registerProjectClient(monitorProjectId, client, runtimeClientId);
				}
				this.enqueueConnectionCatchupForClient(client, {
					projectId: snapshot.projectId,
					projectIds: snapshot.projects.map((project) => project.id),
				});
				if (client.readyState !== WebSocket.OPEN) {
					this.clients.removeClient(client);
					return;
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
							folderOnly: snapshot.projectState.git.folderOnly,
							metadataRevision: snapshot.projectState.metadataRevision,
							available:
								!this.suspendedProjects.has(snapshot.projectId) &&
								snapshot.projectState.availability?.status !== "unavailable",
							clientId: runtimeClientId,
							isDocumentVisible,
						})
						.catch(() => {
							// Non-fatal: metadata arrives on the next poll cycle.
						});
				}

				this.sendMessage(
					client,
					buildDiagnosticsStateMessage({
						runtimeInstanceId: this.deps.diagnostics.runtimeInstanceId,
						browserCapability,
						consoleLogLevel: getLogLevel(),
						recording: this.deps.diagnostics.recorder.getRecordingState(),
						recentRecords: [],
					}),
				);
			} catch (error) {
				if (didConnectProjectMonitor && monitorProjectId) {
					this.metadataMonitor.disconnectProject(monitorProjectId, runtimeClientId);
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

	private getNotificationPreferences(): RuntimeNotificationPreferences {
		const config = this.deps.projectRegistry.getActiveRuntimeConfig();
		return {
			enabled: config.audibleNotificationsEnabled,
			volume: config.audibleNotificationVolume,
			events: { ...config.audibleNotificationEvents },
			onlyWhenHidden: config.audibleNotificationsOnlyWhenHidden,
			suppressCurrentProject: { ...config.audibleNotificationSuppressCurrentProject },
		};
	}

	private getNotificationSnapshotFields() {
		return this.notificationPresentation
			? {
					notificationPresentation: this.notificationPresentation.getState(),
					notificationPreferences: this.getNotificationPreferences(),
				}
			: {};
	}

	private async handleNotificationConnection(client: WebSocket): Promise<void> {
		const presentation = this.notificationPresentation;
		if (!presentation) {
			client.close(1008, "Notification presentation unavailable");
			return;
		}
		// This read-only subscription never resolves a project viewer or acquires a Git monitor.
		const snapshot = await this.loadInitialSnapshot({ projectId: null, projectPath: null });
		if (client.readyState !== WebSocket.OPEN) return;
		this.sendMessage(client, {
			...buildSnapshotMessage(
				QUARTERDECK_BUILD_ID,
				snapshot.currentProjectId,
				snapshot.projects,
				null,
				snapshot.notificationSummariesByProject,
				snapshot.notificationRevisionsByProject,
				snapshot.organization,
			),
			...this.getNotificationSnapshotFields(),
		});
		this.clients.registerGlobalClient(client);
		this.enqueueNotificationCatchupForClient(
			client,
			snapshot.projects.map((project) => project.id),
		);
		const granted = presentation.acquire(client);
		this.sendMessage(client, { type: "notification_presentation", state: presentation.getState(), granted });
		client.on("message", (data) => {
			let value: unknown;
			try {
				value = JSON.parse(data.toString());
			} catch {
				client.close(1008, "Invalid presentation renewal");
				return;
			}
			const renewal = runtimeNotificationPresentationRenewSchema.safeParse(value);
			if (!renewal.success) {
				client.close(1008, "Invalid presentation renewal");
				return;
			}
			const granted = presentation.renew(client, renewal.data.runtimeGeneration, renewal.data.epoch);
			this.sendMessage(client, { type: "notification_presentation", state: presentation.getState(), granted });
		});
	}

	private async loadInitialSnapshot(resolved: { projectId: string | null; projectPath: string | null }): Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
		organization?: ProjectOrganization | null;
		projectId: string | null;
		projectPath: string | null;
		projectState: RuntimeProjectStateResponse | null;
		projectStateError: string | null;
		notificationSummariesByProject: Record<string, RuntimeTaskSessionSummary[]>;
		notificationRevisionsByProject: Record<string, number>;
	}> {
		const notificationRevisionsByProject = Object.fromEntries(this.notificationRevisionsByProject);
		if (resolved.projectId && resolved.projectPath) {
			const [projectsPayload, projectStateResult, notificationSummariesByProject] = await Promise.all([
				this.deps.projectRegistry.buildProjectsPayload(resolved.projectId),
				this.loadInitialProjectState(resolved.projectId),
				this.collectNotificationSummariesByProject(),
			]);
			const projects = projectStateResult.projectState
				? this.mergeProjectSummaryForState(
						projectsPayload.projects,
						resolved.projectId,
						projectStateResult.projectState,
					)
				: projectsPayload.projects;
			return {
				currentProjectId: projectsPayload.currentProjectId,
				organization: projectsPayload.organization,
				projects,
				projectId: resolved.projectId,
				projectPath: projectStateResult.projectState?.repoPath ?? resolved.projectPath,
				projectState: projectStateResult.projectState,
				projectStateError: projectStateResult.projectStateError,
				notificationSummariesByProject,
				notificationRevisionsByProject,
			};
		}

		const [projectsPayload, notificationSummariesByProject] = await Promise.all([
			this.deps.projectRegistry.buildProjectsPayload(null),
			this.collectNotificationSummariesByProject(),
		]);
		return {
			currentProjectId: projectsPayload.currentProjectId,
			organization: projectsPayload.organization,
			projects: projectsPayload.projects,
			projectId: null,
			projectPath: null,
			projectState: null,
			projectStateError: null,
			notificationSummariesByProject,
			notificationRevisionsByProject,
		};
	}

	private mergeProjectSummaryForState(
		projects: RuntimeProjectSummary[],
		projectId: string,
		projectState: RuntimeProjectStateResponse,
	): RuntimeProjectSummary[] {
		const current = projects.find((project) => project.id === projectId);
		const useStateMetadata = (projectState.metadataRevision ?? 0) >= (current?.metadataRevision ?? 0);
		const exact = deriveProjectSummary({
			projectId,
			repoPath: useStateMetadata ? projectState.repoPath : (current?.path ?? projectState.repoPath),
			folderOnly: projectState.git.folderOnly,
			board: projectState.board,
			boardRevision: projectState.revision,
			displayName: current?.displayName,
			metadataRevision: Math.max(projectState.metadataRevision ?? 0, current?.metadataRevision ?? 0),
			availability: useStateMetadata ? (projectState.availability ?? current?.availability) : current?.availability,
		});
		let found = false;
		const merged = projects.map((project) => {
			if (project.id !== projectId) {
				return project;
			}
			found = true;
			// A state-driven publication must advertise the counts for that exact
			// state revision. Another concurrent commit will publish its own newer
			// state/summary pair, while clients already reject lower revisions.
			return exact;
		});
		return found ? merged : [...merged, exact];
	}

	private async broadcastRuntimeProjectsForState(
		projectId: string,
		projectState: RuntimeProjectStateResponse,
	): Promise<void> {
		if (!this.clients.hasClients) {
			return;
		}
		try {
			const payload = await this.deps.projectRegistry.buildProjectsPayload(projectId);
			const projects = this.mergeProjectSummaryForState(payload.projects, projectId, projectState);
			this.clients.broadcastToAll(
				buildProjectsUpdatedMessage(payload.currentProjectId, projects, payload.organization),
			);
		} catch (error) {
			hubLog.warn("authoritative project summary publication failed", {
				projectId,
				boardRevision: projectState.revision,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async loadInitialProjectState(
		projectId: string,
	): Promise<{ projectState: RuntimeProjectStateResponse | null; projectStateError: string | null }> {
		try {
			return {
				projectState: await this.deps.projectRegistry.buildProjectStateSnapshot(projectId),
				projectStateError: null,
			};
		} catch (error) {
			return {
				projectState: null,
				projectStateError: error instanceof Error ? error.message : String(error),
			};
		}
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

	private nextNotificationRevision(projectId: string): number {
		const nextRevision = (this.notificationRevisionsByProject.get(projectId) ?? 0) + 1;
		this.notificationRevisionsByProject.set(projectId, nextRevision);
		return nextRevision;
	}

	private isCurrentNotificationPublication(projectId: string, state: RuntimeNotificationPublicationState): boolean {
		return !state.disposed && this.notificationPublicationStates.get(projectId) === state;
	}

	private enqueueNotificationPublication(
		projectId: string,
		publish: (state: RuntimeNotificationPublicationState, notificationRevision: number) => Promise<void>,
	): Promise<void> {
		let state = this.notificationPublicationStates.get(projectId);
		if (!state) {
			state = { tail: Promise.resolve(), disposed: false };
			this.notificationPublicationStates.set(projectId, state);
		}
		const publicationState = state;
		const next = publicationState.tail
			.then(async () => {
				if (!this.isCurrentNotificationPublication(projectId, publicationState)) return;
				const notificationRevision = this.nextNotificationRevision(projectId);
				await publish(publicationState, notificationRevision);
			})
			.catch((error) => {
				hubLog.warn("runtime notification publication failed", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		publicationState.tail = next;
		return next;
	}

	private async disposeNotificationPublications(projectId: string): Promise<void> {
		const state = this.notificationPublicationStates.get(projectId);
		if (!state) return;
		state.disposed = true;
		this.notificationPublicationStates.delete(projectId);
		await state.tail;
	}

	private enqueueNotificationCatchupForClient(client: WebSocket, projectIds: readonly string[]): void {
		for (const projectId of projectIds) {
			void this.enqueueNotificationPublication(projectId, async (state, notificationRevision) => {
				const summaries = await this.collectNotificationSummariesForProject(projectId);
				if (!this.isCurrentNotificationPublication(projectId, state)) return;
				this.sendMessage(
					client,
					buildTaskNotificationMessage(projectId, notificationRevision, summaries, { replace: true }),
				);
			});
		}
	}

	private enqueueConnectionCatchupForClient(
		client: WebSocket,
		input: { projectId: string | null; projectIds: readonly string[] },
	): void {
		this.enqueueNotificationCatchupForClient(client, input.projectIds);
		void this.sendDurableConnectionCatchup(client, input.projectId);
	}

	private async sendDurableConnectionCatchup(client: WebSocket, projectId: string | null): Promise<void> {
		const projectsPromise = this.deps.projectRegistry.buildProjectsPayload(projectId);
		const projectStatePromise = projectId
			? this.deps.projectRegistry.buildProjectStateSnapshot(projectId)
			: Promise.resolve<RuntimeProjectStateResponse | null>(null);
		const [projectsResult, projectStateResult] = await Promise.allSettled([projectsPromise, projectStatePromise]);

		if (client.readyState !== WebSocket.OPEN) return;

		const projectState = projectStateResult.status === "fulfilled" ? projectStateResult.value : null;
		if (projectState && projectId) {
			this.sendMessage(client, buildProjectStateUpdatedMessage(projectId, projectState));
		}
		if (projectsResult.status === "fulfilled") {
			const projects =
				projectState && projectId
					? this.mergeProjectSummaryForState(projectsResult.value.projects, projectId, projectState)
					: projectsResult.value.projects;
			this.sendMessage(
				client,
				buildProjectsUpdatedMessage(
					projectsResult.value.currentProjectId,
					projects,
					projectsResult.value.organization,
				),
			);
		}

		if (projectsResult.status === "rejected" || projectStateResult.status === "rejected") {
			hubLog.warn("runtime connection catch-up failed", {
				projectId,
				projectsError:
					projectsResult.status === "rejected"
						? projectsResult.reason instanceof Error
							? projectsResult.reason.message
							: String(projectsResult.reason)
						: null,
				projectStateError:
					projectStateResult.status === "rejected"
						? projectStateResult.reason instanceof Error
							? projectStateResult.reason.message
							: String(projectStateResult.reason)
						: null,
			});
		}
	}

	private async broadcastTaskNotifications(
		projectId: string,
		state: RuntimeNotificationPublicationState,
		notificationRevision: number,
		summaries: RuntimeTaskSessionSummary[],
	): Promise<void> {
		if (summaries.length === 0) {
			return;
		}
		try {
			const board = await loadProjectBoardById(projectId);
			const summaryMap = Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
			const pruned = pruneOrphanSessionsForNotificationDelta(summaryMap, board);
			const prunedSummaries = Object.values(pruned);
			const removedTaskIds = summaries.map((summary) => summary.taskId).filter((taskId) => !(taskId in pruned));
			if (prunedSummaries.length === 0 && removedTaskIds.length === 0) {
				return;
			}
			if (!this.isCurrentNotificationPublication(projectId, state)) return;
			this.clients.broadcastToAll(
				buildTaskNotificationMessage(projectId, notificationRevision, prunedSummaries, { removedTaskIds }),
			);
		} catch (error) {
			// Board read failed — keep live notifications flowing. The next
			// authoritative snapshot/project-state update will repair stale entries.
			hubLog.warn("runtime notification delta board reconciliation failed", {
				projectId,
				notificationRevision,
				summaryCount: summaries.length,
				error: error instanceof Error ? error.message : String(error),
			});
			if (!this.isCurrentNotificationPublication(projectId, state)) return;
			this.clients.broadcastToAll(buildTaskNotificationMessage(projectId, notificationRevision, summaries));
		}
	}

	private async collectNotificationSummariesForProject(projectId: string): Promise<RuntimeTaskSessionSummary[]> {
		const project = this.deps.projectRegistry
			.listManagedProjects()
			.find((candidate) => candidate.projectId === projectId);
		const summaries = project?.terminalManager.store.listSummaries() ?? [];
		try {
			const board = await loadProjectBoardById(projectId);
			const summaryMap = Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
			return Object.values(pruneOrphanSessionsForNotification(summaryMap, board));
		} catch (error) {
			// Board reads should normally succeed immediately after an authoritative mutation. If
			// they do not, replace with the live store view rather than leaving stale
			// browser notification entries that no longer exist server-side.
			hubLog.warn("runtime notification snapshot board reconciliation failed", {
				projectId,
				summaryCount: summaries.length,
				error: error instanceof Error ? error.message : String(error),
			});
			return summaries;
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
				// Keep connect-time notification snapshots actionable. Live deltas
				// use a laxer filter because session delivery can race board projection
				// publication even though both are owned by the runtime.
				try {
					const board = await loadProjectBoardById(project.projectId);
					const summaryMap = Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
					const pruned = pruneOrphanSessionsForNotification(summaryMap, board);
					const prunedList = Object.values(pruned);
					return {
						projectId: project.projectId,
						summaries: prunedList,
					};
				} catch (error) {
					// Board read failed — fall back to full list rather than
					// silently dropping notifications.
					hubLog.warn("initial runtime notification board reconciliation failed", {
						projectId: project.projectId,
						summaryCount: summaries.length,
						error: error instanceof Error ? error.message : String(error),
					});
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

	private parseClientId(context: unknown): string {
		if (
			typeof context === "object" &&
			context !== null &&
			"clientId" in context &&
			typeof (context as { clientId?: unknown }).clientId === "string"
		) {
			return normalizeProjectMetadataClientId((context as { clientId: string }).clientId);
		}
		return normalizeProjectMetadataClientId(null);
	}

	private parseDocumentVisible(context: unknown): boolean {
		if (
			typeof context === "object" &&
			context !== null &&
			"isDocumentVisible" in context &&
			typeof (context as { isDocumentVisible?: unknown }).isDocumentVisible === "boolean"
		) {
			return (context as { isDocumentVisible: boolean }).isDocumentVisible;
		}
		return true;
	}
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	return new RuntimeStateHubImpl(deps);
}
