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
import type { RuntimeDiagnostics } from "../diagnostics";
import type { ProjectBoardCommandService } from "../state";
import { loadProjectBoardById } from "../state";
import type { TerminalSessionManager } from "../terminal";
import { applyRuntimeMutationEffects, createTaskBaseRefUpdatedEffects } from "../trpc/runtime-mutation-effects";
import { createProjectMetadataMonitor } from "./project-metadata-monitor";
import { normalizeProjectMetadataClientId } from "./project-metadata-visibility";
import type { ProjectRegistry } from "./project-registry";
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
const SESSION_PERSISTENCE_RETRY_MAX_MS = 5_000;
const SESSION_PERSISTENCE_FINAL_ATTEMPTS = 2;

interface RuntimeSessionPersistenceState {
	dirtyGeneration: number;
	persistedGeneration: number;
	retryAttempt: number;
	lastError: Error | null;
	timer: ReturnType<typeof setTimeout> | null;
	inFlight: Promise<void> | null;
	disposed: boolean;
}

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
	boardCommands: Pick<
		ProjectBoardCommandService,
		"reconcileRuntimeSessions" | "reconcileRuntimeMetadata" | "reconcileRuntimeTaskBaseRef"
	>;
	diagnostics: RuntimeDiagnostics;
}

export interface RuntimeStateHub extends IRuntimeBroadcaster {
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
		},
	) => void;
	persistRuntimeSessions: (projectId: string) => Promise<void>;
	disposeProject: (projectId: string, options?: DisposeRuntimeStateProjectOptions) => Promise<void>;
	close: () => Promise<void>;
	getDiagnosticSnapshot: (scope?: Readonly<DiagnosticCaptureScope>) => RuntimeStateHubDiagnosticSnapshot;
}

export class RuntimeStateHubImpl extends Disposable implements RuntimeStateHub {
	private readonly wss: WebSocketServer;
	private readonly clients: RuntimeStateClientRegistry;
	private readonly batcher: RuntimeStateMessageBatcher;
	private readonly metadataMonitor: ReturnType<typeof createProjectMetadataMonitor>;
	private readonly sessionPersistenceUnsubscribes = new Map<string, () => void>();
	private readonly sessionPersistenceStates = new Map<string, RuntimeSessionPersistenceState>();
	private readonly sessionPersistenceBarriers = new Set<Promise<void>>();
	private sessionPersistenceClosed = false;
	private readonly notificationRevisionsByProject = new Map<string, number>();
	private readonly notificationPublicationStates = new Map<string, RuntimeNotificationPublicationState>();
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
				this.clients.broadcastToProject(projectId, buildProjectMetadataUpdatedMessage(projectId, projectMetadata));
				const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
				if (projectPath) {
					void this.deps.boardCommands
						.reconcileRuntimeMetadata({ projectId, projectPath }, projectMetadata)
						.catch((error) => {
							hubLog.warn("runtime task metadata persistence failed", {
								projectId,
								error: error instanceof Error ? error.message : String(error),
							});
						});
				}
			},
			onTaskBaseRefChanged: (projectId, taskId, newBaseRef) => {
				const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
				if (!projectPath) {
					return;
				}
				void this.deps.boardCommands
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
					});
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

	trackTerminalManager = (projectId: string, manager: TerminalSessionManager): void => {
		this.batcher.trackTerminalManager(projectId, manager);
		if (this.sessionPersistenceUnsubscribes.has(projectId)) {
			return;
		}
		const persist = () => this.scheduleRuntimeSessionPersistence(projectId);
		this.sessionPersistenceUnsubscribes.set(projectId, manager.store.onChange(persist));
		if (manager.store.listSummaries().length > 0) {
			this.scheduleRuntimeSessionPersistence(projectId, 0);
		}
	};

	handleUpgrade = (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: { requestedProjectId: string | null; clientId: string | null; isDocumentVisible: boolean },
	): void => {
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			this.wss.emit("connection", ws, context);
		});
	};

	persistRuntimeSessions = (projectId: string): Promise<void> => {
		if (this.sessionPersistenceClosed) {
			return Promise.reject(new Error("Runtime session persistence is closed."));
		}
		const persistence = (async () => {
			// Explicit persistence is also a write barrier. Mark a fresh generation so
			// callers that run after the automatic store listener has been detached
			// still capture the current session snapshot before they resolve.
			this.scheduleRuntimeSessionPersistence(projectId, 0);
			await this.flushRuntimeSessionPersistence(projectId);
		})();
		const tracked = persistence.finally(() => this.sessionPersistenceBarriers.delete(tracked));
		this.sessionPersistenceBarriers.add(tracked);
		return tracked;
	};

	disposeProject = async (projectId: string, options?: DisposeRuntimeStateProjectOptions): Promise<void> => {
		this.batcher.disposeProject(projectId);
		const notificationDisposal = this.disposeNotificationPublications(projectId);
		const persistenceDisposal = this.disposeRuntimeSessionPersistence(projectId);
		await Promise.all([notificationDisposal, persistenceDisposal]);
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

	broadcastRuntimeProjectStateUpdated = async (projectId: string, projectPath: string): Promise<void> => {
		if (!this.clients.hasClients) {
			return;
		}
		try {
			const projectState = await this.deps.projectRegistry.buildProjectStateSnapshot(projectId, projectPath);
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
		const clients = this.clients.getProjectClients(projectId);
		if (clients && clients.size > 0) {
			this.clients.broadcastToProject(projectId, buildProjectStateUpdatedMessage(projectId, projectState));
			void this.metadataMonitor
				.updateProjectState({
					projectId,
					projectPath: projectState.repoPath,
					board: projectState.board,
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
			this.clients.broadcastToAll(buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects));
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
	};

	getDiagnosticSnapshot = (scope: Readonly<DiagnosticCaptureScope> = {}): RuntimeStateHubDiagnosticSnapshot => ({
		clients: this.clients.getDiagnosticSnapshot(scope),
		batcher: this.batcher.getDiagnosticSnapshot(scope),
	});

	close = async (): Promise<void> => {
		const trackedProjectIds = Array.from(this.sessionPersistenceUnsubscribes.keys());
		for (const projectId of trackedProjectIds) {
			this.unsubscribeRuntimeSessionPersistence(projectId);
		}
		const persistenceResults = await Promise.allSettled(
			trackedProjectIds.map(async (projectId) => await this.flushRuntimeSessionPersistence(projectId)),
		);
		const barrierResults: PromiseSettledResult<void>[] = [];
		while (this.sessionPersistenceBarriers.size > 0) {
			barrierResults.push(...(await Promise.allSettled(Array.from(this.sessionPersistenceBarriers))));
		}
		// No asynchronous gap exists between observing an empty barrier set and
		// closing admission, so a later acknowledgement fails closed instead of
		// reporting durability after its writer has been disposed.
		this.sessionPersistenceClosed = true;
		const persistenceProjectIds = Array.from(this.sessionPersistenceStates.keys());
		await Promise.all(
			persistenceProjectIds.map(async (projectId) => await this.disposeRuntimeSessionPersistence(projectId)),
		);
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

		const persistenceFailures = [...persistenceResults, ...barrierResults].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (persistenceFailures.length > 0) {
			throw new AggregateError(persistenceFailures, "Runtime session persistence did not finish during shutdown.");
		}
	};

	// ── Private helpers ───────────────────────────────────────────────────

	private scheduleRuntimeSessionPersistence(projectId: string, delayMs = 100): void {
		let state = this.sessionPersistenceStates.get(projectId);
		if (!state) {
			state = {
				dirtyGeneration: 0,
				persistedGeneration: 0,
				retryAttempt: 0,
				lastError: null,
				timer: null,
				inFlight: null,
				disposed: false,
			};
			this.sessionPersistenceStates.set(projectId, state);
		}
		if (state.disposed) return;
		state.dirtyGeneration += 1;
		this.armRuntimeSessionPersistence(projectId, state, delayMs);
	}

	private armRuntimeSessionPersistence(
		projectId: string,
		state: RuntimeSessionPersistenceState,
		delayMs: number,
	): void {
		if (state.disposed || state.inFlight) return;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = null;
			void this.runRuntimeSessionPersistence(projectId, state);
		}, delayMs);
		state.timer.unref?.();
	}

	private async runRuntimeSessionPersistence(
		projectId: string,
		state: RuntimeSessionPersistenceState,
		options: { retry?: boolean } = {},
	): Promise<void> {
		if (state.disposed || state.persistedGeneration >= state.dirtyGeneration) return;
		if (state.inFlight) {
			await state.inFlight;
			return;
		}
		const targetGeneration = state.dirtyGeneration;
		let succeeded = false;
		state.inFlight = (async () => {
			const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
			if (!projectPath) throw new Error("Project path is unavailable for runtime session persistence.");
			await this.deps.boardCommands.reconcileRuntimeSessions({ projectId, projectPath });
			succeeded = true;
			state.persistedGeneration = Math.max(state.persistedGeneration, targetGeneration);
			state.retryAttempt = 0;
			state.lastError = null;
		})()
			.catch((error) => {
				state.retryAttempt += 1;
				state.lastError = error instanceof Error ? error : new Error(String(error));
				hubLog.warn("runtime session persistence failed", {
					projectId,
					dirtyGeneration: state.dirtyGeneration,
					persistedGeneration: state.persistedGeneration,
					retryAttempt: state.retryAttempt,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				state.inFlight = null;
			});
		await state.inFlight;
		if (state.disposed || this.sessionPersistenceStates.get(projectId) !== state) return;
		if (state.persistedGeneration < state.dirtyGeneration && options.retry !== false) {
			const retryDelay = succeeded
				? 0
				: Math.min(250 * 2 ** Math.max(0, state.retryAttempt - 1), SESSION_PERSISTENCE_RETRY_MAX_MS);
			this.armRuntimeSessionPersistence(projectId, state, retryDelay);
		}
	}

	private async flushRuntimeSessionPersistence(projectId: string): Promise<void> {
		const state = this.sessionPersistenceStates.get(projectId);
		if (!state || state.disposed) return;
		// A caller needs the generation that was dirty when it requested the
		// flush, not an unbounded stream of newer activity. Concurrent hook
		// acknowledgements may advance dirtyGeneration while this caller waits.
		const requiredGeneration = state.dirtyGeneration;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		if (state.inFlight) await state.inFlight;
		for (
			let attempt = 0;
			attempt < SESSION_PERSISTENCE_FINAL_ATTEMPTS && state.persistedGeneration < requiredGeneration;
			attempt += 1
		) {
			await this.runRuntimeSessionPersistence(projectId, state, { retry: false });
		}
		if (state.persistedGeneration < requiredGeneration) {
			throw (
				state.lastError ??
				new Error(`Runtime session persistence did not reach the required generation for project "${projectId}".`)
			);
		}
	}

	private unsubscribeRuntimeSessionPersistence(projectId: string): void {
		const unsubscribe = this.sessionPersistenceUnsubscribes.get(projectId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Listener cleanup must not prevent bounded shutdown persistence.
			}
		}
		this.sessionPersistenceUnsubscribes.delete(projectId);
	}

	private async disposeRuntimeSessionPersistence(projectId: string): Promise<void> {
		this.unsubscribeRuntimeSessionPersistence(projectId);
		const state = this.sessionPersistenceStates.get(projectId);
		if (state) {
			state.disposed = true;
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			// Remove the old generation before awaiting so a legitimate re-add can
			// install a fresh writer without inheriting disposed state.
			this.sessionPersistenceStates.delete(projectId);
			if (state.inFlight) await state.inFlight;
		}
	}

	private async handleConnection(client: WebSocket, context: unknown): Promise<void> {
		client.on("close", () => {
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
			const resolved = await this.deps.projectRegistry.resolveProjectForStream(requestedProjectId, {
				onRemovedProject: ({ projectId, message }) => {
					return this.disposeProject(projectId, {
						disconnectClients: true,
						closeClientErrorMessage: message,
					});
				},
			});
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

				this.sendMessage(
					client,
					buildSnapshotMessage(
						QUARTERDECK_BUILD_ID,
						snapshot.currentProjectId,
						snapshot.projects,
						snapshot.projectState,
						snapshot.notificationSummariesByProject,
						snapshot.notificationRevisionsByProject,
					),
				);
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
					projectPath: snapshot.projectPath,
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

				if (resolved.removedRequestedProjectPath) {
					const message = `Project no longer exists on disk and was removed: ${resolved.removedRequestedProjectPath}`;
					hubLog.warn(message);
					this.sendMessage(client, buildErrorMessage(message));
				}
				if (resolved.didPruneProjects) {
					void this.broadcastRuntimeProjectsUpdated(resolved.projectId);
				}
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

	private async loadInitialSnapshot(resolved: { projectId: string | null; projectPath: string | null }): Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
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
				this.loadInitialProjectState(resolved.projectId, resolved.projectPath),
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
				projects,
				projectId: resolved.projectId,
				projectPath: resolved.projectPath,
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
		const exact = deriveProjectSummary({
			projectId,
			repoPath: projectState.repoPath,
			board: projectState.board,
			boardRevision: projectState.revision,
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
			this.clients.broadcastToAll(buildProjectsUpdatedMessage(payload.currentProjectId, projects));
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
		projectPath: string,
	): Promise<{ projectState: RuntimeProjectStateResponse | null; projectStateError: string | null }> {
		try {
			return {
				projectState: await this.deps.projectRegistry.buildProjectStateSnapshot(projectId, projectPath),
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
		input: { projectId: string | null; projectPath: string | null; projectIds: readonly string[] },
	): void {
		this.enqueueNotificationCatchupForClient(client, input.projectIds);
		void this.sendDurableConnectionCatchup(client, input.projectId, input.projectPath);
	}

	private async sendDurableConnectionCatchup(
		client: WebSocket,
		projectId: string | null,
		projectPath: string | null,
	): Promise<void> {
		const projectsPromise = this.deps.projectRegistry.buildProjectsPayload(projectId);
		const projectStatePromise =
			projectId && projectPath
				? this.deps.projectRegistry.buildProjectStateSnapshot(projectId, projectPath)
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
			this.sendMessage(client, buildProjectsUpdatedMessage(projectsResult.value.currentProjectId, projects));
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
