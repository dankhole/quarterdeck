import type {
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	IWorkspaceDataProvider,
	IWorkspaceResolver,
	RuntimeBoardData,
	RuntimeProjectAddResponse,
} from "../core";
import { parseProjectAddRequest, parseProjectRemoveRequest, parseProjectReorderRequest } from "../core";
import {
	isUnderWorktreesHome,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	loadWorkspaceState,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
	updateProjectOrder,
} from "../state";
import type { TerminalSessionManager } from "../terminal";
import { deleteTaskWorktree, ensureInitialCommit, initializeGitRepository } from "../workspace";
import type { RuntimeTrpcContext } from "./app-router";

interface DisposeWorkspaceOptions {
	stopTerminalSessions?: boolean;
}

export interface CreateProjectsApiDependencies {
	workspaces: IWorkspaceResolver;
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastRuntimeProjectsUpdated">;
	data: IWorkspaceDataProvider;
	resolveProjectInputPath: (inputPath: string, cwd: string) => string;
	assertPathIsDirectory: (path: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: DisposeWorkspaceOptions,
	) => { terminalManager: TerminalSessionManager | null; workspacePath: string | null };
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeBoardData) => Set<string>;
	warn: (message: string) => void;
	pickDirectoryPathFromSystemDialog: () => string | null;
}

export function createProjectsApi(deps: CreateProjectsApiDependencies): RuntimeTrpcContext["projectsApi"] {
	return {
		listProjects: async (preferredWorkspaceId) => {
			const payload = await deps.data.buildProjectsPayload(preferredWorkspaceId);
			return {
				currentProjectId: payload.currentProjectId,
				projects: payload.projects,
			};
		},
		addProject: async (preferredWorkspaceId, input) => {
			const body = parseProjectAddRequest(input);
			const preferredWorkspaceContext = preferredWorkspaceId
				? await loadWorkspaceContextById(preferredWorkspaceId)
				: null;
			const resolveBasePath =
				preferredWorkspaceContext?.repoPath ?? deps.workspaces.getActiveWorkspacePath() ?? process.cwd();
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
				const context = await loadWorkspaceContext(projectPath);
				deps.workspaces.rememberWorkspace(context.workspaceId, context.repoPath);
				const projectsAfterAdd = await listWorkspaceIndexEntries();
				const activeWorkspaceId = deps.workspaces.getActiveWorkspaceId();
				const hasActiveWorkspace = activeWorkspaceId
					? projectsAfterAdd.some((project) => project.workspaceId === activeWorkspaceId)
					: false;
				if (!hasActiveWorkspace) {
					await deps.workspaces.setActiveWorkspace(context.workspaceId, context.repoPath);
				}
				const taskCounts = await deps.data.summarizeProjectTaskCounts(context.workspaceId, context.repoPath);
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(context.workspaceId);
				return {
					ok: true,
					project: deps.data.createProjectSummary({
						workspaceId: context.workspaceId,
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
		removeProject: async (_preferredWorkspaceId, input) => {
			try {
				const body = parseProjectRemoveRequest(input);
				const projectsBeforeRemoval = await listWorkspaceIndexEntries();
				const projectToRemove = projectsBeforeRemoval.find((project) => project.workspaceId === body.projectId);
				if (!projectToRemove) {
					return {
						ok: false,
						error: `Unknown project ID: ${body.projectId}`,
					};
				}

				const taskIdsToCleanup = new Set<string>();
				try {
					const workspaceState = await loadWorkspaceState(projectToRemove.repoPath);
					for (const taskId of deps.collectProjectWorktreeTaskIdsForRemoval(workspaceState.board)) {
						taskIdsToCleanup.add(taskId);
					}
				} catch {
					// Best effort: if board state cannot be read, skip worktree cleanup IDs.
				}

				const removedTerminalManager = deps.terminals.getTerminalManagerForWorkspace(body.projectId);
				if (removedTerminalManager) {
					removedTerminalManager.markInterruptedAndStopAll();
				}

				const removed = await removeWorkspaceIndexEntry(body.projectId);
				if (!removed) {
					throw new Error(`Could not remove project index entry for "${body.projectId}".`);
				}
				await removeWorkspaceStateFiles(body.projectId);
				deps.disposeWorkspace(body.projectId, {
					stopTerminalSessions: false,
				});

				if (deps.workspaces.getActiveWorkspaceId() === body.projectId) {
					const remaining = await listWorkspaceIndexEntries();
					const fallbackWorkspace = remaining[0];
					if (fallbackWorkspace) {
						await deps.workspaces.setActiveWorkspace(fallbackWorkspace.workspaceId, fallbackWorkspace.repoPath);
					} else {
						deps.workspaces.clearActiveWorkspace();
					}
				}
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(deps.workspaces.getActiveWorkspaceId());
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
							const message = deleted.error ?? `Could not delete task workspace for task "${taskId}".`;
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
		reorderProjects: async (_preferredWorkspaceId, input) => {
			try {
				const body = parseProjectReorderRequest(input);
				await updateProjectOrder(body.projectOrder);
				void deps.broadcaster.broadcastRuntimeProjectsUpdated(deps.workspaces.getActiveWorkspaceId());
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
	};
}
