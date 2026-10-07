import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	migrateLegacyProjectConfig,
	setAgentAvailabilityDiagnosticSink,
	waitForPendingAgentAvailabilityProbes,
} from "../config";
import {
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	type IRuntimeHostIntegrations,
	normalizeDiagnosticErrorClass,
	type RuntimeCapabilities,
	type RuntimeShutdownOutcome,
	setRuntimeDiagnosticLogSink,
} from "../core";
import { setLogLevel } from "../core/runtime-logger";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../diagnostics/runtime-diagnostics";
import { cleanupGlobalStaleLockArtifacts, cleanupProjectStaleLockArtifacts } from "../fs/lock-cleanup";
import { createHookTransitionOutboxReplayer, loadPendingHookTransitions } from "../hook-transition-outbox";
import { resolveProjectInputPath } from "../projects/project-path";
import { listProjectIndexEntries, ProjectBoardCommandService, pruneProjectSessionsForBoard } from "../state";
import {
	createBackup,
	listBackups,
	startPeriodicBackups,
	stopPeriodicBackups,
	waitForPendingBackups,
} from "../state/state-backup";
import type { TerminalSessionManager } from "../terminal";
import {
	inspectPtyRuntimeHealth,
	PTY_RUNTIME_REMEDIATION,
	PtyRuntimeDependencyError,
} from "../terminal/pty-runtime-health";
import type { RuntimeTrpcContext } from "../trpc";
import { createHooksApi } from "../trpc/hooks-api";
import { stopRuntimeOwnedProcessTrees } from "./owned-process-shutdown";
import {
	collectProjectWorktreeTaskIdsForRemoval,
	createProjectRegistry,
	type ProjectRegistry,
} from "./project-registry";
import type { RuntimeClientAccess } from "./runtime-client-access";
import { type CreateRuntimeHostIntegrationsOptions, createRuntimeHostIntegrations } from "./runtime-host-integrations";
import { loadRuntimeHostSimulation } from "./runtime-host-simulation";
import { createRuntimeServer } from "./runtime-server";
import { RuntimeSessionPersistence } from "./runtime-session-persistence";
import { RuntimeStartupCleanupError } from "./runtime-startup-cleanup";
import { assertPathIsDirectory, hasGitRepository, pathIsDirectory } from "./runtime-startup-paths";
import { createRuntimeStateHub, type RuntimeStateHub } from "./runtime-state-hub";
import { resolveInteractiveShellCommand } from "./shell";
import { type RuntimeShutdownCoordinatorDependencies, shutdownRuntimeServer } from "./shutdown-coordinator";

export { RuntimeStartupCleanupError } from "./runtime-startup-cleanup";

/** Runtime lifecycle composition shared by process entry points; no resources start at import time. */
export interface RuntimeBootstrapOptions {
	capabilities: RuntimeCapabilities;
	simulationConfigPath?: string | null;
	quarterdeckVersion: string;
	/** Zero asks the OS to bind an available port; omitted retains the configured CLI port. */
	listenPort?: number;
	cwd?: string;
	registerCwdProject?: boolean;
	hostIntegrationOverrides?: Pick<
		CreateRuntimeHostIntegrationsOptions,
		"pickDirectory" | "openTarget" | "openProject"
	>;
	warn?: (message: string) => void;
	persistenceAllowed?: () => boolean;
	clientAccess?: RuntimeClientAccess;
	stopOwnedProcesses?: RuntimeShutdownCoordinatorDependencies["stopOwnedProcesses"];
	beforeProcessSnapshot?: () => void;
	/** Lifetime admission must finish before diagnostics or state cleanup writes anything. */
	beforeStartup?: () => Promise<void>;
	/** Inspect or retire verified prior-owned processes before startup cleanup changes their evidence. */
	beforeRecovery?: () => Promise<void>;
	/** Called only once createRuntimeServer has bound its listener. */
	onReady?: (runtime: RuntimeHandle) => void | Promise<void>;
}

export interface RuntimeHandle {
	url: string;
	getQuitSummary: () => { liveProcessCount: number; pendingLaunches: boolean };
	hostIntegrations: Pick<IRuntimeHostIntegrations, "openExternalUrl">;
	diagnostics: RuntimeDiagnostics;
	close: () => Promise<void>;
	/** Forward the coordinator's outcome; resolution alone is not proof of full quiescence. */
	shutdown: (options?: {
		skipSessionCleanup?: boolean;
		persistenceAllowed?: boolean;
	}) => ReturnType<typeof shutdownRuntimeServer>;
}

interface RuntimeBootstrapResources {
	projectRegistry?: ProjectRegistry;
	runtimeHub?: RuntimeStateHub;
	runtimeSessionPersistence?: RuntimeSessionPersistence;
}

async function runRuntimeStartupCleanup(warn: (message: string) => void): Promise<void> {
	// Phase 1: Clean stale lock artifacts from ~/.quarterdeck/ (before registry load).
	await cleanupGlobalStaleLockArtifacts(warn);

	// Phase 2: Clean stale lock artifacts from per-project directories.
	// Read the project index (now safe after phase 1 cleaned its lock files)
	// to discover project repo paths, then clean their .git/ dirs.
	try {
		const indexEntries = await listProjectIndexEntries();
		const projectPaths = indexEntries.map((entry) => entry.repoPath);
		if (projectPaths.length > 0) {
			await cleanupProjectStaleLockArtifacts(projectPaths, warn);
		}
		if (indexEntries.length > 0) {
			const migrated = await migrateLegacyProjectConfig(indexEntries);
			if (migrated > 0) {
				warn(`Migrated project config for ${migrated} project(s) from repo .quarterdeck/ to state home.`);
			}
		}
		for (const entry of indexEntries) {
			try {
				const result = await pruneProjectSessionsForBoard(entry.repoPath);
				if (result.prunedCount > 0) {
					const plural = result.prunedCount === 1 ? "summary" : "summaries";
					const backupText = result.backupPath ? ` Backup: ${result.backupPath}` : "";
					warn(
						`Pruned ${result.prunedCount} orphan session ${plural} from ${entry.projectId} sessions.json.${backupText}`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not prune orphan sessions for ${entry.projectId}: ${message}`);
			}
		}
	} catch {
		// Project index may not exist yet on first run — safe to skip.
	}
}

async function createRuntimeBootstrapState(
	warn: (message: string) => void,
	startupAgentCleanup: Promise<void>,
	diagnostics: RuntimeDiagnostics,
	cwd: string,
	registerCwdProject: boolean,
	resources: RuntimeBootstrapResources,
) {
	let runtimeStateHub: RuntimeStateHub | undefined;
	let sessionPersistence: RuntimeSessionPersistence | undefined;
	const projectRegistry = await createProjectRegistry({
		cwd,
		registerCwdProject,
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		pathIsDirectory,
		diagnostics,
		waitForStartupAgentCleanup: async () => await startupAgentCleanup,
		onTerminalManagerReady: (projectId, manager) => {
			sessionPersistence?.trackTerminalManager(projectId, manager);
			runtimeStateHub?.trackTerminalManager(projectId, manager);
		},
	});
	resources.projectRegistry = projectRegistry;
	const activeConfig = projectRegistry.getActiveRuntimeConfig();
	setLogLevel(activeConfig.logLevel as "debug" | "info" | "warn" | "error");
	diagnostics.registerSnapshotProvider({
		name: "backups",
		capture: async () => {
			const backups = await listBackups();
			const latest = backups[0]?.manifest ?? null;
			return {
				count: backups.length,
				latest: latest
					? {
							timestamp: latest.timestamp,
							trigger: latest.trigger,
							projectCount: latest.projectIds.length,
						}
					: null,
			};
		},
	});

	// Phase 4: State backup — snapshot before any mutations, then start periodic timer.
	createBackup({ trigger: "startup" })
		.then((path) => {
			if (path) {
				diagnostics.recordEvent("backup.startup_created", {}, {}, { essential: true });
				console.log(`[quarterdeck] Startup backup created: ${path}`);
			}
		})
		.catch((error: unknown) => {
			diagnostics.recordEvent(
				"backup.startup_failed",
				{ errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError" },
				{},
				{ level: "warn", essential: true },
			);
		});
	startPeriodicBackups(activeConfig.backupIntervalMinutes);
	const boardCommands = new ProjectBoardCommandService({
		getAuthoritativeSessions: async ({ projectId, projectPath }) => {
			const manager = await projectRegistry.ensureTerminalManagerForProject(projectId, projectPath);
			return Object.fromEntries(manager.store.listSummaries().map((summary) => [summary.taskId, summary]));
		},
		publishAuthoritativeState: async ({ projectId }, result) => {
			const hub = runtimeStateHub;
			if (!hub) return;
			const state = await projectRegistry.buildProjectStatePublication(projectId, result.state);
			if (state) hub.broadcastRuntimeProjectStateSnapshot(projectId, state);
		},
	});
	sessionPersistence = new RuntimeSessionPersistence({ projectRegistry, boardCommands });
	const runtimeSessionPersistence = sessionPersistence;
	resources.runtimeSessionPersistence = runtimeSessionPersistence;
	runtimeStateHub = createRuntimeStateHub({
		projectRegistry,
		boardCommands,
		diagnostics,
	});
	const runtimeHub = runtimeStateHub;
	resources.runtimeHub = runtimeHub;
	for (const { projectId, terminalManager } of projectRegistry.listManagedProjects()) {
		runtimeSessionPersistence.trackTerminalManager(projectId, terminalManager);
		runtimeHub.trackTerminalManager(projectId, terminalManager);
	}
	const initializeProjectsForStartup = async (
		runProjectOperation: RuntimeTrpcContext["runProjectOperation"],
	): Promise<void> => {
		await projectRegistry.initializeIndexedProjectsForStartup({
			beforeRecovery: async () => {
				// Admission inspected prior-owned processes before cleanup. Await its
				// completion before the final outbox snapshot and session recovery.
				await startupAgentCleanup;
				const startupHooksApi = createHooksApi({
					runProjectOperation,
					projects: projectRegistry,
					terminals: projectRegistry,
					config: projectRegistry,
					persistSessionState: runtimeSessionPersistence.persistRuntimeSessions,
					diagnostics,
				});
				const startupOutboxReplayer = createHookTransitionOutboxReplayer({
					ingest: startupHooksApi.ingest,
				});
				try {
					await startupOutboxReplayer.replayOnce();
					const pending = await loadPendingHookTransitions();
					const blockedTasks = Array.from(
						new Map(
							pending.map(({ request }) => [
								JSON.stringify([request.projectId, request.taskId]),
								{ projectId: request.projectId, taskId: request.taskId },
							]),
						).values(),
					);
					if (blockedTasks.length > 0) {
						warn(
							`Held automatic recovery for ${blockedTasks.length} task(s) with deferred provider hooks; their persisted Interrupted state is being retained.`,
						);
					}
					return { blockAllRecovery: false, blockedTasks };
				} catch (error) {
					warn(
						`Could not inspect persisted provider hooks before session recovery; automatic recovery is being held: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					return { blockAllRecovery: true, blockedTasks: [] };
				} finally {
					await startupOutboxReplayer.close();
				}
			},
		});
	};

	const disposeTrackedProject = async (
		projectId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): Promise<{ terminalManager: TerminalSessionManager | null; projectPath: string | null }> => {
		const disposed = projectRegistry.disposeProject(projectId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		await Promise.all([runtimeSessionPersistence.disposeProject(projectId), runtimeHub.disposeProject(projectId)]);
		return disposed;
	};

	return {
		projectRegistry,
		runtimeHub,
		runtimeSessionPersistence,
		boardCommands,
		initializeProjectsForStartup,
		diagnostics,
		disposeTrackedProject,
		warn,
		stopPeriodicBackups: () => {
			stopPeriodicBackups();
		},
	};
}

function ownedProcessShutdown(
	projectRegistry: ProjectRegistry,
	hasAdditionalPendingLaunches?: () => boolean,
): NonNullable<RuntimeBootstrapOptions["stopOwnedProcesses"]> {
	return async (stopSessions) =>
		await stopRuntimeOwnedProcessTrees({
			getRootPids: () =>
				projectRegistry
					.listManagedProjects()
					.flatMap(({ terminalManager }) => terminalManager.getOwnedProcessRootPids()),
			hasPendingLaunches: () =>
				(hasAdditionalPendingLaunches?.() ?? false) ||
				projectRegistry
					.listManagedProjects()
					.some(({ terminalManager }) => terminalManager.hasPendingOwnedProcessLaunches()),
			stopSessions,
			includeRuntimeChildren: true,
		});
}

async function createRuntimeServerHandle(
	bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapState>>,
	hostLaunch: RuntimeBootstrapOptions,
): Promise<RuntimeHandle> {
	const simulation = hostLaunch.simulationConfigPath
		? await loadRuntimeHostSimulation(hostLaunch.simulationConfigPath)
		: null;
	const hostIntegrations = createRuntimeHostIntegrations({
		...hostLaunch.hostIntegrationOverrides,
		capabilities: hostLaunch.capabilities,
		warn: bootstrap.warn,
		simulator: simulation?.simulator,
	});
	let allowPersistence = true;
	const persistenceAllowed = () => allowPersistence && (hostLaunch.persistenceAllowed?.() ?? true);
	const runtimeServer = await createRuntimeServer({
		listenPort: hostLaunch.listenPort,
		clientAccess: hostLaunch.clientAccess,
		persistenceAllowed,
		beforeProcessSnapshot: hostLaunch.beforeProcessSnapshot,
		projectRegistry: bootstrap.projectRegistry,
		runtimeStateHub: bootstrap.runtimeHub,
		runtimeSessionPersistence: bootstrap.runtimeSessionPersistence,
		boardCommands: bootstrap.boardCommands,
		initializeProjectsForStartup: bootstrap.initializeProjectsForStartup,
		diagnostics: bootstrap.diagnostics,
		warn: bootstrap.warn,
		resolveInteractiveShellCommand,
		hostIntegrations,
		hostEventLedger: simulation?.ledger,
		resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository,
		disposeProject: bootstrap.disposeTrackedProject,
		collectProjectWorktreeTaskIdsForRemoval,
	});

	const close = async () => {
		try {
			await runtimeServer.close({ persistenceAllowed: persistenceAllowed() });
		} finally {
			setAgentAvailabilityDiagnosticSink(null);
			setRuntimeDiagnosticLogSink(null);
		}
	};

	let shutdownPromise: ReturnType<typeof shutdownRuntimeServer> | null = null;
	let persistenceDiscard: Promise<void> | undefined;
	const shutdown: RuntimeHandle["shutdown"] = (options) => {
		if (options?.persistenceAllowed === false) {
			allowPersistence = false;
			persistenceDiscard ??= bootstrap.runtimeSessionPersistence.close({ skipPersistence: true });
		}
		shutdownPromise ??= (async () => {
			bootstrap.stopPeriodicBackups();
			const stopProcesses =
				hostLaunch.stopOwnedProcesses ??
				ownedProcessShutdown(bootstrap.projectRegistry, () => runtimeServer.getQuitSummary().pendingLaunches);
			return await shutdownRuntimeServer({
				projectRegistry: bootstrap.projectRegistry,
				warn: bootstrap.warn,
				closeRuntimeServer: close,
				prepareForShutdown: async () => {
					const prepared = await Promise.allSettled([
						persistenceDiscard,
						waitForPendingBackups(),
						runtimeServer.prepareForShutdown({
							skipSessionCleanup: options?.skipSessionCleanup ?? false,
							persistenceAllowed: persistenceAllowed(),
						}),
					]);
					const failures = prepared.filter((result) => result.status === "rejected");
					if (failures.length > 0) {
						throw new AggregateError(
							failures.map((result) => result.reason),
							"Runtime shutdown preparation failed.",
						);
					}
				},
				stopOwnedProcesses: async (stopSessions) => {
					let ownerStop: Promise<void> | undefined;
					const stopAll = () => {
						stopSessions();
						ownerStop ??= runtimeServer.stopTaskOwnersForShutdown({
							skipSessionCleanup: options?.skipSessionCleanup ?? false,
							persistenceAllowed: persistenceAllowed(),
						});
						void ownerStop.catch(() => undefined);
					};
					try {
						return await stopProcesses(stopAll);
					} finally {
						// A failing snapshot still fences/stops owners; their full settlement
						// remains inside the coordinator's process attempt before persistence.
						stopAll();
						await ownerStop;
					}
				},
				beforeProcessSnapshot: hostLaunch.beforeProcessSnapshot,
				persistenceAllowed,
				skipSessionCleanup: options?.skipSessionCleanup ?? false,
				skipOrphanProcessCleanup: process.env.QUARTERDECK_AGENT_LAB === "1",
			});
		})();
		return shutdownPromise;
	};

	return {
		url: runtimeServer.url,
		getQuitSummary: runtimeServer.getQuitSummary,
		hostIntegrations,
		diagnostics: bootstrap.diagnostics,
		close,
		shutdown,
	};
}

export async function startRuntime(options: RuntimeBootstrapOptions): Promise<RuntimeHandle> {
	try {
		await options.beforeStartup?.();
	} catch (error) {
		options.clientAccess?.clear();
		throw error;
	}
	const warn = options.warn ?? ((message: string) => console.warn(`[quarterdeck] ${message}`));
	const diagnostics = await createRuntimeDiagnostics({
		host: getQuarterdeckRuntimeHost(),
		port: getQuarterdeckRuntimePort(),
		quarterdeckVersion: options.quarterdeckVersion,
		captureTier: process.env.QUARTERDECK_AGENT_LAB === "1" ? "agent-lab" : "flight",
	});
	setAgentAvailabilityDiagnosticSink((event) => {
		diagnostics.recordEvent(event.name, event.payload, {}, { level: event.level, essential: true });
	});
	setRuntimeDiagnosticLogSink(diagnostics);
	const resources: RuntimeBootstrapResources = {};
	let runtime: RuntimeHandle | undefined;
	let startupAgentCleanup: Promise<void> | undefined;
	try {
		diagnostics.registerSnapshotProvider({
			name: "terminal_runtime",
			capture: () => inspectPtyRuntimeHealth(),
		});
		const terminalRuntimeHealth = inspectPtyRuntimeHealth();
		if (!terminalRuntimeHealth.available) {
			diagnostics.recordEvent(
				"terminal.runtime_dependency_missing",
				{
					issue: terminalRuntimeHealth.issue,
					platform: terminalRuntimeHealth.platform,
					arch: terminalRuntimeHealth.arch,
				},
				{},
				{ level: "warn", essential: true },
			);
			warn(PTY_RUNTIME_REMEDIATION);
			throw new PtyRuntimeDependencyError(terminalRuntimeHealth);
		}

		// Native node-pty loading happens only when a PTY is spawned. Keep this
		// on-disk check before startup can prepare or recover any sessions.
		startupAgentCleanup = options.beforeRecovery?.() ?? Promise.resolve();
		await startupAgentCleanup;
		await runRuntimeStartupCleanup(warn);
		const bootstrap = await createRuntimeBootstrapState(
			warn,
			startupAgentCleanup,
			diagnostics,
			options.cwd ?? process.cwd(),
			options.registerCwdProject ?? true,
			resources,
		);
		runtime = await createRuntimeServerHandle(bootstrap, options);
		await options.onReady?.(runtime);
		return runtime;
	} catch (error) {
		stopPeriodicBackups();
		await startupAgentCleanup?.catch(() => undefined);
		let shutdownOutcome: RuntimeShutdownOutcome | undefined;
		try {
			if (runtime) {
				const cleanup = await runtime.shutdown();
				shutdownOutcome = await cleanup.completion;
			} else if (resources.projectRegistry) {
				const cleanup = await shutdownRuntimeServer({
					projectRegistry: resources.projectRegistry,
					warn,
					prepareForShutdown: async () => {
						await Promise.all([waitForPendingBackups(), resources.projectRegistry?.waitForMaintenance?.()]);
						await waitForPendingAgentAvailabilityProbes();
					},
					stopOwnedProcesses: options.stopOwnedProcesses ?? ownedProcessShutdown(resources.projectRegistry),
					beforeProcessSnapshot: options.beforeProcessSnapshot,
					persistenceAllowed: options.persistenceAllowed,
					closeRuntimeServer: async () => {
						const closed = await Promise.allSettled([
							resources.runtimeSessionPersistence?.close({
								skipPersistence: options.persistenceAllowed?.() === false,
							}),
							resources.runtimeHub?.close(),
						]);
						const failures = closed.filter((result) => result.status === "rejected");
						if (failures.length > 0) {
							throw new AggregateError(
								failures.map((result) => result.reason),
								"Partial runtime cleanup failed.",
							);
						}
					},
				});
				shutdownOutcome = await cleanup.completion;
			} else {
				await waitForPendingBackups();
				await waitForPendingAgentAvailabilityProbes();
				options.beforeProcessSnapshot?.();
			}
		} catch {
			shutdownOutcome = {
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["quiescence_failed"],
			};
		}
		setAgentAvailabilityDiagnosticSink(null);
		setRuntimeDiagnosticLogSink(null);
		options.clientAccess?.clear();
		await diagnostics.fail(error).catch(() => undefined);
		if (error instanceof RuntimeStartupCleanupError) throw error;
		if (shutdownOutcome?.status === "incomplete") throw new RuntimeStartupCleanupError(shutdownOutcome, error);
		throw error;
	}
}
