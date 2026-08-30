import pLimit from "p-limit";

import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config";
import type {
	IProjectDataProvider,
	IProjectResolver,
	IRuntimeConfigProvider,
	ITerminalManagerProvider,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeTaskSessionSummary,
} from "../core";
import {
	createTaggedLogger,
	deriveProjectSummary,
	normalizeDiagnosticErrorClass,
	pruneOrphanSessionsForBroadcast,
} from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import {
	isUnderWorktreesHome,
	listProjectIndexEntries,
	loadProjectBoardSnapshotById,
	loadProjectContext,
	loadProjectState,
	type RuntimeProjectIndexEntry,
	removeProjectIndexEntry,
	removeProjectStateFiles,
} from "../state";
import {
	deriveStartupRecoveryPolicy,
	InMemorySessionSummaryStore,
	LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
	TerminalSessionManager,
} from "../terminal";
import { createProjectOrphanMaintenanceTimer, type ProjectOrphanMaintenanceTimer } from "./project-orphan-maintenance";
import { ProjectStateDiagnosticTracker } from "./project-state-diagnostics";
import { type StartupSessionRecoveryCandidate, StartupSessionRecoveryCoordinator } from "./startup-session-recovery";
import { launchPreparedTaskSession, prepareTaskSessionStart } from "./task-session-start-service";

const registryLog = createTaggedLogger("project-registry");
const STARTUP_RESUME_SKIP_SAMPLE_LIMIT = 5;
export const PROJECT_STREAM_VALIDATION_CONCURRENCY = 4;

// Startup resume selection is still small enough to live near the registry
// entry point. If it gains more agent-specific rules or scan outcomes, extract
// this block into a dedicated startup-resume policy module with focused tests.
type StartupResumeSkipReason = "missing_summary" | "not_interrupted" | "pending_provider_hook";

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
	skippedPendingProviderHookCount: number;
	skippedSamples: StartupResumeSkipSample[];
}

function createStartupResumeScanStats(): StartupResumeScanStats {
	return {
		consideredTaskCount: 0,
		resumableTaskCount: 0,
		skippedMissingSummaryCount: 0,
		skippedNotInterruptedCount: 0,
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

export interface ProjectRegistryScope {
	projectId: string;
	projectPath: string;
}

export interface CreateProjectRegistryDependencies {
	cwd: string;
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
	removedRequestedProjectPath: string | null;
	didPruneProjects: boolean;
}

export interface RemovedProjectNotice {
	projectId: string;
	repoPath: string;
	message: string;
}

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
	resolveProjectForStream: (
		requestedProjectId: string | null,
		options?: {
			onRemovedProject?: (notice: RemovedProjectNotice) => void | Promise<void>;
		},
	) => Promise<ResolvedProjectStreamTarget>;
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
	stopMaintenance: () => void;
	listManagedProjects: () => Array<{
		projectId: string;
		projectPath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

export interface ProjectStreamValidationResult {
	project: RuntimeProjectIndexEntry;
	removalMessage: string | null;
}

async function resolveIndexedProjectRemovalMessage(
	project: RuntimeProjectIndexEntry,
	deps: Pick<CreateProjectRegistryDependencies, "hasGitRepository" | "pathIsDirectory">,
): Promise<string | null> {
	if (isUnderWorktreesHome(project.repoPath)) {
		return `Worktree was incorrectly indexed as a project and was removed: ${project.repoPath}`;
	}
	if (!(await deps.pathIsDirectory(project.repoPath))) {
		return `Project no longer exists on disk and was removed: ${project.repoPath}`;
	}
	if (!(await deps.hasGitRepository(project.repoPath))) {
		return `Project is not a git repository and was removed: ${project.repoPath}`;
	}
	return null;
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
				removalMessage: await resolveIndexedProjectRemovalMessage(project, deps),
			})),
		),
	);
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			// De-isolated tasks may still have an orphaned worktree on disk.
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

export async function createProjectRegistry(deps: CreateProjectRegistryDependencies): Promise<ProjectRegistry> {
	const launchedFromGitRepo = await deps.hasGitRepository(deps.cwd);
	const launchedFromWorktree = isUnderWorktreesHome(deps.cwd);
	const initialProject = launchedFromGitRepo && !launchedFromWorktree ? await loadProjectContext(deps.cwd) : null;
	let indexedProject: RuntimeProjectIndexEntry | null = null;
	if (!initialProject) {
		const indexedProjects = await listProjectIndexEntries();
		indexedProject = indexedProjects[0] ?? null;
	}

	let activeProjectId: string | null = initialProject?.projectId ?? indexedProject?.projectId ?? null;
	let activeProjectPath: string | null = initialProject?.repoPath ?? indexedProject?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeProjectPath ? await deps.loadRuntimeConfig(activeProjectId) : globalRuntimeConfig;
	const projectPathsById = new Map<string, string>(
		activeProjectId && activeProjectPath ? [[activeProjectId, activeProjectPath]] : [],
	);
	const projectStateDiagnostics = new ProjectStateDiagnosticTracker();
	const terminalManagersByProjectId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();
	const deferredStartupRecoveries = new Map<string, { projectId: string; projectPath: string; taskId: string }>();
	const deferredStartupRecoveryProjects = new Map<string, string>();
	const projectOrphanMaintenance: ProjectOrphanMaintenanceTimer = createProjectOrphanMaintenanceTimer({
		getProjectRepoPaths: () => projectPathsById.values(),
	});
	if (projectPathsById.size > 0) {
		projectOrphanMaintenance.start();
	}

	const rememberProject = (projectId: string, repoPath: string): void => {
		const wasKnown = projectPathsById.has(projectId);
		projectPathsById.set(projectId, repoPath);
		projectOrphanMaintenance.start();
		if (!wasKnown) deps.diagnostics?.recordEvent("project.registered", {}, { projectId }, { essential: true });
	};

	const stopOrphanMaintenanceIfIdle = (): void => {
		if (projectPathsById.size === 0) {
			projectOrphanMaintenance.stop();
		}
	};

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
			const existingProject = await loadProjectState(repoPath);
			manager.hydrateFromRecord(existingProject.sessions);
			const hydratedSessionCount = Object.keys(existingProject.sessions).length;
			manager.startReconciliation();
			terminalManagersByProjectId.set(projectId, manager);
			registryLog.warn("terminal manager created", {
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

	const loadScopedRuntimeConfig = async (scope: ProjectRegistryScope): Promise<RuntimeConfigState> => {
		if (scope.projectId === activeProjectId) {
			return activeRuntimeConfig;
		}
		return await deps.loadRuntimeConfig(scope.projectId);
	};

	const startupRecoveryCoordinator = new StartupSessionRecoveryCoordinator({
		waitForPrerequisite: deps.waitForStartupAgentCleanup,
		prepare: async (candidate, options) =>
			await prepareTaskSessionStart(
				candidate.scope,
				candidate.request,
				{
					config: { loadScopedRuntimeConfig },
					getScopedTerminalManager: async () => candidate.manager,
				},
				options,
			),
		launch: launchPreparedTaskSession,
	});

	const setActiveProject = async (projectId: string, repoPath: string): Promise<void> => {
		activeProjectId = projectId;
		activeProjectPath = repoPath;
		rememberProject(projectId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(projectId);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
		await prepareTerminalManagerForProject(projectId, repoPath, "selection");
	};

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

	const buildProjectSummary = async (projectId: string, repoPath: string): Promise<RuntimeProjectSummary> => {
		const snapshot = await loadProjectBoardSnapshotById(projectId);
		return deriveProjectSummary({
			projectId,
			repoPath,
			board: snapshot.board,
			boardRevision: snapshot.revision,
		});
	};

	const buildProjectStateSnapshot = async (
		projectId: string,
		projectPath: string,
	): Promise<RuntimeProjectStateResponse> => {
		const response = await loadProjectState(projectPath);
		const terminalManager = await ensureTerminalManagerForProject(projectId, projectPath);
		for (const summary of terminalManager.store.listSummaries()) {
			response.sessions[summary.taskId] = summary;
		}
		response.sessions = pruneOrphanSessionsForBroadcast(response.sessions, response.board);
		projectStateDiagnostics.observe(projectId, response);
		return response;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listProjectIndexEntries();
		const fallbackProjectId =
			projects.find((project) => project.projectId === activeProjectId)?.projectId ?? projects[0]?.projectId ?? null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.projectId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const projectSummaries = await Promise.all(
			projects.map(async (project) => await buildProjectSummary(project.projectId, project.repoPath)),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const inspectIndexedProjects = async (): Promise<{
		existingProjects: RuntimeProjectIndexEntry[];
		unavailableProjects: RuntimeProjectIndexEntry[];
	}> => {
		const allProjects = await listProjectIndexEntries();
		const validationResults = await validateIndexedProjectsForStream(allProjects, deps);
		const existingProjects: RuntimeProjectIndexEntry[] = [];
		const unavailableProjects: RuntimeProjectIndexEntry[] = [];

		for (const { project, removalMessage } of validationResults) {
			if (!removalMessage) {
				existingProjects.push(project);
				continue;
			}

			unavailableProjects.push(project);
		}
		return { existingProjects, unavailableProjects };
	};

	const selectAvailableActiveProject = async (existingProjects: RuntimeProjectIndexEntry[]): Promise<void> => {
		const activeProjectMissing = !existingProjects.some((project) => project.projectId === activeProjectId);
		if (activeProjectMissing) {
			if (existingProjects[0]) {
				await setActiveProject(existingProjects[0].projectId, existingProjects[0].repoPath);
			} else {
				clearActiveProject();
			}
		}
	};

	const reconcileIndexedProjects = async (options?: {
		onRemovedProject?: (notice: RemovedProjectNotice) => void | Promise<void>;
	}): Promise<{
		existingProjects: RuntimeProjectIndexEntry[];
		removedProjects: RuntimeProjectIndexEntry[];
	}> => {
		const { existingProjects, unavailableProjects } = await inspectIndexedProjects();
		const removedProjects: RuntimeProjectIndexEntry[] = [];

		for (const project of unavailableProjects) {
			const removalMessage = await resolveIndexedProjectRemovalMessage(project, deps);
			if (!removalMessage) {
				// The path recovered between validation and mutation. Keep the index
				// entry and let the next stream resolution include it normally.
				existingProjects.push(project);
				continue;
			}
			removedProjects.push(project);
			const terminalManager = getTerminalManagerForProject(project.projectId);
			if (terminalManager) {
				terminalManager.markInterruptedAndStopAll();
				await terminalManager.waitForShutdownQuiescence();
			}
			await removeProjectIndexEntry(project.projectId);
			// Detach and drain external runtime projections before deleting state;
			// an already-running persistence write must not recreate the project.
			await options?.onRemovedProject?.({
				projectId: project.projectId,
				repoPath: project.repoPath,
				message: removalMessage,
			});
			await removeProjectStateFiles(project.projectId);
			disposeProject(project.projectId, { stopTerminalSessions: false });
		}

		await selectAvailableActiveProject(existingProjects);

		return { existingProjects, removedProjects };
	};

	const resolveProjectForStream = async (
		requestedProjectId: string | null,
		options?: {
			onRemovedProject?: (notice: RemovedProjectNotice) => void | Promise<void>;
		},
	): Promise<ResolvedProjectStreamTarget> => {
		const { existingProjects, removedProjects } = await reconcileIndexedProjects(options);

		const removedRequestedProjectPath = requestedProjectId
			? (removedProjects.find((project) => project.projectId === requestedProjectId)?.repoPath ?? null)
			: null;

		if (requestedProjectId) {
			const requestedProject = existingProjects.find((project) => project.projectId === requestedProjectId);
			if (requestedProject) {
				if (activeProjectId !== requestedProject.projectId || activeProjectPath !== requestedProject.repoPath) {
					await setActiveProject(requestedProject.projectId, requestedProject.repoPath);
				}
				return {
					projectId: requestedProject.projectId,
					projectPath: requestedProject.repoPath,
					removedRequestedProjectPath,
					didPruneProjects: removedProjects.length > 0,
				};
			}
		}

		const fallbackProject =
			existingProjects.find((project) => project.projectId === activeProjectId) ?? existingProjects[0] ?? null;
		if (!fallbackProject) {
			return {
				projectId: null,
				projectPath: null,
				removedRequestedProjectPath,
				didPruneProjects: removedProjects.length > 0,
			};
		}
		return {
			projectId: fallbackProject.projectId,
			projectPath: fallbackProject.repoPath,
			removedRequestedProjectPath,
			didPruneProjects: removedProjects.length > 0,
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
		const manager = await ensureTerminalManagerForProject(projectId, projectPath);
		let state: RuntimeProjectStateResponse;
		try {
			state = await loadProjectState(projectPath);
		} catch (error) {
			deferredStartupRecoveryProjects.set(projectId, projectPath);
			registryLog.warn("startup resume deferred: failed to load project state", {
				projectId,
				hasProjectPath: projectPath.length > 0,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			throw error;
		}
		deferredStartupRecoveryProjects.delete(projectId);
		const resumable: StartupSessionRecoveryCandidate[] = [];
		// Startup resume runs before a user can inspect task terminals, so keep
		// enough scan detail to tell whether we never selected a task or failed
		// after selection.
		const scanStats = createStartupResumeScanStats();
		for (const column of state.board.columns) {
			if (column.id !== "in_progress" && column.id !== "review") {
				continue;
			}
			for (const card of column.cards) {
				scanStats.consideredTaskCount += 1;
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
		await Promise.all(
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
					{ level: failed ? "error" : unconfirmed ? "warn" : "info", essential: true },
				);
			}),
		);
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
			const { existingProjects, unavailableProjects } = await inspectIndexedProjects();
			for (const project of unavailableProjects) {
				registryLog.warn("startup skipped unavailable indexed project without pruning saved state", {
					projectId: project.projectId,
					hasProjectPath: project.repoPath.length > 0,
				});
			}
			await selectAvailableActiveProject(existingProjects);
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

	if (initialProject) {
		await prepareTerminalManagerForProject(initialProject.projectId, initialProject.repoPath, "startup");
	}

	const disposeDiagnosticProvider = deps.diagnostics?.registerSnapshotProvider({
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
	const disposeProjectStateDiagnosticProvider = deps.diagnostics?.registerSnapshotProvider({
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
		buildProjectsPayload,
		resolveProjectForStream,
		initializeIndexedProjectsForStartup,
		resumeInterruptedSessions,
		releaseDeferredStartupRecoveries,
		stopMaintenance: () => {
			disposeDiagnosticProvider?.();
			disposeProjectStateDiagnosticProvider?.();
			startupRecoveryCoordinator.close();
			projectOrphanMaintenance.stop();
		},
		listManagedProjects: () => {
			return Array.from(terminalManagersByProjectId.entries()).map(([projectId, terminalManager]) => ({
				projectId,
				projectPath: projectPathsById.get(projectId) ?? null,
				terminalManager,
			}));
		},
	};
}
