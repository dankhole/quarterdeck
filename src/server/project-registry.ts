import { type RuntimeConfigState, resolveAgentCommand, toGlobalRuntimeConfigState } from "../config";
import type {
	IProjectDataProvider,
	IProjectResolver,
	IRuntimeConfigProvider,
	ITerminalManagerProvider,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
} from "../core";
import { createTaggedLogger, emitEvent, emitSessionEvent } from "../core";
import {
	isUnderWorktreesHome,
	listProjectIndexEntries,
	loadProjectBoardById,
	loadProjectContext,
	loadProjectState,
	type RuntimeProjectIndexEntry,
	removeProjectIndexEntry,
	removeProjectStateFiles,
} from "../state";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../terminal";

const registryLog = createTaggedLogger("project-registry");

export interface ProjectRegistryScope {
	projectId: string;
	projectPath: string;
}

export interface CreateProjectRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (projectId?: string | null) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	pathIsDirectory: (path: string) => Promise<boolean>;
	onTerminalManagerReady?: (projectId: string, manager: TerminalSessionManager) => void;
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
			onRemovedProject?: (notice: RemovedProjectNotice) => void;
		},
	) => Promise<ResolvedProjectStreamTarget>;
	resumeInterruptedSessions: (projectId: string, projectPath: string) => Promise<number>;
	listManagedProjects: () => Array<{
		projectId: string;
		projectPath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

function createEmptyProjectTaskCounts(): RuntimeProjectTaskCounts {
	return {
		backlog: 0,
		in_progress: 0,
		review: 0,
		trash: 0,
	};
}

function countTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts = createEmptyProjectTaskCounts();
	for (const column of board.columns) {
		const count = column.cards.length;
		switch (column.id) {
			case "backlog":
				counts.backlog += count;
				break;
			case "in_progress":
				counts.in_progress += count;
				break;
			case "review":
				counts.review += count;
				break;
			case "trash":
				counts.trash += count;
				break;
		}
	}
	return counts;
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

function applyLiveSessionStateToProjectTaskCounts(
	counts: RuntimeProjectTaskCounts,
	board: RuntimeBoardData,
	sessionSummaries: RuntimeProjectStateResponse["sessions"],
): RuntimeProjectTaskCounts {
	const taskColumnById = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskColumnById.set(card.id, column.id);
		}
	}
	const next = {
		...counts,
	};
	for (const summary of Object.values(sessionSummaries)) {
		const columnId = taskColumnById.get(summary.taskId);
		if (!columnId) {
			continue;
		}
		if (summary.state === "awaiting_review" && columnId === "in_progress") {
			next.in_progress = Math.max(0, next.in_progress - 1);
			next.review += 1;
		}
		// Don't adjust counts for interrupted sessions — they stay in their
		// work columns for auto-resume, not trash.
	}
	return next;
}

function toProjectSummary(project: {
	projectId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
}): RuntimeProjectSummary {
	const normalized = project.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const name = segments[segments.length - 1] ?? normalized;
	return {
		id: project.projectId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
	};
}

export async function createProjectRegistry(deps: CreateProjectRegistryDependencies): Promise<ProjectRegistry> {
	const launchedFromGitRepo = deps.hasGitRepository(deps.cwd);
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
	const projectTaskCountsByProjectId = new Map<string, RuntimeProjectTaskCounts>();
	const terminalManagersByProjectId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();

	const rememberProject = (projectId: string, repoPath: string): void => {
		projectPathsById.set(projectId, repoPath);
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
			const manager = new TerminalSessionManager(store);
			let hydratedSessionCount = 0;
			try {
				const existingProject = await loadProjectState(repoPath);
				manager.hydrateFromRecord(existingProject.sessions);
				hydratedSessionCount = Object.keys(existingProject.sessions).length;
			} catch {
				// Project state will be created on demand.
			}
			manager.startReconciliation(repoPath);
			terminalManagersByProjectId.set(projectId, manager);
			registryLog.warn("terminal manager created", { projectId, repoPath, hydratedSessionCount });
			emitEvent("project.terminal_manager_created", { projectId, repoPath, hydratedSessionCount });
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(projectId);
		});
		terminalManagerLoadPromises.set(projectId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(projectId, loaded);
		return loaded;
	};

	const setActiveProject = async (projectId: string, repoPath: string): Promise<void> => {
		activeProjectId = projectId;
		activeProjectPath = repoPath;
		rememberProject(projectId, repoPath);
		await ensureTerminalManagerForProject(projectId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(projectId);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
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
		projectTaskCountsByProjectId.delete(projectId);
		const projectPath = projectPathsById.get(projectId) ?? null;
		projectPathsById.delete(projectId);
		return {
			terminalManager,
			projectPath,
		};
	};

	const summarizeProjectTaskCounts = async (
		projectId: string,
		_repoPath: string,
	): Promise<RuntimeProjectTaskCounts> => {
		try {
			const terminalManager = getTerminalManagerForProject(projectId);
			// For projects without active sessions, board state is stable —
			// serve cached counts to avoid repeated disk reads on every broadcast.
			if (!terminalManager) {
				const cached = projectTaskCountsByProjectId.get(projectId);
				if (cached) {
					return cached;
				}
			}
			const board = await loadProjectBoardById(projectId);
			const persistedCounts = countTasksByColumn(board);
			if (!terminalManager) {
				projectTaskCountsByProjectId.set(projectId, persistedCounts);
				return persistedCounts;
			}
			const liveSessionsByTaskId: RuntimeProjectStateResponse["sessions"] = {};
			for (const summary of terminalManager.store.listSummaries()) {
				liveSessionsByTaskId[summary.taskId] = summary;
			}
			const nextCounts = applyLiveSessionStateToProjectTaskCounts(persistedCounts, board, liveSessionsByTaskId);
			projectTaskCountsByProjectId.set(projectId, nextCounts);
			return nextCounts;
		} catch {
			return projectTaskCountsByProjectId.get(projectId) ?? createEmptyProjectTaskCounts();
		}
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
			projects.map(async (project) => {
				const taskCounts = await summarizeProjectTaskCounts(project.projectId, project.repoPath);
				return toProjectSummary({
					projectId: project.projectId,
					repoPath: project.repoPath,
					taskCounts,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const resolveProjectForStream = async (
		requestedProjectId: string | null,
		options?: {
			onRemovedProject?: (notice: RemovedProjectNotice) => void;
		},
	): Promise<ResolvedProjectStreamTarget> => {
		const allProjects = await listProjectIndexEntries();
		const existingProjects: RuntimeProjectIndexEntry[] = [];
		const removedProjects: RuntimeProjectIndexEntry[] = [];

		for (const project of allProjects) {
			let removalMessage: string | null = null;
			if (isUnderWorktreesHome(project.repoPath)) {
				removalMessage = `Worktree was incorrectly indexed as a project and was removed: ${project.repoPath}`;
			} else if (!(await deps.pathIsDirectory(project.repoPath))) {
				removalMessage = `Project no longer exists on disk and was removed: ${project.repoPath}`;
			} else if (!deps.hasGitRepository(project.repoPath)) {
				removalMessage = `Project is not a git repository and was removed: ${project.repoPath}`;
			}

			if (!removalMessage) {
				existingProjects.push(project);
				continue;
			}

			removedProjects.push(project);
			await removeProjectIndexEntry(project.projectId);
			await removeProjectStateFiles(project.projectId);
			disposeProject(project.projectId);
			options?.onRemovedProject?.({
				projectId: project.projectId,
				repoPath: project.repoPath,
				message: removalMessage,
			});
		}

		const removedRequestedProjectPath = requestedProjectId
			? (removedProjects.find((project) => project.projectId === requestedProjectId)?.repoPath ?? null)
			: null;

		const activeProjectMissing = !existingProjects.some((project) => project.projectId === activeProjectId);
		if (activeProjectMissing) {
			if (existingProjects[0]) {
				await setActiveProject(existingProjects[0].projectId, existingProjects[0].repoPath);
			} else {
				clearActiveProject();
			}
		}

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
	 * Resume interrupted sessions after a server restart. Called once per
	 * project when the first UI client connects. Finds sessions persisted
	 * as "interrupted" in work columns, resolves the agent command, and
	 * restarts each with --continue (awaitReview=true so they land in review).
	 */
	const resumeInterruptedSessions = async (projectId: string, projectPath: string): Promise<number> => {
		const manager = getTerminalManagerForProject(projectId);
		if (!manager) {
			return 0;
		}
		let state: RuntimeProjectStateResponse;
		try {
			state = await loadProjectState(projectPath);
		} catch {
			return 0;
		}
		const runtimeConfig = await deps.loadRuntimeConfig(projectId);
		const resolved = resolveAgentCommand(runtimeConfig);
		if (!resolved) {
			return 0;
		}
		const resumable: Array<{ taskId: string; cwd: string }> = [];
		for (const column of state.board.columns) {
			if (column.id !== "in_progress" && column.id !== "review") {
				continue;
			}
			for (const card of column.cards) {
				const summary = manager.store.getSummary(card.id);
				if (summary?.state === "interrupted" && summary.reviewReason === "interrupted" && card.workingDirectory) {
					resumable.push({ taskId: card.id, cwd: card.workingDirectory });
				}
			}
		}
		if (resumable.length === 0) {
			return 0;
		}
		for (const { taskId, cwd } of resumable) {
			emitSessionEvent(taskId, "startup.resume", {});
			void manager
				.startTaskSession({
					taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
					cwd,
					prompt: "",
					resumeConversation: true,
					awaitReview: true,
					projectId,
					projectPath,
					statuslineEnabled: runtimeConfig.statuslineEnabled,
					worktreeAddParentGitDir: runtimeConfig.worktreeAddParentGitDir,
					worktreeAddQuarterdeckDir: runtimeConfig.worktreeAddQuarterdeckDir,
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					emitSessionEvent(taskId, "startup.resume_failed", { error: message });
					// Transition immediately so the card moves to review without
					// waiting for the reconciliation sweep to catch it.
					manager.store.update(taskId, {
						state: "awaiting_review",
						reviewReason: "interrupted",
						warningMessage: `Resume failed: ${message}`,
					});
				});
		}
		return resumable.length;
	};

	if (initialProject) {
		await ensureTerminalManagerForProject(initialProject.projectId, initialProject.repoPath);
	}

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
		loadScopedRuntimeConfig: async (scope: ProjectRegistryScope) => {
			if (scope.projectId === activeProjectId) {
				return activeRuntimeConfig;
			}
			return await deps.loadRuntimeConfig(scope.projectId);
		},
		getTerminalManagerForProject,
		ensureTerminalManagerForProject,
		setActiveProject,
		clearActiveProject,
		disposeProject,
		summarizeProjectTaskCounts,
		createProjectSummary: toProjectSummary,
		buildProjectStateSnapshot,
		buildProjectsPayload,
		resolveProjectForStream,
		resumeInterruptedSessions,
		listManagedProjects: () => {
			return Array.from(terminalManagersByProjectId.entries()).map(([projectId, terminalManager]) => ({
				projectId,
				projectPath: projectPathsById.get(projectId) ?? null,
				terminalManager,
			}));
		},
	};
}
