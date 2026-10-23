import pLimit from "p-limit";
import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config";
import type {
	IProjectDataProvider,
	IProjectResolver,
	IRuntimeConfigProvider,
	ITerminalManagerProvider,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectAvailability,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeTaskSessionSummary,
} from "../core";
import {
	areFileSystemPathsEqual,
	createTaggedLogger,
	deriveProjectSummary,
	normalizeDiagnosticErrorClass,
	normalizeRuntimeTaskSessionSummary,
	pruneOrphanSessionsForBroadcast,
} from "../core";
import { CoalescedRefresh } from "../core/coalesced-refresh";
import type { RuntimeDiagnostics } from "../diagnostics";
import type { GitRepositoryProbeResult } from "../projects/git-repository-probe";
import { observeProjectAvailabilityDetailed } from "../projects/project-availability";
import {
	ProjectAvailabilityObserver,
	type ProjectAvailabilityReadMode,
} from "../projects/project-availability-observer";
import {
	isUnderWorktreesHome,
	listProjectIndexEntries,
	loadProjectBoardSnapshotById,
	loadProjectContext,
	loadProjectScopeById,
	loadProjectState,
	loadSavedProjectStateById,
	type RuntimeProjectIndexEntry,
	updateProjectIndexMetadata,
} from "../state";
import { projectBoardReadCache } from "../state/project-board-read-cache.js";
import { upgradeProjectDirectoryIdentities } from "../state/project-directory-identity-upgrade";
import { ProjectExecutionOwnershipStore } from "../state/project-execution-ownership-store";
import { readProjectNavigationIndex } from "../state/project-state-index.js";
import { detectGitRepositoryInfo, invalidateGitRepositoryInfoCache } from "../state/project-state-utils";
import {
	deriveStartupRecoveryPolicy,
	InMemorySessionSummaryStore,
	LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
	TerminalSessionManager,
} from "../terminal";
import { createProjectOrphanMaintenanceTimer, type ProjectOrphanMaintenanceTimer } from "./project-orphan-maintenance";
import { ProjectStateDiagnosticTracker } from "./project-state-diagnostics";
import { ProjectSummaryCache } from "./project-summary-cache";
import { RuntimeStartupCleanupError } from "./runtime-startup-cleanup";
import { type StartupSessionRecoveryCandidate, StartupSessionRecoveryCoordinator } from "./startup-session-recovery";
import { launchPreparedTaskSession, prepareTaskSessionStart } from "./task-session-start-service";

const registryLog = createTaggedLogger("project-registry");
const STARTUP_RESUME_SKIP_SAMPLE_LIMIT = 5;
export const PROJECT_STREAM_VALIDATION_CONCURRENCY = 4;
/** A project-list build serves a project's previous summary once its rebuild exceeds this. */
export const PROJECT_SUMMARY_TIME_BOX_MS = 1_000;

// Startup resume selection is still small enough to live near the registry
// entry point. If it gains more agent-specific rules or scan outcomes, extract
// this block into a dedicated startup-resume policy module with focused tests.
type StartupResumeSkipReason = "missing_summary" | "not_interrupted" | "structured_owner" | "pending_provider_hook";

interface StartupResumeSkipSample {
	taskId: string;
	columnId: RuntimeBoardColumnId;
	reason: StartupResumeSkipReason;
	state?: string | null;
	reviewReason?: string | null;
	pid?: number | null;
	hasWorkingDirectory?: boolean;
	hasResumeSessionId?: boolean;
}

interface StartupResumeScanStats {
	consideredTaskCount: number;
	resumableTaskCount: number;
	skippedMissingSummaryCount: number;
	skippedNotInterruptedCount: number;
	skippedStructuredOwnerCount: number;
	skippedPendingProviderHookCount: number;
	skippedSamples: StartupResumeSkipSample[];
}

function createStartupResumeScanStats(): StartupResumeScanStats {
	return {
		consideredTaskCount: 0,
		resumableTaskCount: 0,
		skippedMissingSummaryCount: 0,
		skippedNotInterruptedCount: 0,
		skippedStructuredOwnerCount: 0,
		skippedPendingProviderHookCount: 0,
		skippedSamples: [],
	};
}

function recordStartupResumeSkip(stats: StartupResumeScanStats, sample: StartupResumeSkipSample): void {
	if (stats.skippedSamples.length < STARTUP_RESUME_SKIP_SAMPLE_LIMIT) {
		stats.skippedSamples.push(sample);
	}
}

export function shouldResumeSessionOnStartup(summary: RuntimeTaskSessionSummary): boolean {
	return deriveStartupRecoveryPolicy(summary).required;
}

function projectSessionsForAvailability(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	availability: RuntimeProjectAvailability,
): Record<string, RuntimeTaskSessionSummary> {
	if (availability.status === "available") return sessions;
	// Preserve durable history while removing process claims from this read-only projection.
	return Object.fromEntries(
		Object.entries(sessions).map(([taskId, summary]) => [
			taskId,
			normalizeRuntimeTaskSessionSummary({ ...summary, pid: null }, { invalidateNativeWorkEvidence: true }),
		]),
	);
}

export interface ProjectRegistryScope {
	projectId: string;
	projectPath: string;
}

export interface CreateProjectRegistryDependencies {
	cwd: string;
	registerCwdProject?: boolean;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (projectId?: string | null) => Promise<RuntimeConfigState>;
	/** Tri-state Git root probe; an indeterminate answer never marks a project unavailable. */
	probeGitRepository: (path: string, projectId?: string) => Promise<GitRepositoryProbeResult>;
	/** Reuse window for definite Git root observations; zero probes on every availability read. */
	gitProbeCacheTtlMs?: number;
	/** A background re-probe changed a project's observed availability. */
	onProjectAvailabilityChanged?: (projectId: string) => void;
	pathIsDirectory: (path: string) => Promise<boolean>;
	waitForStartupAgentCleanup?: () => Promise<void>;
	onTerminalManagerReady?: (projectId: string, manager: TerminalSessionManager) => void;
	/** Override for {@link PROJECT_SUMMARY_TIME_BOX_MS}. */
	projectSummaryTimeBoxMs?: number;
	/** A time-boxed summary finished differently from the previous one a list served; republish the list. */
	onDeferredProjectSummaryReady?: (projectId: string) => void;
	diagnostics?: RuntimeDiagnostics;
}

export interface DisposeProjectRegistryOptions {
	stopTerminalSessions?: boolean;
}

export interface ResolvedProjectStreamTarget {
	projectId: string | null;
	projectPath: string | null;
}

export type { ProjectAvailabilityReadMode };

export type ProjectStatePublicationPreparation =
	| { status: "ready"; state: RuntimeProjectStateResponse }
	/** Removed or moved: a later publication or relocation refresh owns the new location. */
	| { status: "superseded" }
	/** Index metadata advanced while enriching; retry from the latest committed state. */
	| { status: "metadata_changed" };

/** Git could not answer at launch admission; the folder was not judged unavailable. */
export class ProjectGitBusyError extends Error {
	constructor() {
		super("Git is busy checking the project folder. Try again in a moment.");
		this.name = "ProjectGitBusyError";
	}
}

type ProjectsPayloadBase = {
	projects: RuntimeProjectIndexEntry[];
	organization: Awaited<ReturnType<typeof readProjectNavigationIndex>>["organization"];
	summaries: RuntimeProjectSummary[];
};

export type ProjectRemovalPreparationHandler = (
	projectId: string,
	projectPath: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface StartupRecoveryBarrier {
	/** Conservatively retain every interrupted session when the outbox cannot be inspected. */
	blockAllRecovery: boolean;
	/** Exact tasks whose persisted provider transitions remain deferred after startup replay. */
	blockedTasks: ReadonlyArray<{ projectId: string; taskId: string }>;
}

export interface ProjectRegistry
	extends IProjectResolver,
		ITerminalManagerProvider,
		IRuntimeConfigProvider,
		IProjectDataProvider {
	disposeProject: (
		projectId: string,
		options?: DisposeProjectRegistryOptions,
	) => {
		terminalManager: TerminalSessionManager | null;
		projectPath: string | null;
	};
	resolveProjectForStream: (requestedProjectId: string | null) => Promise<ResolvedProjectStreamTarget>;
	/**
	 * Hydrate every valid indexed project before the runtime accepts clients,
	 * then enqueue eligible session recovery without waiting for agent launches.
	 */
	initializeIndexedProjectsForStartup: (options?: {
		/** Runs after every indexed manager is hydrated and before any replacement process is queued. */
		beforeRecovery?: () => Promise<StartupRecoveryBarrier | void>;
	}) => Promise<number>;
	resumeInterruptedSessions: (
		projectId: string,
		projectPath: string,
		options?: { recoveryBarrier?: StartupRecoveryBarrier | null },
	) => Promise<number>;
	/** Releases startup recoveries once their exact deferred hook deliveries have cleared. */
	releaseDeferredStartupRecoveries: (
		pendingTasks: ReadonlyArray<{ projectId: string; taskId: string }>,
	) => Promise<number>;
	resolveTaskSessionSummary: (projectId: string, taskId: string) => Promise<RuntimeTaskSessionSummary | null>;
	setProjectRemovalPreparationHandler: (handler: ProjectRemovalPreparationHandler | null) => void;
	/**
	 * Availability for display and gating. `fresh` (the default) probes Git again;
	 * see `ProjectAvailabilityReadMode` for the reuse modes.
	 */
	checkProjectAvailability: (
		projectId: string,
		mode?: ProjectAvailabilityReadMode,
	) => Promise<RuntimeProjectAvailability>;
	/** For explicit "Check again" UX only: exposes whether this specific fresh probe was indeterminate. */
	checkProjectAvailabilityFreshness: (
		projectId: string,
	) => Promise<{ availability: RuntimeProjectAvailability; indeterminate: boolean }>;
	/** Enrichs a committed projection without acquiring admission or hydrating a session manager. */
	buildProjectStatePublication: (
		projectId: string,
		state: RuntimeProjectStateResponse,
	) => Promise<RuntimeProjectStateResponse | null>;
	/** Same enrichment, reporting why a projection could not be published. */
	prepareProjectStatePublication: (
		projectId: string,
		state: RuntimeProjectStateResponse,
	) => Promise<ProjectStatePublicationPreparation>;
	/** Relocation quiesce: drop cached observations and fence background re-probes. */
	suspendProjectObservation: (projectId: string) => void;
	resumeProjectObservation: (projectId: string) => void;
	rebindProjectLocation: (projectId: string, projectPath: string) => Promise<void>;
	setProjectOperationRunner: (runner: ProjectOperationRunner) => void;
	prepareProjectRemoval: (projectId: string, projectPath: string) => Promise<{ ok: boolean; error?: string }>;
	stopMaintenance: () => void;
	waitForMaintenance?: () => Promise<void>;
	listManagedProjects: () => Array<{
		projectId: string;
		projectPath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

export type ProjectOperationRunner = <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;

export interface ProjectStreamValidationResult {
	project: RuntimeProjectIndexEntry;
	/** Definite, or provisional when `indeterminate` (startup has no prior evidence to carry forward). */
	availability: RuntimeProjectAvailability;
	/** The observation itself had no definite answer. */
	indeterminate: boolean;
}

/**
 * Startup runs before the server listens, so an indeterminate probe here gets
 * no retry: retrying would multiply pre-listen latency by the number of
 * indeterminate projects and can blow past the desktop supervisor's startup
 * window under exactly the load that causes it. An accessible folder whose Git
 * probe could not answer is provisionally available, so startup still hydrates
 * it and queues its recovery; every launch still requires a definite answer,
 * and the probe cache re-probes it in the background.
 */
export async function validateIndexedProjectsForStream(
	projects: RuntimeProjectIndexEntry[],
	deps: Pick<CreateProjectRegistryDependencies, "probeGitRepository" | "pathIsDirectory">,
): Promise<ProjectStreamValidationResult[]> {
	const limit = pLimit(PROJECT_STREAM_VALIDATION_CONCURRENCY);
	return await Promise.all(
		projects.map((project) =>
			limit(async () => {
				const observation = await observeProjectAvailabilityDetailed(project, deps);
				return {
					project,
					availability: observation.availability,
					indeterminate: observation.indeterminate !== null,
				};
			}),
		),
	);
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			if (card.unstarted) continue;
			// De-isolated tasks may still have an orphaned worktree on disk.
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

export async function createProjectRegistry(deps: CreateProjectRegistryDependencies): Promise<ProjectRegistry> {
	await upgradeProjectDirectoryIdentities();
	// The registry's own startup check keeps boolean semantics: an indeterminate
	// probe here is conservatively "not launched from a Git repo," matching
	// `hasGitRepository`'s existing wrapper behavior for this kind of caller.
	const launchedFromGitRepo = (await deps.probeGitRepository(deps.cwd)) === "repository";
	const launchedFromWorktree = isUnderWorktreesHome(deps.cwd);
	const initialIndexedProjects = await listProjectIndexEntries();
	const indexedFolder = initialIndexedProjects.find(
		(entry) => entry.folderOnly && areFileSystemPathsEqual(entry.repoPath, deps.cwd),
	);
	const initialProject =
		deps.registerCwdProject !== false && (launchedFromGitRepo || indexedFolder) && !launchedFromWorktree
			? await loadProjectContext(deps.cwd)
			: null;
	let indexedProject: RuntimeProjectIndexEntry | null = null;
	if (!initialProject) {
		indexedProject = initialIndexedProjects[0] ?? null;
	}

	let activeProjectId: string | null = initialProject?.projectId ?? indexedProject?.projectId ?? null;
	let activeProjectPath: string | null = initialProject?.repoPath ?? indexedProject?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeProjectPath ? await deps.loadRuntimeConfig(activeProjectId) : globalRuntimeConfig;
	const projectPathsById = new Map<string, string>(
		activeProjectId && activeProjectPath ? [[activeProjectId, activeProjectPath]] : [],
	);
	const projectStateDiagnostics = new ProjectStateDiagnosticTracker();
	const executionOwnershipStore = new ProjectExecutionOwnershipStore();
	const terminalManagersByProjectId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();
	const summaryCache = new ProjectSummaryCache();
	const projectSummaryRefreshes = new Map<string, CoalescedRefresh<RuntimeProjectSummary>>();
	const projectSummaryTimeBoxMs = deps.projectSummaryTimeBoxMs ?? PROJECT_SUMMARY_TIME_BOX_MS;
	// Log a time-boxed project once per slow episode, not on every list publication.
	const timeBoxedProjectIds = new Set<string>();
	const projectsPayloadRefresh = new CoalescedRefresh<ProjectsPayloadBase>();
	const availabilityObserver = new ProjectAvailabilityObserver({
		loadScope: loadProjectScopeById,
		pathIsDirectory: deps.pathIsDirectory,
		probeGitRepository: deps.probeGitRepository,
		touchIndex: (projectId, expectedPath) => updateProjectIndexMetadata({ projectId, expectedPath, touch: true }),
		onScopeObserved: (projectId, repoPath) => {
			rememberProject(projectId, repoPath);
			if (activeProjectId === projectId) activeProjectPath = repoPath;
		},
		onAvailabilityChanged: (projectId) => deps.onProjectAvailabilityChanged?.(projectId),
		gitProbeCacheTtlMs: deps.gitProbeCacheTtlMs,
	});
	let runProjectOperation: ProjectOperationRunner = async (_projectId, operation) => await operation();
	const deferredStartupRecoveries = new Map<string, { projectId: string; projectPath: string; taskId: string }>();
	const deferredStartupRecoveryProjects = new Map<string, string>();
	const projectOrphanMaintenance: ProjectOrphanMaintenanceTimer = createProjectOrphanMaintenanceTimer({
		getProjectRepoPaths: () => projectPathsById.values(),
	});
	let projectRemovalPreparationHandler: ProjectRemovalPreparationHandler | null = null;
	if (projectPathsById.size > 0) {
		projectOrphanMaintenance.start();
	}

	const rememberProject = (projectId: string, repoPath: string): void => {
		const wasKnown = projectPathsById.has(projectId);
		projectPathsById.set(projectId, repoPath);
		projectOrphanMaintenance.start();
		if (!wasKnown) deps.diagnostics?.recordEvent("project.registered", {}, { projectId }, { essential: true });
	};

	const observeProjectLocation = (projectId: string, mode: ProjectAvailabilityReadMode) =>
		availabilityObserver.observe(projectId, mode);

	const checkProjectAvailability = async (
		projectId: string,
		mode: ProjectAvailabilityReadMode = "fresh",
	): Promise<RuntimeProjectAvailability> => (await observeProjectLocation(projectId, mode)).availability;

	/**
	 * Surfaces whether *this* fresh probe was indeterminate, distinct from
	 * `checkProjectAvailability`'s carried-forward result. Explicit "Check again"
	 * uses this to tell the user the check itself could not complete, instead of
	 * silently reporting earlier evidence as a confirmed answer.
	 */
	const checkProjectAvailabilityFreshness = async (
		projectId: string,
	): Promise<{ availability: RuntimeProjectAvailability; indeterminate: boolean }> => {
		const { availability, indeterminate } = await observeProjectLocation(projectId, "fresh");
		return { availability, indeterminate };
	};

	const assertProjectLaunchAvailable = async (
		projectId: string,
		projectPath: string,
		manager: TerminalSessionManager,
	): Promise<void> => {
		// Launch admission never relies on the reuse window. An indeterminate Git
		// answer is retried once and then reported as retryable, not as unavailable.
		let observed = await observeProjectLocation(projectId, "fresh");
		if (observed.indeterminate) observed = await observeProjectLocation(projectId, "fresh");
		if (observed.indeterminate) throw new ProjectGitBusyError();
		if (
			observed.availability.status !== "available" ||
			!areFileSystemPathsEqual(projectPathsById.get(projectId) ?? "", projectPath) ||
			terminalManagersByProjectId.get(projectId) !== manager
		) {
			throw new Error("Project folder is unavailable or has moved. Locate the folder before starting a session.");
		}
	};

	const configureManagerLaunchAdmission = (
		projectId: string,
		projectPath: string,
		manager: TerminalSessionManager,
	): void => {
		manager.setLaunchOperationRunner(async (operation) => {
			return await runProjectOperation(projectId, async () => {
				await assertProjectLaunchAvailable(projectId, projectPath, manager);
				return await operation();
			});
		});
	};

	const stopOrphanMaintenanceIfIdle = (): void => {
		if (projectPathsById.size === 0) {
			projectOrphanMaintenance.stop();
		}
	};

	const prepareProjectRemoval = async (
		projectId: string,
		projectPath: string,
	): Promise<{ ok: boolean; error?: string }> =>
		projectRemovalPreparationHandler ? await projectRemovalPreparationHandler(projectId, projectPath) : { ok: true };

	const notifyTerminalManagerReady = (projectId: string, manager: TerminalSessionManager): void => {
		deps.onTerminalManagerReady?.(projectId, manager);
	};

	const getTerminalManagerForProject = (projectId: string): TerminalSessionManager | null => {
		return terminalManagersByProjectId.get(projectId) ?? null;
	};

	const ensureTerminalManagerForProject = async (
		projectId: string,
		repoPath: string,
	): Promise<TerminalSessionManager> => {
		rememberProject(projectId, repoPath);
		const existing = terminalManagersByProjectId.get(projectId);
		if (existing) {
			notifyTerminalManagerReady(projectId, existing);
			return existing;
		}
		const pending = terminalManagerLoadPromises.get(projectId);
		if (pending) {
			const loaded = await pending;
			notifyTerminalManagerReady(projectId, loaded);
			return loaded;
		}
		const loading = (async () => {
			const store = new InMemorySessionSummaryStore();
			const manager = new TerminalSessionManager(store, { projectId, diagnostics: deps.diagnostics });
			const existingProject = await loadProjectState(repoPath, { autoCreateIfMissing: false });
			manager.hydrateFromRecord(existingProject.sessions);
			const hydratedSessionCount = Object.keys(existingProject.sessions).length;
			manager.startReconciliation();
			terminalManagersByProjectId.set(projectId, manager);
			configureManagerLaunchAdmission(projectId, repoPath, manager);
			registryLog.debug("terminal manager created", {
				projectId,
				hasProjectPath: repoPath.length > 0,
				hydratedSessionCount,
			});
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(projectId);
		});
		terminalManagerLoadPromises.set(projectId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(projectId, loaded);
		return loaded;
	};

	const prepareTerminalManagerForProject = async (
		projectId: string,
		repoPath: string,
		phase: "selection" | "startup",
	): Promise<boolean> => {
		try {
			await ensureTerminalManagerForProject(projectId, repoPath);
			return true;
		} catch (error) {
			// Project selection and runtime startup must remain available so the
			// browser can surface the durable-state error. The throwing ensure path
			// remains the gate for every operation that actually needs session truth;
			// never substitute an empty manager for unreadable persisted sessions.
			registryLog.warn("terminal manager hydration unavailable", {
				projectId,
				hasProjectPath: repoPath.length > 0,
				phase,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			deps.diagnostics?.recordEvent(
				"project.session_hydration_failed",
				{
					phase,
					errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
				},
				{ projectId },
				{ level: "error", essential: true },
			);
			return false;
		}
	};

	const resolveTaskSessionSummary = async (
		projectId: string,
		taskId: string,
	): Promise<RuntimeTaskSessionSummary | null> => {
		const manager = terminalManagersByProjectId.get(projectId);
		if (manager) {
			return manager.store.getSummary(taskId);
		}
		const pendingManager = terminalManagerLoadPromises.get(projectId);
		if (pendingManager) {
			return (await pendingManager).store.getSummary(taskId);
		}
		const state = await loadSavedProjectStateById(projectId);
		return state?.sessions[taskId] ?? null;
	};

	const loadScopedRuntimeConfig = async (scope: ProjectRegistryScope): Promise<RuntimeConfigState> => {
		if (scope.projectId === activeProjectId) {
			return activeRuntimeConfig;
		}
		return await deps.loadRuntimeConfig(scope.projectId);
	};

	const startupRecoveryCoordinator = new StartupSessionRecoveryCoordinator({
		waitForPrerequisite: deps.waitForStartupAgentCleanup,
		prepare: async (candidate, options) =>
			await runProjectOperation(candidate.scope.projectId, async () => {
				await assertProjectLaunchAvailable(
					candidate.scope.projectId,
					candidate.scope.projectPath,
					candidate.manager,
				);
				const prepared = await prepareTaskSessionStart(
					candidate.scope,
					candidate.request,
					{
						config: { loadScopedRuntimeConfig },
						getScopedTerminalManager: async () => candidate.manager,
					},
					options,
				);
				return prepared;
			}),
		// The manager's launch runner fences every frozen recovery attempt too.
		launch: launchPreparedTaskSession,
	});

	const setActiveProject = async (projectId: string): Promise<void> =>
		await runProjectOperation(projectId, async () => {
			const scope = await loadProjectScopeById(projectId);
			if (!scope) throw new Error("Project is no longer registered.");
			activeProjectId = projectId;
			activeProjectPath = scope.repoPath;
			rememberProject(projectId, scope.repoPath);
			activeRuntimeConfig = await deps.loadRuntimeConfig(projectId);
			globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
			if ((await checkProjectAvailability(projectId, "cached")).status === "available") {
				await prepareTerminalManagerForProject(projectId, scope.repoPath, "selection");
			}
		});

	const clearActiveProject = (): void => {
		activeProjectId = null;
		activeProjectPath = null;
		activeRuntimeConfig = globalRuntimeConfig;
	};

	const disposeProject = (
		projectId: string,
		options?: DisposeProjectRegistryOptions,
	): { terminalManager: TerminalSessionManager | null; projectPath: string | null } => {
		const terminalManager = getTerminalManagerForProject(projectId);
		if (terminalManager) {
			if (options?.stopTerminalSessions !== false) {
				terminalManager.markInterruptedAndStopAll();
			}
			terminalManagersByProjectId.delete(projectId);
			terminalManagerLoadPromises.delete(projectId);
		}
		projectStateDiagnostics.remove(projectId);
		const projectPath = projectPathsById.get(projectId) ?? null;
		projectPathsById.delete(projectId);
		availabilityObserver.forget(projectId);
		summaryCache.purge(projectId);
		projectSummaryRefreshes.delete(projectId);
		timeBoxedProjectIds.delete(projectId);
		projectBoardReadCache.forget(projectId);
		if (projectPath) invalidateGitRepositoryInfoCache(projectPath);
		for (const [key, deferred] of deferredStartupRecoveries) {
			if (deferred.projectId === projectId) deferredStartupRecoveries.delete(key);
		}
		deferredStartupRecoveryProjects.delete(projectId);
		deps.diagnostics?.recordEvent(
			"project.removed",
			{ stoppedSessions: options?.stopTerminalSessions !== false },
			{ projectId },
			{ essential: true },
		);
		stopOrphanMaintenanceIfIdle();
		return {
			terminalManager,
			projectPath,
		};
	};

	const rebindProjectLocation = async (projectId: string, projectPath: string): Promise<void> => {
		const scope = await loadProjectScopeById(projectId);
		if (!scope || !areFileSystemPathsEqual(scope.repoPath, projectPath)) {
			throw new Error("Project location changed before runtime refresh completed.");
		}
		const pending = terminalManagerLoadPromises.get(projectId);
		if (pending) await pending;
		const manager = terminalManagersByProjectId.get(projectId);
		if (manager) {
			await manager.waitForShutdownQuiescence();
			manager.stopReconciliation();
			terminalManagersByProjectId.delete(projectId);
		}
		terminalManagerLoadPromises.delete(projectId);
		for (const [key, deferred] of deferredStartupRecoveries) {
			if (deferred.projectId === projectId) deferredStartupRecoveries.delete(key);
		}
		deferredStartupRecoveryProjects.delete(projectId);
		// Observations of the previous location say nothing about the new one.
		const previousPath = projectPathsById.get(projectId);
		availabilityObserver.reset(projectId);
		summaryCache.purge(projectId);
		if (previousPath && !areFileSystemPathsEqual(previousPath, scope.repoPath)) {
			invalidateGitRepositoryInfoCache(previousPath);
		}
		rememberProject(projectId, scope.repoPath);
		if (activeProjectId === projectId) {
			activeProjectPath = scope.repoPath;
			activeRuntimeConfig = await deps.loadRuntimeConfig(projectId);
			globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
		}
		if ((await checkProjectAvailability(projectId)).status === "available") {
			await prepareTerminalManagerForProject(projectId, scope.repoPath, "selection");
		}
	};

	const buildProjectSummary = async (projectId: string, repoPath: string): Promise<RuntimeProjectSummary> => {
		const cacheEpoch = summaryCache.epoch(projectId);
		// List rebuilds never spawn Git for a project already observed: they reuse its
		// last Git answer, while directory, identity, and journal checks still run.
		const availability = await checkProjectAvailability(projectId, "lastKnown");
		const scope = await loadProjectScopeById(projectId);
		const summaryInput = {
			projectId,
			repoPath: scope?.repoPath ?? repoPath,
			folderOnly: scope?.folderOnly,
			displayName: scope?.displayName,
			metadataRevision: scope?.metadataRevision,
			availability,
		};
		// Validate by board revision before reading and parsing the board. The
		// revision read is lock-free while meta.json is unchanged, so publications
		// do not queue behind (or ahead of) every project's hook ingest.
		const cached = summaryCache.get(projectId, {
			...summaryInput,
			boardRevision: await projectBoardReadCache.loadBoardRevision(projectId),
		});
		if (cached) return cached;
		const snapshot = await loadProjectBoardSnapshotById(projectId);
		const summary = deriveProjectSummary({
			...summaryInput,
			board: snapshot.board,
			boardRevision: snapshot.revision,
		});
		summaryCache.set(projectId, { ...summaryInput, boardRevision: snapshot.revision }, summary, cacheEpoch);
		return summary;
	};

	/**
	 * One slow project (a long-held state lock, a stalled disk) must not hold the
	 * whole list. Rebuilds per project are coalesced, so a stuck one never piles
	 * up waiters; past the time box the list serves that project's previous
	 * summary, and a later different result requests a fresh list publication.
	 */
	const buildProjectSummaryTimeBoxed = async (projectId: string, repoPath: string): Promise<RuntimeProjectSummary> => {
		let refresh = projectSummaryRefreshes.get(projectId);
		if (!refresh) {
			refresh = new CoalescedRefresh<RuntimeProjectSummary>();
			projectSummaryRefreshes.set(projectId, refresh);
		}
		const build = refresh.run(async () => await buildProjectSummary(projectId, repoPath));
		const previous = summaryCache.getLast(projectId, repoPath);
		if (!previous) return await build;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), projectSummaryTimeBoxMs);
			timer.unref();
		});
		try {
			const summary = await Promise.race([build, timedOut]);
			if (summary) {
				timeBoxedProjectIds.delete(projectId);
				return summary;
			}
		} finally {
			clearTimeout(timer);
		}
		if (!timeBoxedProjectIds.has(projectId)) {
			timeBoxedProjectIds.add(projectId);
			registryLog.warn("project summary exceeded its time box; serving the previous summary", {
				projectId,
				timeBoxMs: projectSummaryTimeBoxMs,
			});
		}
		void build.then(
			(summary) => {
				if (summary !== previous) deps.onDeferredProjectSummaryReady?.(projectId);
			},
			() => {},
		);
		return previous;
	};

	const buildProjectStateSnapshot = async (projectId: string): Promise<RuntimeProjectStateResponse> =>
		await runProjectOperation(projectId, async () => {
			// A snapshot may hydrate and publish a manager. Hold admission through
			// that publication so relocation cannot dispose its owner mid-read.
			const availability = await checkProjectAvailability(projectId, "cached");
			const scope = await loadProjectScopeById(projectId);
			if (!scope) throw new Error("Project is no longer registered.");
			const response =
				availability.status === "available"
					? await loadProjectState(scope.repoPath, { autoCreateIfMissing: false })
					: await loadSavedProjectStateById(projectId);
			if (!response) throw new Error("Project is no longer registered.");
			response.availability = availability;
			if (availability.status === "available") {
				const terminalManager = await ensureTerminalManagerForProject(projectId, scope.repoPath);
				for (const summary of terminalManager.store.listSummaries()) {
					response.sessions[summary.taskId] = summary;
				}
			}
			response.sessions = projectSessionsForAvailability(response.sessions, availability);
			response.sessions = pruneOrphanSessionsForBroadcast(response.sessions, response.board);
			projectStateDiagnostics.observe(projectId, response);
			return response;
		});

	const prepareProjectStatePublication = async (
		projectId: string,
		state: RuntimeProjectStateResponse,
	): Promise<ProjectStatePublicationPreparation> => {
		// Publication can run while relocation drains runtime persistence owners inside
		// its exclusion. Read metadata only: admission or manager hydration here can
		// deadlock that drain or resurrect a manager whose subscriptions were disposed.
		const { scope, availability } = await observeProjectLocation(projectId, "cached");
		if (!scope || scope.repoPath !== state.repoPath) return { status: "superseded" };
		const git =
			availability.status === "available" && !scope.folderOnly
				? await detectGitRepositoryInfo(scope.repoPath)
				: {
						...(scope.folderOnly ? { folderOnly: true } : {}),
						currentBranch: null,
						defaultBranch: null,
						branches: [],
					};
		const currentScope = await loadProjectScopeById(projectId);
		if (!currentScope || currentScope.repoPath !== scope.repoPath) return { status: "superseded" };
		if (currentScope.metadataRevision !== scope.metadataRevision) return { status: "metadata_changed" };
		return {
			status: "ready",
			state: {
				...state,
				git,
				availability,
				metadataRevision: scope.metadataRevision,
				sessions: projectSessionsForAvailability(state.sessions, availability),
			},
		};
	};

	const buildProjectStatePublication = async (
		projectId: string,
		state: RuntimeProjectStateResponse,
	): Promise<RuntimeProjectStateResponse | null> => {
		const prepared = await prepareProjectStatePublication(projectId, state);
		return prepared.status === "ready" ? prepared.state : null;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		// Concurrent publications share one build; a caller arriving mid-build waits
		// for the follow-up so it never receives summaries older than its request.
		const { projects, organization, summaries } = await projectsPayloadRefresh.run(async () => {
			const { entries, organization } = await readProjectNavigationIndex();
			const limit = pLimit(PROJECT_STREAM_VALIDATION_CONCURRENCY);
			return {
				projects: entries,
				organization,
				summaries: await Promise.all(
					entries.map((project) => limit(() => buildProjectSummaryTimeBoxed(project.projectId, project.repoPath))),
				),
			};
		});
		const fallbackProjectId =
			projects.find((project) => project.projectId === activeProjectId)?.projectId ?? projects[0]?.projectId ?? null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.projectId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: summaries,
			organization,
		};
	};

	const suspendProjectObservation = (projectId: string): void => {
		availabilityObserver.fence(projectId);
		summaryCache.purge(projectId);
	};

	const resumeProjectObservation = (projectId: string): void => {
		availabilityObserver.unfence(projectId);
	};

	const inspectIndexedProjects = async (): Promise<{
		indexedProjects: RuntimeProjectIndexEntry[];
		existingProjects: RuntimeProjectIndexEntry[];
		unavailableProjects: RuntimeProjectIndexEntry[];
	}> => {
		const allProjects = await listProjectIndexEntries();
		// One Git probe per project: it goes through the observer's probe cache, so
		// startup selection and recovery reuse it instead of probing again.
		const validationResults = await validateIndexedProjectsForStream(allProjects, {
			pathIsDirectory: deps.pathIsDirectory,
			probeGitRepository: (path, projectId) =>
				projectId
					? availabilityObserver.probeGitRepository(projectId, path, "cached")
					: deps.probeGitRepository(path),
		});
		const existingProjects: RuntimeProjectIndexEntry[] = [];
		const unavailableProjects: RuntimeProjectIndexEntry[] = [];

		for (const { project, availability, indeterminate } of validationResults) {
			// Seed carry-forward evidence from every definite startup verdict, so a
			// later load-induced timeout has real evidence to carry forward. Seeding
			// never replaces an observation another caller already recorded.
			if (!indeterminate) await availabilityObserver.seed(project.projectId, project, availability);

			if (availability.status === "available") {
				existingProjects.push(project);
				continue;
			}

			unavailableProjects.push(project);
			deps.diagnostics?.recordEvent(
				"project.startup_availability_failed",
				indeterminate
					? { indeterminate: true, folderOnly: project.folderOnly === true }
					: { reason: availability.reason, folderOnly: project.folderOnly === true, indeterminate: false },
				{ projectId: project.projectId },
				{ level: "warn", essential: true },
			);
		}
		return { indexedProjects: allProjects, existingProjects, unavailableProjects };
	};

	const selectAvailableActiveProject = async (existingProjects: RuntimeProjectIndexEntry[]): Promise<void> => {
		const activeProjectMissing = !existingProjects.some((project) => project.projectId === activeProjectId);
		if (activeProjectMissing) {
			if (existingProjects[0]) {
				await setActiveProject(existingProjects[0].projectId);
			} else {
				clearActiveProject();
			}
		}
	};

	const resolveProjectForStream = async (requestedProjectId: string | null): Promise<ResolvedProjectStreamTarget> => {
		// Selection is an identity operation. An unavailable path still owns its
		// saved board and must remain selectable until the user removes it.
		const projects = await listProjectIndexEntries();
		const selected =
			projects.find((project) => project.projectId === requestedProjectId) ??
			projects.find((project) => project.projectId === activeProjectId) ??
			projects[0] ??
			null;
		if (selected) {
			if (
				activeProjectId !== selected.projectId ||
				!areFileSystemPathsEqual(activeProjectPath ?? "", selected.repoPath)
			) {
				await setActiveProject(selected.projectId);
			} else {
				await checkProjectAvailability(selected.projectId, "cached");
			}
		} else {
			clearActiveProject();
		}
		return {
			projectId: selected?.projectId ?? null,
			projectPath: selected?.repoPath ?? null,
		};
	};

	/**
	 * Resume only persisted work-column sessions that were interrupted by the
	 * previous runtime. Each eligible task enters the global recovery
	 * coordinator, which waits for orphan cleanup, serializes launches, confirms
	 * a launch-scoped hook, and permits one exact-target retry.
	 */
	const resumeInterruptedSessions = async (
		projectId: string,
		projectPath: string,
		options: { recoveryBarrier?: StartupRecoveryBarrier | null } = {},
	): Promise<number> => {
		const acquired = await runProjectOperation(projectId, async () => {
			// Reuses startup's Git answer however long hydration took; every launch
			// below still passes fresh admission.
			if ((await checkProjectAvailability(projectId, "lastKnown")).status !== "available") return null;
			if (!areFileSystemPathsEqual(projectPathsById.get(projectId) ?? "", projectPath)) return null;
			const manager = await ensureTerminalManagerForProject(projectId, projectPath);
			try {
				const state = await loadProjectState(projectPath, { autoCreateIfMissing: false });
				deferredStartupRecoveryProjects.delete(projectId);
				return { manager, state };
			} catch (error) {
				deferredStartupRecoveryProjects.set(projectId, projectPath);
				registryLog.warn("startup resume deferred: failed to load project state", {
					projectId,
					hasProjectPath: projectPath.length > 0,
					errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
				});
				throw error;
			}
		});
		if (!acquired) return 0;
		// Only acquisition holds admission. Recovery preparation and each launch
		// validate this manager again without blocking relocation on readiness waits.
		const { manager, state } = acquired;
		const resumable: StartupSessionRecoveryCandidate[] = [];
		let ownershipByTask: Map<string, Awaited<ReturnType<ProjectExecutionOwnershipStore["listOwnership"]>>[number]>;
		try {
			ownershipByTask = new Map(
				(await executionOwnershipStore.listOwnership({ projectId, projectPath })).map((ownership) => [
					ownership.taskId,
					ownership,
				]),
			);
		} catch (error) {
			registryLog.warn("startup native recovery failed closed on execution ownership state", {
				projectId,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			return 0;
		}
		// Startup resume runs before a user can inspect task terminals, so keep
		// enough scan detail to tell whether we never selected a task or failed
		// after selection.
		const scanStats = createStartupResumeScanStats();
		for (const column of state.board.columns) {
			if (column.id !== "in_progress" && column.id !== "review") {
				continue;
			}
			for (const card of column.cards) {
				if (card.unstarted) continue;
				scanStats.consideredTaskCount += 1;
				const executionOwnership = ownershipByTask.get(card.id);
				if (
					executionOwnership &&
					(executionOwnership.state !== "native_tui" || executionOwnership.ownerProcess?.processKind !== "pty")
				) {
					scanStats.skippedStructuredOwnerCount += 1;
					recordStartupResumeSkip(scanStats, {
						taskId: card.id,
						columnId: column.id,
						reason: "structured_owner",
					});
					continue;
				}
				const summary = manager.store.getSummary(card.id);
				if (!summary) {
					scanStats.skippedMissingSummaryCount += 1;
					recordStartupResumeSkip(scanStats, {
						taskId: card.id,
						columnId: column.id,
						reason: "missing_summary",
						hasWorkingDirectory: Boolean(card.workingDirectory),
					});
					continue;
				}
				const blockedByPendingProviderHook =
					options.recoveryBarrier?.blockAllRecovery === true ||
					options.recoveryBarrier?.blockedTasks.some(
						(blocked) => blocked.projectId === projectId && blocked.taskId === card.id,
					) === true;
				if (blockedByPendingProviderHook) {
					deferredStartupRecoveries.set(JSON.stringify([projectId, card.id]), {
						projectId,
						projectPath,
						taskId: card.id,
					});
					scanStats.skippedPendingProviderHookCount += 1;
					recordStartupResumeSkip(scanStats, {
						taskId: card.id,
						columnId: column.id,
						reason: "pending_provider_hook",
						state: summary.state,
						reviewReason: summary.reviewReason,
						pid: summary.pid,
						hasWorkingDirectory: Boolean(card.workingDirectory),
						hasResumeSessionId: Boolean(summary.resumeSessionId),
					});
					continue;
				}
				deferredStartupRecoveries.delete(JSON.stringify([projectId, card.id]));
				const recoveryPolicy = deriveStartupRecoveryPolicy(summary);
				if (!recoveryPolicy.required) {
					scanStats.skippedNotInterruptedCount += 1;
					recordStartupResumeSkip(scanStats, {
						taskId: card.id,
						columnId: column.id,
						reason: "not_interrupted",
						state: summary.state,
						reviewReason: summary.reviewReason,
						pid: summary.pid,
						hasWorkingDirectory: Boolean(card.workingDirectory),
						hasResumeSessionId: Boolean(summary.resumeSessionId),
					});
					continue;
				}
				resumable.push({
					scope: { projectId, projectPath },
					manager,
					originalResumeSessionId: summary.resumeSessionId ?? null,
					semanticState: recoveryPolicy.semanticState,
					semanticStateUncertain: recoveryPolicy.semanticStateUncertain,
					fallbackReviewState: recoveryPolicy.fallbackReviewState,
					semanticStateWarning: recoveryPolicy.semanticStateUncertain
						? LEGACY_STARTUP_SEMANTIC_STATE_WARNING
						: undefined,
					request: {
						taskId: card.id,
						prompt: "",
						agentId: card.agentId,
						resumeConversation: true,
						awaitReview: true,
						baseRef: card.baseRef,
						useWorktree: card.useWorktree,
					},
				});
			}
		}
		scanStats.resumableTaskCount = resumable.length;
		deps.diagnostics?.recordEvent(
			"session.startup_recovery_scan_completed",
			{
				consideredTaskCount: scanStats.consideredTaskCount,
				resumableTaskCount: scanStats.resumableTaskCount,
				skippedMissingSummaryCount: scanStats.skippedMissingSummaryCount,
				skippedNotInterruptedCount: scanStats.skippedNotInterruptedCount,
				skippedStructuredOwnerCount: scanStats.skippedStructuredOwnerCount,
				skippedPendingProviderHookCount: scanStats.skippedPendingProviderHookCount,
			},
			{ projectId },
			{ essential: true },
		);
		registryLog.info("startup resume scan complete", {
			projectId,
			hasProjectPath: projectPath.length > 0,
			...scanStats,
		});
		if (resumable.length === 0) {
			if (scanStats.consideredTaskCount > 0) {
				registryLog.warn("startup resume found work-column sessions but no resumable interrupted tasks", {
					projectId,
					hasProjectPath: projectPath.length > 0,
					...scanStats,
				});
			}
			return 0;
		}
		for (const candidate of resumable) {
			const persistedSummary = state.sessions[candidate.request.taskId] ?? null;
			deps.diagnostics?.recordEvent(
				"session.startup_recovery_queued",
				{
					state: persistedSummary?.state ?? null,
					reviewReason: persistedSummary?.reviewReason ?? null,
					hadPersistedPid: persistedSummary?.pid != null,
					hasResumeSessionId: candidate.originalResumeSessionId !== null,
					semanticStateUncertain: candidate.semanticStateWarning !== undefined,
				},
				{ projectId, taskId: candidate.request.taskId },
				{ essential: true },
			);
			registryLog.info("startup resume queued task", {
				projectId,
				taskId: candidate.request.taskId,
				cardAgentId: candidate.request.agentId ?? null,
				hasResumeSessionId: candidate.originalResumeSessionId !== null,
				semanticStateUncertain: candidate.semanticStateWarning !== undefined,
			});
		}
		const results = await Promise.all(
			resumable.map(async (candidate) => {
				const result = await startupRecoveryCoordinator.enqueue(candidate);
				const failed = result.status === "exhausted";
				const unconfirmed = result.status === "unconfirmed";
				deps.diagnostics?.recordEvent(
					"session.startup_recovery_completed",
					{
						status: result.status,
						attempts: result.attempts,
						reason: failed || unconfirmed ? result.reason : null,
					},
					{
						projectId,
						taskId: candidate.request.taskId,
						...(unconfirmed ? { sessionInstanceId: result.sessionInstanceId } : {}),
					},
					{ level: failed ? "error" : "info", essential: true },
				);
				return result;
			}),
		);
		registryLog.info("startup recovery complete; unconfirmed chats remain available without hook confirmation", {
			projectId,
			taskCount: results.length,
			readyCount: results.filter((result) => result.status === "ready").length,
			unconfirmedCount: results.filter((result) => result.status === "unconfirmed").length,
			failedCount: results.filter((result) => result.status === "exhausted").length,
			userEngagedCount: results.filter((result) => result.status === "user_engaged").length,
			skippedCount: results.filter((result) => ["cancelled", "duplicate", "closed"].includes(result.status)).length,
		});
		return resumable.length;
	};

	const releaseDeferredStartupRecoveries = async (
		pendingTasks: ReadonlyArray<{ projectId: string; taskId: string }>,
	): Promise<number> => {
		const pendingKeys = new Set(pendingTasks.map((task) => JSON.stringify([task.projectId, task.taskId])));
		const projectsToRetry = new Map(deferredStartupRecoveryProjects);
		let releasedTaskCount = 0;
		for (const [key, deferred] of deferredStartupRecoveries) {
			if (pendingKeys.has(key)) continue;
			deferredStartupRecoveries.delete(key);
			projectsToRetry.set(deferred.projectId, deferred.projectPath);
			releasedTaskCount += 1;
		}
		if (releasedTaskCount === 0 && projectsToRetry.size === 0) return 0;

		const recoveryBarrier: StartupRecoveryBarrier = {
			blockAllRecovery: false,
			blockedTasks: pendingTasks,
		};
		await Promise.all(
			Array.from(projectsToRetry, async ([projectId, projectPath]) => {
				try {
					await resumeInterruptedSessions(projectId, projectPath, { recoveryBarrier });
				} catch (error) {
					registryLog.warn("deferred startup recovery retry failed", {
						projectId,
						hasProjectPath: projectPath.length > 0,
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
					});
					deps.diagnostics?.recordEvent(
						"session.startup_recovery_deferred_retry_failed",
						{
							errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						},
						{ projectId },
						{ level: "warn", essential: true },
					);
				}
			}),
		);
		deps.diagnostics?.recordEvent(
			"session.startup_recovery_deferred_released",
			{ releasedTaskCount, projectCount: projectsToRetry.size },
			{},
			{ essential: true },
		);
		return releasedTaskCount;
	};

	let indexedProjectInitialization: Promise<number> | null = null;
	const initializeIndexedProjectsForStartup = (options?: {
		beforeRecovery?: () => Promise<StartupRecoveryBarrier | void>;
	}): Promise<number> => {
		if (indexedProjectInitialization) {
			return indexedProjectInitialization;
		}

		indexedProjectInitialization = (async () => {
			const { indexedProjects, existingProjects, unavailableProjects } = await inspectIndexedProjects();
			for (const project of unavailableProjects) {
				registryLog.warn("startup skipped unavailable indexed project without pruning saved state", {
					projectId: project.projectId,
					hasProjectPath: project.repoPath.length > 0,
				});
			}
			await selectAvailableActiveProject(indexedProjects);
			const hydrateLimit = pLimit(PROJECT_STREAM_VALIDATION_CONCURRENCY);
			const hydrationResults = await Promise.all(
				existingProjects.map(async (project) => ({
					project,
					ready: await hydrateLimit(
						async () => await prepareTerminalManagerForProject(project.projectId, project.repoPath, "startup"),
					),
				})),
			);
			const hydratedProjects = hydrationResults.filter((result) => result.ready).map((result) => result.project);
			const recoveryBarrier = (await options?.beforeRecovery?.()) ?? null;

			for (const project of hydratedProjects) {
				void resumeInterruptedSessions(project.projectId, project.repoPath, { recoveryBarrier }).catch((error) => {
					registryLog.warn("startup recovery failed for indexed project", {
						projectId: project.projectId,
						hasProjectPath: project.repoPath.length > 0,
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
					});
					deps.diagnostics?.recordEvent(
						"session.startup_recovery_project_failed",
						{
							errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						},
						{ projectId: project.projectId },
						{ level: "warn", essential: true },
					);
				});
			}

			deps.diagnostics?.recordEvent(
				"session.startup_recovery_projects_initialized",
				{
					projectCount: hydratedProjects.length,
					skippedProjectCount: unavailableProjects.length,
					hydrationFailureCount: existingProjects.length - hydratedProjects.length,
				},
				{},
				{ essential: true },
			);
			return hydratedProjects.length;
		})().catch((error) => {
			indexedProjectInitialization = null;
			throw error;
		});
		return indexedProjectInitialization;
	};

	let disposeDiagnosticProvider: (() => void) | undefined;
	let disposeProjectStateDiagnosticProvider: (() => void) | undefined;
	try {
		if (initialProject && (await checkProjectAvailability(initialProject.projectId)).status === "available") {
			await prepareTerminalManagerForProject(initialProject.projectId, initialProject.repoPath, "startup");
		}

		disposeDiagnosticProvider = deps.diagnostics?.registerSnapshotProvider({
			name: "projects",
			capture: (scope) => {
				const sessions = Array.from(terminalManagersByProjectId.entries()).flatMap(([projectId, manager]) =>
					!scope.projectId || projectId === scope.projectId ? manager.getDiagnosticSnapshot(scope).sessions : [],
				);
				const taskProjectIds = new Set(sessions.map((session) => session.projectId));
				const visibleProjectIds = Array.from(projectPathsById.keys()).filter(
					(projectId) =>
						(!scope.projectId || projectId === scope.projectId) &&
						(!scope.taskId || Boolean(scope.projectId) || taskProjectIds.has(projectId)),
				);
				return {
					activeProjectId: activeProjectId && visibleProjectIds.includes(activeProjectId) ? activeProjectId : null,
					managedProjects: visibleProjectIds.map((projectId) => ({
						projectId,
						hasTerminalManager: terminalManagersByProjectId.has(projectId),
					})),
					sessions,
				};
			},
		});
		disposeProjectStateDiagnosticProvider = deps.diagnostics?.registerSnapshotProvider({
			name: "project_state",
			capture: (scope) => projectStateDiagnostics.getSnapshot(scope),
		});

		return {
			getActiveProjectId: () => activeProjectId,
			getActiveProjectPath: () => activeProjectPath,
			getProjectPathById: (projectId: string) => projectPathsById.get(projectId) ?? null,
			rememberProject,
			getActiveRuntimeConfig: () => activeRuntimeConfig,
			setActiveRuntimeConfig: (config: RuntimeConfigState) => {
				globalRuntimeConfig = toGlobalRuntimeConfigState(config);
				activeRuntimeConfig = activeProjectId ? config : globalRuntimeConfig;
			},
			loadScopedRuntimeConfig,
			getTerminalManagerForProject,
			ensureTerminalManagerForProject,
			setActiveProject,
			clearActiveProject,
			disposeProject,
			buildProjectSummary,
			buildProjectStateSnapshot,
			buildProjectStatePublication,
			prepareProjectStatePublication,
			buildProjectsPayload,
			resolveProjectForStream,
			initializeIndexedProjectsForStartup,
			resumeInterruptedSessions,
			releaseDeferredStartupRecoveries,
			resolveTaskSessionSummary,
			checkProjectAvailability,
			suspendProjectObservation,
			resumeProjectObservation,
			checkProjectAvailabilityFreshness,
			rebindProjectLocation,
			setProjectOperationRunner: (runner) => {
				runProjectOperation = runner;
				for (const [projectId, manager] of terminalManagersByProjectId) {
					const projectPath = projectPathsById.get(projectId);
					if (projectPath) configureManagerLaunchAdmission(projectId, projectPath, manager);
				}
			},
			setProjectRemovalPreparationHandler: (handler) => {
				projectRemovalPreparationHandler = handler;
			},
			prepareProjectRemoval,
			stopMaintenance: () => {
				disposeDiagnosticProvider?.();
				disposeProjectStateDiagnosticProvider?.();
				startupRecoveryCoordinator.close();
				projectOrphanMaintenance.stop();
				availabilityObserver.close();
			},
			waitForMaintenance: async () => {
				await projectOrphanMaintenance.waitForIdle();
				await availabilityObserver.waitForIdle();
			},
			listManagedProjects: () => {
				return Array.from(terminalManagersByProjectId.entries()).map(([projectId, terminalManager]) => ({
					projectId,
					projectPath: projectPathsById.get(projectId) ?? null,
					terminalManager,
				}));
			},
		};
	} catch (error) {
		projectOrphanMaintenance.stop();
		startupRecoveryCoordinator.close();
		availabilityObserver.close();
		const failures: unknown[] = [];
		for (const dispose of [disposeDiagnosticProvider, disposeProjectStateDiagnosticProvider]) {
			try {
				dispose?.();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
		}
		for (const manager of terminalManagersByProjectId.values()) {
			try {
				manager.stopReconciliation();
				manager.markInterruptedAndStopAll();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
		}
		const drained = await Promise.allSettled([
			projectOrphanMaintenance.waitForIdle(),
			availabilityObserver.waitForIdle(),
			...Array.from(terminalManagersByProjectId.values(), (manager) => manager.waitForShutdownQuiescence()),
		]);
		failures.push(...drained.filter((result) => result.status === "rejected").map((result) => result.reason));
		if (failures.length > 0)
			throw new RuntimeStartupCleanupError(
				{ status: "incomplete", safeToExit: false, safeToReleaseOwnership: false, reasons: ["quiescence_failed"] },
				new AggregateError([error, ...failures], "Project registry startup cleanup failed."),
			);
		throw error;
	}
}
