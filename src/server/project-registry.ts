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
	KeyedOperationCoordinator,
	normalizeDiagnosticErrorClass,
	normalizeRuntimeTaskSessionSummary,
	pruneOrphanSessionsForBroadcast,
} from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import { observeProjectAvailability } from "../projects/project-availability";
import {
	isUnderWorktreesHome,
	listProjectIndexEntries,
	loadProjectBoardSnapshotById,
	loadProjectContext,
	loadProjectScopeById,
	loadProjectState,
	loadSavedProjectStateById,
	type RuntimeProjectIndexEntry,
	type RuntimeProjectScopeContext,
	updateProjectIndexMetadata,
} from "../state";
import { ProjectExecutionOwnershipStore } from "../state/project-execution-ownership-store";
import { readProjectNavigationIndex } from "../state/project-state-index.js";
import { detectGitRepositoryInfo } from "../state/project-state-utils";
import {
	deriveStartupRecoveryPolicy,
	InMemorySessionSummaryStore,
	LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
	TerminalSessionManager,
} from "../terminal";
import { createProjectOrphanMaintenanceTimer, type ProjectOrphanMaintenanceTimer } from "./project-orphan-maintenance";
import { ProjectStateDiagnosticTracker } from "./project-state-diagnostics";
import { RuntimeStartupCleanupError } from "./runtime-startup-cleanup";
import { type StartupSessionRecoveryCandidate, StartupSessionRecoveryCoordinator } from "./startup-session-recovery";
import { launchPreparedTaskSession, prepareTaskSessionStart } from "./task-session-start-service";

const registryLog = createTaggedLogger("project-registry");
const STARTUP_RESUME_SKIP_SAMPLE_LIMIT = 5;
export const PROJECT_STREAM_VALIDATION_CONCURRENCY = 4;

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
	hasGitRepository: (path: string) => Promise<boolean>;
	pathIsDirectory: (path: string) => Promise<boolean>;
	waitForStartupAgentCleanup?: () => Promise<void>;
	onTerminalManagerReady?: (projectId: string, manager: TerminalSessionManager) => void;
	diagnostics?: RuntimeDiagnostics;
}

export interface DisposeProjectRegistryOptions {
	stopTerminalSessions?: boolean;
}

export interface ResolvedProjectStreamTarget {
	projectId: string | null;
	projectPath: string | null;
}

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
	checkProjectAvailability: (projectId: string) => Promise<RuntimeProjectAvailability>;
	/** Enrichs a committed projection without acquiring admission or hydrating a session manager. */
	buildProjectStatePublication: (
		projectId: string,
		state: RuntimeProjectStateResponse,
	) => Promise<RuntimeProjectStateResponse | null>;
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
	availability: RuntimeProjectAvailability;
}

export async function validateIndexedProjectsForStream(
	projects: RuntimeProjectIndexEntry[],
	deps: Pick<CreateProjectRegistryDependencies, "hasGitRepository" | "pathIsDirectory">,
): Promise<ProjectStreamValidationResult[]> {
	const limit = pLimit(PROJECT_STREAM_VALIDATION_CONCURRENCY);
	return await Promise.all(
		projects.map((project) =>
			limit(async () => ({
				project,
				availability: await observeProjectAvailability(project, deps),
			})),
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
	const launchedFromGitRepo = await deps.hasGitRepository(deps.cwd);
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
	const availabilityOperations = new KeyedOperationCoordinator();
	const observedAvailability = new Map<string, RuntimeProjectAvailability>();
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

	const observeProjectLocation = async (
		projectId: string,
	): Promise<{ scope: RuntimeProjectScopeContext | null; availability: RuntimeProjectAvailability }> => {
		return await availabilityOperations.run(projectId, async () => {
			let scope = await loadProjectScopeById(projectId);
			if (!scope) return { scope: null, availability: { status: "unavailable", reason: "invalid_location" } };
			rememberProject(projectId, scope.repoPath);
			if (activeProjectId === projectId) activeProjectPath = scope.repoPath;
			const availability = await observeProjectAvailability(scope, deps);
			const previous = observedAvailability.get(projectId);
			if (
				(previous && JSON.stringify(previous) !== JSON.stringify(availability)) ||
				(!previous && availability.status === "unavailable")
			) {
				scope = {
					...scope,
					...(await updateProjectIndexMetadata({ projectId, expectedPath: scope.repoPath, touch: true })),
				};
			}
			observedAvailability.set(projectId, availability);
			return { scope, availability };
		});
	};

	const checkProjectAvailability = async (projectId: string): Promise<RuntimeProjectAvailability> =>
		(await observeProjectLocation(projectId)).availability;

	const assertProjectLaunchAvailable = async (
		projectId: string,
		projectPath: string,
		manager: TerminalSessionManager,
	): Promise<void> => {
		const availability = await checkProjectAvailability(projectId);
		if (
			availability.status !== "available" ||
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
			if ((await checkProjectAvailability(projectId)).status === "available") {
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
		observedAvailability.delete(projectId);
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
		const snapshot = await loadProjectBoardSnapshotById(projectId);
		const availability = await checkProjectAvailability(projectId);
		const scope = await loadProjectScopeById(projectId);
		return deriveProjectSummary({
			projectId,
			repoPath: scope?.repoPath ?? repoPath,
			board: snapshot.board,
			boardRevision: snapshot.revision,
			folderOnly: scope?.folderOnly,
			displayName: scope?.displayName,
			metadataRevision: scope?.metadataRevision,
			availability,
		});
	};

	const buildProjectStateSnapshot = async (projectId: string): Promise<RuntimeProjectStateResponse> =>
		await runProjectOperation(projectId, async () => {
			// A snapshot may hydrate and publish a manager. Hold admission through
			// that publication so relocation cannot dispose its owner mid-read.
			const availability = await checkProjectAvailability(projectId);
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

	const buildProjectStatePublication = async (
		projectId: string,
		state: RuntimeProjectStateResponse,
	): Promise<RuntimeProjectStateResponse | null> => {
		// Runtime persistence owners await publication while draining inside relocation's
		// exclusion. Read metadata only: admission or manager hydration here can deadlock
		// that drain or resurrect a manager whose subscriptions were already disposed.
		const { scope, availability } = await observeProjectLocation(projectId);
		if (!scope || scope.repoPath !== state.repoPath) return null;
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
		if (
			!currentScope ||
			currentScope.repoPath !== scope.repoPath ||
			currentScope.metadataRevision !== scope.metadataRevision
		) {
			return null;
		}
		return {
			...state,
			git,
			availability,
			metadataRevision: scope.metadataRevision,
			sessions: projectSessionsForAvailability(state.sessions, availability),
		};
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const { entries: projects, organization } = await readProjectNavigationIndex();
		const fallbackProjectId =
			projects.find((project) => project.projectId === activeProjectId)?.projectId ?? projects[0]?.projectId ?? null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.projectId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const limit = pLimit(PROJECT_STREAM_VALIDATION_CONCURRENCY);
		const projectSummaries = await Promise.all(
			projects.map((project) => limit(() => buildProjectSummary(project.projectId, project.repoPath))),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
			organization,
		};
	};

	const inspectIndexedProjects = async (): Promise<{
		indexedProjects: RuntimeProjectIndexEntry[];
		existingProjects: RuntimeProjectIndexEntry[];
		unavailableProjects: RuntimeProjectIndexEntry[];
	}> => {
		const allProjects = await listProjectIndexEntries();
		const validationResults = await validateIndexedProjectsForStream(allProjects, deps);
		const existingProjects: RuntimeProjectIndexEntry[] = [];
		const unavailableProjects: RuntimeProjectIndexEntry[] = [];

		for (const { project, availability } of validationResults) {
			if (availability.status === "available") {
				existingProjects.push(project);
				continue;
			}

			unavailableProjects.push(project);
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
				await checkProjectAvailability(selected.projectId);
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
			if ((await checkProjectAvailability(projectId)).status !== "available") return null;
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
			buildProjectsPayload,
			resolveProjectForStream,
			initializeIndexedProjectsForStartup,
			resumeInterruptedSessions,
			releaseDeferredStartupRecoveries,
			resolveTaskSessionSummary,
			checkProjectAvailability,
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
			},
			waitForMaintenance: async () => {
				await projectOrphanMaintenance.waitForIdle();
				await availabilityOperations.waitForIdle();
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
			availabilityOperations.waitForIdle(),
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
