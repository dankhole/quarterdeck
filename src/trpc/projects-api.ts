import type {
	IProjectDataProvider,
	IProjectResolver,
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	RuntimeBoardData,
	RuntimeProjectAddResponse,
} from "../core";
import { parseProjectAddRequest, parseProjectRemoveRequest, parseProjectReorderRequest } from "../core";
import {
	isUnderWorktreesHome,
	listProjectIndexEntries,
	loadProjectContext,
	loadProjectContextById,
	loadProjectState,
	removeProjectIndexEntry,
	removeProjectStateFiles,
	updateProjectOrder,
} from "../state";
import type { TerminalSessionManager } from "../terminal";
import { deleteTaskWorktree, ensureInitialCommit, initializeGitRepository } from "../workdir";
import type { RuntimeTrpcContext } from "./app-router";

interface DisposeProjectOptions {
	stopTerminalSessions?: boolean;
}

export interface CreateProjectsApiDependencies {
	projects: IProjectResolver;
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastRuntimeProjectsUpdated">;
	data: IProjectDataProvider;
	resolveProjectInputPath: (inputPath: string, cwd: string) => string;
	assertPathIsDirectory: (path: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeProject: (
		projectId: string,
		options?: DisposeProjectOptions,
	) => { terminalManager: TerminalSessionManager | null; projectPath: string | null };
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeBoardData) => Set<string>;
	warn: (message: string) => void;
	pickDirectoryPathFromSystemDialog: () => string | null;
}

export function createProjectsApi(deps: CreateProjectsApiDependencies): RuntimeTrpcContext["projectsApi"] {
	return {
		listProjects: async (preferredProjectId) => {
			const payload = await deps.data.buildProjectsPayload(preferredProjectId);
			return {
				currentProjectId: payload.currentProjectId,
				projects: payload.projects,
			};
		},
		addProject: async (preferredProjectId, input) => {
			const body = parseProjectAddRequest(input);
			const preferredProjectContext = preferredProjectId ? await loadProjectContextById(preferredProjectId) : null;
			const resolveBasePath =
				preferredProjectContext?.repoPath ?? deps.projects.getActiveProjectPath() ?? process.cwd();
			try {
				const projectPath = deps.resolveProjectInputPath(body.path, resolveBasePath);
				await deps.assertPathIsDirectory(projectPath);
				if (isUnderWorktreesHome(projectPath)) {
					return {
						ok: false,
						project: null,
						error: "This path is inside Quarterdeck's worktree directory and cannot be added as a project.",
					} satisfies RuntimeProjectAddResponse;
				}
				if (!deps.hasGitRepository(projectPath)) {
					if (!body.initializeGit) {
						return {
							ok: false,
							project: null,
							requiresGitInitialization: true,
							error: "This folder is not a git repository. Quarterdeck requires git to manage worktrees. Initialize git to continue.",
						} satisfies RuntimeProjectAddResponse;
					}
					const initResult = await initializeGitRepository(projectPath);
					if (!initResult.ok) {
						return {
							ok: false,
							project: null,
							error: initResult.error ?? "Failed to initialize git repository.",
						} satisfies RuntimeProjectAddResponse;
					}
				} else {
					const commitResult = await ensureInitialCommit(projectPath);
					if (!commitResult.ok) {
						return {
							ok: false,
							project: null,
							error: commitResult.error ?? "Failed to ensure initial commit.",
						} satisfies RuntimeProjectAddResponse;
					}
				}
				const context = await loadProjectContext(projectPath);
				deps.projects.rememberProject(context.projectId, context.repoPath);
				const projectsAfterAdd = await listProjectIndexEntries();
				const activeProjectId = deps.projects.getActiveProjectId();
				const hasActiveWorkspace = activeProjectId
					? projectsAfterAdd.some((project) => project.projectId === activeProjectId)
					: false;
				if (!hasActiveWorkspace) {
					await deps.projects.setActiveProject(context.projectId, context.repoPath);
				}
				const taskCounts = await deps.data.summarizeProjectTaskCounts(context.projectId, context.repoPath);
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(context.projectId);
				return {
					ok: true,
					project: deps.data.createProjectSummary({
						projectId: context.projectId,
						repoPath: context.repoPath,
						taskCounts,
					}),
				} satisfies RuntimeProjectAddResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					project: null,
					error: message,
				} satisfies RuntimeProjectAddResponse;
			}
		},
		removeProject: async (_preferredProjectId, input) => {
			try {
				const body = parseProjectRemoveRequest(input);
				const projectsBeforeRemoval = await listProjectIndexEntries();
				const projectToRemove = projectsBeforeRemoval.find((project) => project.projectId === body.projectId);
				if (!projectToRemove) {
					return {
						ok: false,
						error: `Unknown project ID: ${body.projectId}`,
					};
				}

				const taskIdsToCleanup = new Set<string>();
				try {
					const projectState = await loadProjectState(projectToRemove.repoPath);
					for (const taskId of deps.collectProjectWorktreeTaskIdsForRemoval(projectState.board)) {
						taskIdsToCleanup.add(taskId);
					}
				} catch {
					// Best effort: if board state cannot be read, skip worktree cleanup IDs.
				}

				const removedTerminalManager = deps.terminals.getTerminalManagerForProject(body.projectId);
				if (removedTerminalManager) {
					removedTerminalManager.markInterruptedAndStopAll();
				}

				const removed = await removeProjectIndexEntry(body.projectId);
				if (!removed) {
					throw new Error(`Could not remove project index entry for "${body.projectId}".`);
				}
				await removeProjectStateFiles(body.projectId);
				deps.disposeProject(body.projectId, {
					stopTerminalSessions: false,
				});

				if (deps.projects.getActiveProjectId() === body.projectId) {
					const remaining = await listProjectIndexEntries();
					const fallbackProject = remaining[0];
					if (fallbackProject) {
						await deps.projects.setActiveProject(fallbackProject.projectId, fallbackProject.repoPath);
					} else {
						deps.projects.clearActiveProject();
					}
				}
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(deps.projects.getActiveProjectId());
				if (taskIdsToCleanup.size > 0) {
					const cleanupTaskIds = Array.from(taskIdsToCleanup);
					void (async () => {
						const deletions = await Promise.all(
							cleanupTaskIds.map(async (taskId) => ({
								taskId,
								deleted: await deleteTaskWorktree({
									repoPath: projectToRemove.repoPath,
									taskId,
								}),
							})),
						);
						for (const { taskId, deleted } of deletions) {
							if (deleted.ok) {
								continue;
							}
							const message = deleted.error ?? `Could not delete task worktree for task "${taskId}".`;
							deps.warn(message);
						}
					})();
				}
				return {
					ok: true,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					error: message,
				};
			}
		},
		pickProjectDirectory: async () => {
			try {
				const selectedPath = deps.pickDirectoryPathFromSystemDialog();
				if (!selectedPath) {
					return {
						ok: false,
						path: null,
						error: "No directory was selected.",
					};
				}
				return {
					ok: true,
					path: selectedPath,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					path: null,
					error: message,
				};
			}
		},
		reorderProjects: async (_preferredProjectId, input) => {
			try {
				const body = parseProjectReorderRequest(input);
				await updateProjectOrder(body.projectOrder);
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(deps.projects.getActiveProjectId());
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
	};
}
