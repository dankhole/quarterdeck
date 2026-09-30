import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	deriveProjectSummary,
	findCardInBoard,
	KeyedOperationCoordinator,
	TaskResourceOperationCoordinator,
} from "../../src/core";
import { observeProjectAvailability } from "../../src/projects/project-availability";
import { ProjectLocationService } from "../../src/server/project-location-service";
import {
	listProjectIndexEntries,
	loadProjectContext,
	loadProjectScopeById,
	loadSavedProjectStateById,
	ProjectBoardCommandService,
	saveProjectState,
} from "../../src/state";
import { type CreateProjectsApiDependencies, createProjectsApi } from "../../src/trpc/projects-api";
import { readProjectRelocationJournal } from "../../src/workdir/project-relocation";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

async function fixture(root: string) {
	const oldPath = join(root, "project");
	await mkdir(oldPath);
	const project = await loadProjectContext(oldPath, { folderOnly: true });
	const newPath = join(dirname(project.repoPath), "renamed");
	await saveProjectState(oldPath, {
		board: {
			columns: [
				{
					id: "review",
					title: "Review",
					cards: [
						{
							id: "task",
							title: "Keep this task",
							prompt: "Synthetic relocation task",
							baseRef: "",
							createdAt: 1,
							updatedAt: 1,
							workingDirectory: project.repoPath,
							useWorktree: false,
						},
					],
				},
			],
		},
		sessions: {
			task: createTestTaskSessionSummary({
				taskId: "task",
				sessionLaunchPath: project.repoPath,
				resumeSessionId: "opaque-provider-session",
				state: "awaiting_review",
				reviewReason: "hook",
				startupRecoveryRequired: true,
			}),
		},
	});
	const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
	const stopProject = vi.fn(async () => {});
	const suspendProject = vi.fn(async () => {});
	const rebind = vi.fn(async () => {});
	const registration = new KeyedOperationCoordinator();
	const operations = new TaskResourceOperationCoordinator();
	const runRegistrationMutation = <T>(operation: () => Promise<T>): Promise<T> =>
		registration.run("projects", operation);
	const service = new ProjectLocationService({
		runRegistrationMutation,
		operations,
		boardCommands,
		assertRuntimeExclusive: async () => {},
		stopProject,
		suspendProject,
		refreshProject: async () => {},
		publishProjects: async () => {},
		warn: () => {},
		registry: {
			rebindProjectLocation: rebind,
			checkProjectAvailability: async (projectId) => {
				const scope = await loadProjectScopeById(projectId);
				if (!scope) throw new Error("Missing fixture");
				return await observeProjectAvailability(scope);
			},
			buildProjectSummary: async (projectId) => {
				const scope = await loadProjectScopeById(projectId);
				const state = await loadSavedProjectStateById(projectId);
				if (!scope || !state) throw new Error("Missing fixture");
				return deriveProjectSummary({
					...scope,
					board: state.board,
					boardRevision: state.revision,
					availability: await observeProjectAvailability(scope),
				});
			},
			buildProjectStateSnapshot: async (projectId) => {
				const state = await loadSavedProjectStateById(projectId);
				if (!state) throw new Error("Missing fixture");
				return state;
			},
		},
	});
	return {
		...project,
		oldPath: project.repoPath,
		newPath,
		boardCommands,
		service,
		stopProject,
		suspendProject,
		rebind,
		runRegistrationMutation,
		operations,
	};
}

describe("project location orchestration", { concurrent: false }, () => {
	it("drains metadata delivered after relocation exclusion without queuing it behind that exclusion", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-metadata-drain-");
			try {
				const f = await fixture(temp.path);
				f.boardCommands.setProjectOperationRunner((scope, operation) =>
					f.operations.runProject(scope.projectId, operation),
				);
				let deliverMetadata!: () => void;
				const delivered = new Promise<void>((resolve) => {
					deliverMetadata = resolve;
				});
				// The callback is registered outside relocation's async ownership context,
				// as a background Git refresh is before exclusive admission is requested.
				const metadata = delivered.then(() =>
					f.boardCommands.reconcileRuntimeTaskBaseRef(
						{ projectId: f.projectId, projectPath: f.oldPath },
						"task",
						"updated-base",
					),
				);
				f.stopProject.mockImplementation(async () => {
					deliverMetadata();
					await new Promise<void>((resolve) => setImmediate(resolve));
				});
				f.suspendProject.mockImplementation(async () => {
					await metadata;
				});
				const result = await f.service.renameFolder({
					projectId: f.projectId,
					expectedPath: f.oldPath,
					folderName: "renamed",
				});
				expect(result.ok).toBe(true);
				expect(findCardInBoard(result.state?.board ?? { columns: [] }, "task")?.baseRef).toBe("updated-base");
			} finally {
				temp.cleanup();
			}
		});
	});
	it("holds Add and Remove until a pending relocation commits its registration", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-registration-race-");
			try {
				const f = await fixture(temp.path);
				let releaseStop!: () => void;
				let signalStopped!: () => void;
				const stopReached = new Promise<void>((resolve) => {
					signalStopped = resolve;
				});
				const stopBarrier = new Promise<void>((resolve) => {
					releaseStop = resolve;
				});
				f.stopProject.mockImplementation(async () => {
					signalStopped();
					await stopBarrier;
				});
				const pathsAtRemoval: string[] = [];
				const api = createProjectsApi({
					boardCommands: f.boardCommands,
					hasGitRepository: async () => false,
					warn: () => {},
					hostIntegrations: { pickDirectory: async () => ({ ok: false, path: null, reason: "cancelled" }) },
					runRegistrationMutation: f.runRegistrationMutation,
					runProjectRemoval: (projectId: string, operation: () => Promise<unknown>) =>
						f.operations.runProjectExclusive(projectId, operation),
					projectLocations: f.service,
					projects: {
						getActiveProjectId: () => f.projectId,
						getActiveProjectPath: () => f.oldPath,
						rememberProject: () => {},
						setActiveProject: async () => {},
						clearActiveProject: () => {},
					},
					data: {
						buildProjectSummary: async (projectId: string) => {
							const scope = await loadProjectScopeById(projectId);
							const state = await loadSavedProjectStateById(projectId);
							if (!scope || !state) throw new Error("Missing fixture");
							return deriveProjectSummary({ ...scope, board: state.board, boardRevision: state.revision });
						},
					},
					broadcaster: {
						broadcastRuntimeProjectsUpdated: async () => {},
						broadcastRuntimeProjectStateUpdated: async () => {},
					},
					resolveProjectInputPath: (path: string) => path,
					assertPathIsDirectory: async () => {},
					terminals: { getTerminalManagerForProject: () => null },
					prepareProjectRemoval: async (_projectId: string, path: string) => {
						pathsAtRemoval.push(path);
						return { ok: true };
					},
					disposeProject: async () => ({ terminalManager: null, projectPath: null }),
					collectProjectWorktreeTaskIdsForRemoval: () => new Set<string>(),
				} as unknown as CreateProjectsApiDependencies);
				const move = f.service.renameFolder({
					projectId: f.projectId,
					expectedPath: f.oldPath,
					folderName: "renamed",
				});
				await stopReached;
				const add = api.addProject(null, { path: f.newPath, folderOnly: true });
				const remove = api.removeProject(null, { projectId: f.projectId });
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(pathsAtRemoval).toEqual([]);
				expect(await listProjectIndexEntries()).toHaveLength(1);
				releaseStop();
				const [, added, removed] = await Promise.all([move, add, remove]);
				expect(added.ok).toBe(true);
				expect(added.project?.id).toBe(f.projectId);
				expect(removed.ok).toBe(true);
				expect(pathsAtRemoval).toEqual([added.project?.path]);
				expect(await listProjectIndexEntries()).toEqual([]);
			} finally {
				temp.cleanup();
			}
		});
	});
	it("locates an externally renamed folder while retaining identity, tasks and explicit resume history", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-locate-");
			try {
				const f = await fixture(temp.path);
				await rename(f.oldPath, f.newPath);
				const result = await f.service.locate({ projectId: f.projectId, expectedPath: f.oldPath, path: f.newPath });
				expect(result.ok).toBe(true);
				expect(result.project?.id).toBe(f.projectId);
				expect(findCardInBoard(result.state?.board ?? { columns: [] }, "task")?.workingDirectory).toBe(
					result.project?.path,
				);
				expect(result.state?.sessions.task).toMatchObject({
					resumeSessionId: "opaque-provider-session",
					pid: null,
					startupRecoveryRequired: false,
					sessionLaunchPath: result.project?.path,
				});
				expect(f.stopProject).toHaveBeenCalledOnce();
				expect(await readProjectRelocationJournal(f.projectId)).toBeNull();
			} finally {
				temp.cleanup();
			}
		});
	});

	it("validates stale scope and invalid names before stopping sessions, while display naming has no lifecycle effects", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-name-");
			try {
				const f = await fixture(temp.path);
				expect(
					(
						await f.service.renameFolder({
							projectId: f.projectId,
							expectedPath: f.oldPath,
							folderName: "../escape",
						})
					).ok,
				).toBe(false);
				expect(
					(await f.service.locate({ projectId: f.projectId, expectedPath: f.newPath, path: f.oldPath })).ok,
				).toBe(false);
				expect((await f.service.rename({ projectId: f.projectId, name: "Friendly project" })).project?.name).toBe(
					"Friendly project",
				);
				expect(f.stopProject).not.toHaveBeenCalled();
				expect(f.suspendProject).not.toHaveBeenCalled();
			} finally {
				temp.cleanup();
			}
		});
	});

	it("keeps interrupted disk changes blocked and retries the matching intent without creating a second project", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-recover-");
			try {
				const f = await fixture(temp.path);
				vi.spyOn(f.boardCommands, "relocateProjectPaths").mockRejectedValueOnce(
					new Error("Synthetic durable write failure"),
				);
				const first = await f.service.renameFolder({
					projectId: f.projectId,
					expectedPath: f.oldPath,
					folderName: "renamed",
				});
				expect(first.ok).toBe(false);
				expect(await readProjectRelocationJournal(f.projectId)).not.toBeNull();
				const pendingScope = await loadProjectScopeById(f.projectId);
				if (!pendingScope) throw new Error("Missing fixture");
				expect(await observeProjectAvailability(pendingScope)).toEqual({
					status: "unavailable",
					reason: "relocation_pending",
				});
				const retry = await f.service.locate({ projectId: f.projectId, expectedPath: f.oldPath, path: f.newPath });
				expect(retry.ok).toBe(true);
				expect(retry.project?.id).toBe(f.projectId);
				expect(await readProjectRelocationJournal(f.projectId)).toBeNull();
			} finally {
				temp.cleanup();
			}
		});
	});

	it("retries a journaled rename through Locate before its destination exists", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-recover-before-rename-");
			try {
				const f = await fixture(temp.path);
				f.stopProject.mockRejectedValueOnce(new Error("Synthetic session stop failure"));
				const first = await f.service.renameFolder({
					projectId: f.projectId,
					expectedPath: f.oldPath,
					folderName: "renamed",
				});
				expect(first.ok).toBe(false);
				expect((await stat(f.oldPath)).isDirectory()).toBe(true);
				await expect(stat(f.newPath)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await readProjectRelocationJournal(f.projectId)).toMatchObject({
					phase: "prepared",
					oldPath: f.oldPath,
					newPath: f.newPath,
				});
				const unrelated = await f.service.locate({
					projectId: f.projectId,
					expectedPath: f.oldPath,
					path: join(temp.path, "other"),
				});
				expect(unrelated.ok).toBe(false);
				expect(f.stopProject).toHaveBeenCalledOnce();
				const retry = await f.service.locate({ projectId: f.projectId, expectedPath: f.oldPath, path: f.newPath });
				expect(retry.ok).toBe(true);
				expect(retry.project?.id).toBe(f.projectId);
				expect(retry.project?.path).toBe(f.newPath);
				expect(await readProjectRelocationJournal(f.projectId)).toBeNull();
			} finally {
				temp.cleanup();
			}
		});
	});

	it("rejects a resumed rename when the original directory identity changed", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("project-recover-replaced-source-");
			try {
				const f = await fixture(temp.path);
				f.stopProject.mockRejectedValueOnce(new Error("Synthetic session stop failure"));
				await f.service.renameFolder({ projectId: f.projectId, expectedPath: f.oldPath, folderName: "renamed" });
				const preservedPath = join(dirname(f.oldPath), "original");
				await rename(f.oldPath, preservedPath);
				await mkdir(f.oldPath);
				const retry = await f.service.locate({ projectId: f.projectId, expectedPath: f.oldPath, path: f.newPath });
				expect(retry).toMatchObject({ ok: false, error: expect.stringContaining("original folder changed") });
				expect((await stat(preservedPath)).isDirectory()).toBe(true);
				expect((await stat(f.oldPath)).isDirectory()).toBe(true);
				await expect(stat(f.newPath)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await readProjectRelocationJournal(f.projectId)).toMatchObject({ phase: "prepared" });
			} finally {
				temp.cleanup();
			}
		});
	});
});
