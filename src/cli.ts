import { stat } from "node:fs/promises";
import { createServer as createNetServer, Socket as NetSocket } from "node:net";
import { Command, Option } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { registerBackupCommand } from "./commands/backup";
import { registerDiagnosticsCommand } from "./commands/diagnostics";
import { registerHooksCommand } from "./commands/hooks";
import { registerStatuslineCommand } from "./commands/statusline";
import { loadGlobalRuntimeConfig, loadRuntimeConfig, setAgentAvailabilityDiagnosticSink } from "./config";
import type { IRuntimeHostIntegrations, RuntimeCapabilities } from "./core";
import {
	buildQuarterdeckRuntimeUrl,
	createRuntimeCapabilities,
	DEFAULT_QUARTERDECK_RUNTIME_PORT,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	getQuarterdeckRuntimePort,
	installGracefulShutdownHandlers,
	normalizeDiagnosticErrorClass,
	parseRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
	setRuntimeDiagnosticLogSink,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "./core";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "./diagnostics";
import type { RuntimeStateHub } from "./server";
import type { TerminalSessionManager } from "./terminal";
import { killOrphanedAgentProcesses } from "./terminal/orphan-cleanup";
import {
	inspectPtyRuntimeHealth,
	PTY_RUNTIME_REMEDIATION,
	PtyRuntimeDependencyError,
} from "./terminal/pty-runtime-health";
import { runGit } from "./workdir/git-utils";

interface CliOptions {
	noOpen: boolean;
	nativeUiAvailable: boolean;
	hostSimulationConfigPath: string | null;
	skipShutdownCleanup: boolean;
	host: string | null;
	port: { mode: "fixed"; value: number } | { mode: "auto" } | null;
}

const QUARTERDECK_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

function parseCliPortValue(rawValue: string): { mode: "fixed"; value: number } | { mode: "auto" } {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

interface RootCommandOptions {
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	open?: boolean;
	nativeUi?: boolean;
	simulateHostIntegrations?: string;
	skipShutdownCleanup?: boolean;
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `quarterdeck` and
 * `quarterdeck --port 3500`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	const launchFlags = new Set(["--open", "--no-open", "--no-native-ui", "--skip-shutdown-cleanup"]);
	const launchOptionsWithValues = new Set(["--host", "--port", "--simulate-host-integrations"]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

function createShutdownIndicator(stream: NodeJS.WriteStream = process.stderr): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = ora({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getQuarterdeckRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setQuarterdeckRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_QUARTERDECK_RUNTIME_PORT);
	setQuarterdeckRuntimePort(autoPort);
	return autoPort;
}

async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

async function hasGitRepository(path: string): Promise<boolean> {
	const result = await runGit(path, ["rev-parse", "--is-inside-work-tree"], {
		timeoutClass: "sync",
	});
	return result.ok && result.stdout.trim() === "true";
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EADDRINUSE"
	);
}

async function canReachQuarterdeckServer(projectId: string | null): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (projectId) {
			headers["x-quarterdeck-project-id"] = projectId;
		}
		const response = await fetch(buildQuarterdeckRuntimeUrl("/api/trpc/projects.list"), {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(1_500),
		});
		if (response.status === 404) {
			return false;
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: { data?: unknown };
			error?: unknown;
		} | null;
		return Boolean(payload && (payload.result || payload.error));
	} catch {
		return false;
	}
}

async function openExternalTarget(
	target: string,
	runtimeCapabilities: RuntimeCapabilities,
): Promise<Awaited<ReturnType<IRuntimeHostIntegrations["openExternalUrl"]>>> {
	const { createRuntimeHostIntegrations } = await import("./server/runtime-host-integrations.js");
	return await createRuntimeHostIntegrations({
		capabilities: runtimeCapabilities,
		warn: createRuntimeWarnLogger(),
	}).openExternalUrl(target);
}

async function tryOpenExistingServer(options: {
	noOpen: boolean;
	shouldAutoOpenBrowser: boolean;
	runtimeCapabilities: RuntimeCapabilities;
}): Promise<boolean> {
	let projectId: string | null = null;
	if (await hasGitRepository(process.cwd())) {
		const { isUnderWorktreesHome, loadProjectContext } = await import("./state/project-state.js");
		if (!isUnderWorktreesHome(process.cwd())) {
			const context = await loadProjectContext(process.cwd());
			projectId = context.projectId;
		}
	}
	const running = await canReachQuarterdeckServer(projectId);
	if (!running) {
		return false;
	}
	const projectUrl = projectId
		? buildQuarterdeckRuntimeUrl(`/${encodeURIComponent(projectId)}`)
		: getQuarterdeckRuntimeOrigin();
	console.log(`Quarterdeck already running at ${getQuarterdeckRuntimeOrigin()}`);
	if (!options.noOpen && options.shouldAutoOpenBrowser) {
		const result = await openExternalTarget(projectUrl, options.runtimeCapabilities);
		if (!result.ok) {
			console.warn(`Could not open browser automatically: ${result.error}`);
		} else {
			console.log("Browser launcher accepted the Quarterdeck URL.");
		}
	}
	console.log(`Project URL: ${projectUrl}`);
	return true;
}

interface RuntimeServerHandle {
	url: string;
	hostIntegrations: Pick<IRuntimeHostIntegrations, "openExternalUrl">;
	diagnostics: Pick<RuntimeDiagnostics, "recordEvent">;
	close: () => Promise<void>;
	shutdown: (options?: { skipSessionCleanup?: boolean }) => Promise<void>;
}

function createRuntimeWarnLogger(): (message: string) => void {
	return (message: string): void => {
		console.warn(`[quarterdeck] ${message}`);
	};
}

async function loadRuntimeStartupModules() {
	/*
		Server-only modules are loaded lazily because subcommands like
		`quarterdeck hooks ingest` do not need the runtime server.

		A regression in 25ba59f showed that eagerly importing the runtime stack here
		could leave the source CLI process alive after the command had already printed
		its JSON result. We have not yet isolated the deepest handle creator inside
		the server import graph, so we keep command-style subcommands on the
		lightweight path and only load the server stack when we actually start Quarterdeck.
	*/
	const [
		{ resolveProjectInputPath },
		{ createRuntimeHostIntegrations, createRuntimeServer, loadRuntimeHostSimulation },
		{ createRuntimeStateHub },
		{ resolveInteractiveShellCommand },
		{ shutdownRuntimeServer },
		{ collectProjectWorktreeTaskIdsForRemoval, createProjectRegistry },
		{ cleanupGlobalStaleLockArtifacts, cleanupProjectStaleLockArtifacts },
		{ listProjectIndexEntries, ProjectBoardCommandService, pruneProjectSessionsForBoard },
		{ setLogLevel },
		{ createBackup, listBackups, startPeriodicBackups, stopPeriodicBackups },
		{ migrateLegacyProjectConfig },
		{ createHookTransitionOutboxReplayer, loadPendingHookTransitions },
		{ createHooksApi },
	] = await Promise.all([
		import("./projects/project-path.js"),
		import("./server/index.js"),
		import("./server/runtime-state-hub.js"),
		import("./server/shell.js"),
		import("./server/shutdown-coordinator.js"),
		import("./server/project-registry.js"),
		import("./fs/lock-cleanup.js"),
		import("./state/index.js"),
		import("./core/runtime-logger.js"),
		import("./state/state-backup.js"),
		import("./config/index.js"),
		import("./hook-transition-outbox.js"),
		import("./trpc/hooks-api.js"),
	]);

	return {
		resolveProjectInputPath,
		createRuntimeHostIntegrations,
		createRuntimeServer,
		loadRuntimeHostSimulation,
		createRuntimeStateHub,
		resolveInteractiveShellCommand,
		shutdownRuntimeServer,
		collectProjectWorktreeTaskIdsForRemoval,
		createProjectRegistry,
		cleanupGlobalStaleLockArtifacts,
		cleanupProjectStaleLockArtifacts,
		listProjectIndexEntries,
		ProjectBoardCommandService,
		pruneProjectSessionsForBoard,
		migrateLegacyProjectConfig,
		setLogLevel,
		createBackup,
		listBackups,
		startPeriodicBackups,
		stopPeriodicBackups,
		createHookTransitionOutboxReplayer,
		loadPendingHookTransitions,
		createHooksApi,
	};
}

async function runRuntimeStartupCleanup(
	modules: Awaited<ReturnType<typeof loadRuntimeStartupModules>>,
	warn: (message: string) => void,
): Promise<void> {
	// Phase 1: Clean stale lock artifacts from ~/.quarterdeck/ (before registry load).
	await modules.cleanupGlobalStaleLockArtifacts(warn);

	// Phase 2: Clean stale lock artifacts from per-project directories.
	// Read the project index (now safe after phase 1 cleaned its lock files)
	// to discover project repo paths, then clean their .git/ dirs.
	try {
		const indexEntries = await modules.listProjectIndexEntries();
		const projectPaths = indexEntries.map((entry) => entry.repoPath);
		if (projectPaths.length > 0) {
			await modules.cleanupProjectStaleLockArtifacts(projectPaths, warn);
		}
		if (indexEntries.length > 0) {
			const migrated = await modules.migrateLegacyProjectConfig(indexEntries);
			if (migrated > 0) {
				warn(`Migrated project config for ${migrated} project(s) from repo .quarterdeck/ to state home.`);
			}
		}
		for (const entry of indexEntries) {
			try {
				const result = await modules.pruneProjectSessionsForBoard(entry.repoPath);
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

function startOrphanedAgentCleanup(warn: (message: string) => void): Promise<Error | null> {
	// Phase 3: Kill orphaned agent processes left by a previously crashed instance.
	// Server boot remains non-blocking, but startup task recovery awaits this
	// promise so it cannot race an orphan sweep and launch into a checkout that
	// still has the previous agent process alive.
	return new Promise((resolve) => {
		const cleanupTimer = setTimeout(() => {
			void killOrphanedAgentProcesses()
				.then((killed) => {
					if (killed > 0) {
						warn(`Cleaned up ${killed} orphaned agent process(es) from a previous session.`);
					}
					resolve(null);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					warn(`Could not verify or clean abandoned agent processes: ${message}`);
					resolve(error instanceof Error ? error : new Error(message));
				});
		}, 0);
		cleanupTimer.unref?.();
	});
}

async function awaitStartupAgentCleanup(startupAgentCleanup: Promise<Error | null>): Promise<void> {
	const error = await startupAgentCleanup;
	if (error) throw error;
}

async function createRuntimeBootstrapState(
	modules: Awaited<ReturnType<typeof loadRuntimeStartupModules>>,
	warn: (message: string) => void,
	startupAgentCleanup: Promise<Error | null>,
	diagnostics: RuntimeDiagnostics,
) {
	let runtimeStateHub: RuntimeStateHub | undefined;
	const projectRegistry = await modules.createProjectRegistry({
		cwd: process.cwd(),
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		pathIsDirectory,
		diagnostics,
		waitForStartupAgentCleanup: async () => await awaitStartupAgentCleanup(startupAgentCleanup),
		onTerminalManagerReady: (projectId, manager) => {
			runtimeStateHub?.trackTerminalManager(projectId, manager);
		},
	});
	const activeConfig = projectRegistry.getActiveRuntimeConfig();
	modules.setLogLevel(activeConfig.logLevel as "debug" | "info" | "warn" | "error");
	diagnostics.registerSnapshotProvider({
		name: "backups",
		capture: async () => {
			const backups = await modules.listBackups();
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
	modules
		.createBackup({ trigger: "startup" })
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
	modules.startPeriodicBackups(activeConfig.backupIntervalMinutes);
	const boardCommands = new modules.ProjectBoardCommandService({
		getAuthoritativeSessions: async ({ projectId, projectPath }) => {
			const manager = await projectRegistry.ensureTerminalManagerForProject(projectId, projectPath);
			return Object.fromEntries(manager.store.listSummaries().map((summary) => [summary.taskId, summary]));
		},
		publishAuthoritativeState: ({ projectId }, result) => {
			runtimeStateHub?.broadcastRuntimeProjectStateSnapshot(projectId, result.state);
		},
	});
	runtimeStateHub = modules.createRuntimeStateHub({
		projectRegistry,
		boardCommands,
		diagnostics,
	});
	const runtimeHub = runtimeStateHub;
	for (const { projectId, terminalManager } of projectRegistry.listManagedProjects()) {
		runtimeHub.trackTerminalManager(projectId, terminalManager);
	}
	await projectRegistry.initializeIndexedProjectsForStartup({
		beforeRecovery: async () => {
			// Stop the prior runtime's orphaned processes before taking the final
			// outbox snapshot. No old launch can then enqueue a lifecycle event in
			// the gap between replay and replacement-session recovery.
			await awaitStartupAgentCleanup(startupAgentCleanup);
			const startupHooksApi = modules.createHooksApi({
				projects: projectRegistry,
				terminals: projectRegistry,
				config: projectRegistry,
				persistSessionState: runtimeHub.persistRuntimeSessions,
				diagnostics,
			});
			const startupOutboxReplayer = modules.createHookTransitionOutboxReplayer({
				ingest: startupHooksApi.ingest,
			});
			try {
				await startupOutboxReplayer.replayOnce();
				const pending = await modules.loadPendingHookTransitions();
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

	const disposeTrackedProject = async (
		projectId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): Promise<{ terminalManager: TerminalSessionManager | null; projectPath: string | null }> => {
		const disposed = projectRegistry.disposeProject(projectId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		await runtimeHub.disposeProject(projectId);
		return disposed;
	};

	return {
		projectRegistry,
		runtimeHub,
		boardCommands,
		diagnostics,
		disposeTrackedProject,
		warn,
		stopPeriodicBackups: () => {
			modules.stopPeriodicBackups();
		},
	};
}

async function createRuntimeServerHandle(
	modules: Awaited<ReturnType<typeof loadRuntimeStartupModules>>,
	bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapState>>,
	hostLaunch: { capabilities: RuntimeCapabilities; simulationConfigPath: string | null },
): Promise<RuntimeServerHandle> {
	const simulation = hostLaunch.simulationConfigPath
		? await modules.loadRuntimeHostSimulation(hostLaunch.simulationConfigPath)
		: null;
	const hostIntegrations = modules.createRuntimeHostIntegrations({
		capabilities: hostLaunch.capabilities,
		warn: bootstrap.warn,
		simulator: simulation?.simulator,
	});
	const runtimeServer = await modules.createRuntimeServer({
		projectRegistry: bootstrap.projectRegistry,
		runtimeStateHub: bootstrap.runtimeHub,
		boardCommands: bootstrap.boardCommands,
		diagnostics: bootstrap.diagnostics,
		warn: bootstrap.warn,
		resolveInteractiveShellCommand: modules.resolveInteractiveShellCommand,
		hostIntegrations,
		hostEventLedger: simulation?.ledger,
		resolveProjectInputPath: modules.resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository,
		disposeProject: bootstrap.disposeTrackedProject,
		collectProjectWorktreeTaskIdsForRemoval: modules.collectProjectWorktreeTaskIdsForRemoval,
	});

	const close = async () => {
		try {
			await runtimeServer.close();
		} finally {
			setAgentAvailabilityDiagnosticSink(null);
			setRuntimeDiagnosticLogSink(null);
		}
	};

	const shutdown = async (options?: { skipSessionCleanup?: boolean }) => {
		bootstrap.stopPeriodicBackups();
		await runtimeServer.prepareForShutdown({ skipSessionCleanup: options?.skipSessionCleanup ?? false });
		await modules.shutdownRuntimeServer({
			projectRegistry: bootstrap.projectRegistry,
			warn: bootstrap.warn,
			closeRuntimeServer: close,
			skipSessionCleanup: options?.skipSessionCleanup ?? false,
			skipOrphanProcessCleanup: process.env.QUARTERDECK_AGENT_LAB === "1",
		});
	};

	return {
		url: runtimeServer.url,
		hostIntegrations,
		diagnostics: bootstrap.diagnostics,
		close,
		shutdown,
	};
}

async function startServer(hostLaunch: {
	capabilities: RuntimeCapabilities;
	simulationConfigPath: string | null;
}): Promise<RuntimeServerHandle> {
	const warn = createRuntimeWarnLogger();
	const diagnostics = await createRuntimeDiagnostics({
		host: getQuarterdeckRuntimeHost(),
		port: getQuarterdeckRuntimePort(),
		quarterdeckVersion: QUARTERDECK_VERSION,
		captureTier: process.env.QUARTERDECK_AGENT_LAB === "1" ? "agent-lab" : "flight",
	});
	setAgentAvailabilityDiagnosticSink((event) => {
		diagnostics.recordEvent(event.name, event.payload, {}, { level: event.level, essential: true });
	});
	setRuntimeDiagnosticLogSink(diagnostics);
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

		// Keep node-pty-owning server modules behind the standalone on-disk
		// health check. A missing native addon must remain diagnosable instead
		// of failing while the runtime import graph is still being evaluated.
		const modules = await loadRuntimeStartupModules();
		await runRuntimeStartupCleanup(modules, warn);
		const startupAgentCleanup =
			process.env.QUARTERDECK_AGENT_LAB === "1" ? Promise.resolve(null) : startOrphanedAgentCleanup(warn);
		const bootstrap = await createRuntimeBootstrapState(modules, warn, startupAgentCleanup, diagnostics);
		return await createRuntimeServerHandle(modules, bootstrap, hostLaunch);
	} catch (error) {
		setAgentAvailabilityDiagnosticSink(null);
		setRuntimeDiagnosticLogSink(null);
		await diagnostics.fail(error).catch(() => undefined);
		throw error;
	}
}

async function startServerWithAutoPortRetry(options: CliOptions): Promise<RuntimeServerHandle> {
	const hostLaunch = {
		capabilities: createRuntimeCapabilities(
			options.hostSimulationConfigPath ? "simulated" : options.nativeUiAvailable ? "native" : "unavailable",
		),
		simulationConfigPath: options.hostSimulationConfigPath,
	};
	if (options.port?.mode !== "auto") {
		return await startServer(hostLaunch);
	}

	while (true) {
		try {
			return await startServer(hostLaunch);
		} catch (error) {
			if (!isAddressInUseError(error)) {
				throw error;
			}
			const currentPort = getQuarterdeckRuntimePort();
			const retryPort = await findAvailableRuntimePort(currentPort + 1);
			setQuarterdeckRuntimePort(retryPort);
			console.warn(`Runtime port ${currentPort} became busy during startup, retrying on ${retryPort}.`);
		}
	}
}

async function runMainCommand(options: CliOptions, shouldAutoOpenBrowser: boolean): Promise<void> {
	if (options.host) {
		setQuarterdeckRuntimeHost(options.host);
		console.log(`Binding to host ${options.host}.`);
	}

	const selectedPort = await applyRuntimePortOption(options.port);
	if (selectedPort !== null) {
		console.log(`Using runtime port ${selectedPort}.`);
	}

	let runtime: RuntimeServerHandle;
	try {
		runtime = await startServerWithAutoPortRetry(options);
	} catch (error) {
		if (
			options.port?.mode !== "auto" &&
			isAddressInUseError(error) &&
			(await tryOpenExistingServer({
				noOpen: options.noOpen,
				shouldAutoOpenBrowser,
				runtimeCapabilities: createRuntimeCapabilities(
					options.hostSimulationConfigPath ? "simulated" : options.nativeUiAvailable ? "native" : "unavailable",
				),
			}))
		) {
			process.exit(0);
		}
		throw error;
	}
	console.log(`Quarterdeck running at ${runtime.url}`);
	if (!options.noOpen && shouldAutoOpenBrowser) {
		runtime.diagnostics.recordEvent(
			"browser.auto_open_requested",
			{ platform: process.platform },
			{},
			{ essential: true },
		);
		const result = await runtime.hostIntegrations.openExternalUrl(runtime.url);
		if (!result.ok) {
			runtime.diagnostics.recordEvent(
				"browser.launcher_failed",
				{ platform: process.platform, reason: result.reason },
				{},
				{ level: "warn", essential: true },
			);
			console.warn(`Could not open browser automatically: ${result.error}`);
		} else {
			runtime.diagnostics.recordEvent(
				"browser.launcher_accepted",
				{ platform: process.platform, outcome: result.outcome },
				{},
				{ essential: true },
			);
			console.log("Browser launcher accepted the Quarterdeck URL.");
		}
	}
	console.log("Press Ctrl+C to stop.");

	let isShuttingDown = false;
	const shutdownIndicator = createShutdownIndicator();
	const shutdown = async () => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;
		if (options.skipShutdownCleanup) {
			console.warn("Skipping shutdown task cleanup for this instance.");
		}
		await runtime.shutdown({
			skipSessionCleanup: options.skipShutdownCleanup,
		});
	};

	const shutdownController = installGracefulShutdownHandlers({
		process,
		// Windows unconditionally terminates a console process roughly ten seconds
		// after console-close SIGHUP, so leave headroom for our own final exit.
		delayMs: process.platform === "win32" ? 8_000 : 10_000,
		exit: (code) => {
			process.exit(code);
		},
		onShutdown: async () => {
			shutdownIndicator.start();
			try {
				await shutdown();
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: (error) => {
			shutdownIndicator.stop("failed");
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Shutdown failed: ${message}`);
		},
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit after shutdown timeout (${delayMs}ms).`);
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit on second signal: ${signal}`);
		},
		suppressImmediateDuplicateSignals: shouldSuppressImmediateDuplicateShutdownSignals(),
	});

	// When quarterdeck is launched as a child process (by Cline, an agent, etc.),
	// stdin is a pipe from the parent. If the parent exits without signaling, the
	// pipe closes — detect that and trigger graceful shutdown so we don't orphan.
	// Only arm this when stdin is a pipe (net.Socket) — not a TTY (direct terminal
	// launch, where SIGHUP already handles close) and not /dev/null (stdio: "ignore"
	// in test harnesses and launchers that intentionally detach stdin).
	if (process.stdin instanceof NetSocket && !process.stdin.isTTY) {
		process.stdin.resume();
		process.stdin.on("end", () => {
			if (!isShuttingDown) {
				console.warn("Parent process disconnected (stdin closed). Shutting down.");
				shutdownController.requestShutdown(process.platform === "win32" ? "SIGTERM" : "SIGHUP");
			}
		});
	}
}

function createProgram(invocationArgs: string[]): Command {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	program
		.name("quarterdeck")
		.description("Local orchestration board for coding agents.")
		.version(QUARTERDECK_VERSION, "-v, --version", "Output the version number")
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--no-open", "Do not open browser automatically.")
		.option("--no-native-ui", "Disable integrations that launch or interact with host-native UI.")
		.option("--skip-shutdown-cleanup", "Skip graceful shutdown cleanup (session marking, orphan process cleanup).")
		.showHelpAfterError()
		.addHelpText("after", `\nRuntime URL: ${getQuarterdeckRuntimeOrigin()}`);

	program.addOption(
		new Option(
			"--simulate-host-integrations <config-path>",
			"Use injected host-integration simulation policy.",
		).hideHelp(),
	);

	registerHooksCommand(program);
	registerStatuslineCommand(program);
	registerBackupCommand(program);
	registerDiagnosticsCommand(program);

	program.action(async (options: RootCommandOptions) => {
		if (options.simulateHostIntegrations && options.nativeUi !== false) {
			throw new Error("--simulate-host-integrations requires --no-native-ui.");
		}
		await runMainCommand(
			{
				host: options.host ?? null,
				port: options.port ?? null,
				noOpen: options.open === false,
				nativeUiAvailable: options.nativeUi !== false,
				hostSimulationConfigPath: options.simulateHostIntegrations ?? null,
				skipShutdownCleanup: options.skipShutdownCleanup === true,
			},
			shouldAutoOpenBrowser,
		);
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const program = createProgram(argv);
	await program.parseAsync(argv, { from: "user" });
	if (!shouldAutoOpenBrowserTabForInvocation(argv)) {
		process.exit(process.exitCode ?? 0);
	}
}

void run().catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start Quarterdeck: ${message}`);
	process.exit(1);
});
