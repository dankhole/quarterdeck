import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	RuntimeProjectCheckAvailabilityRequest,
	RuntimeProjectLocateRequest,
	RuntimeProjectManagementResponse,
	RuntimeProjectRenameFolderRequest,
	RuntimeProjectRenameRequest,
	TaskResourceOperationCoordinator,
} from "../core";
import { areFileSystemPathsEqual } from "../core";
import { isNodeError } from "../fs/node-error";
import {
	listProjectIndexEntries,
	loadProjectScopeById,
	loadSavedProjectStateById,
	type ProjectBoardCommandService,
	updateProjectIndexMetadata,
} from "../state";
import {
	applyProjectRelocation,
	beginProjectRelocation,
	finalizeProjectRelocation,
	markProjectRelocationIndexCommitted,
	type ProjectRelocationPlan,
	prepareProjectRelocation,
	readProjectRelocationJournal,
	recoverProjectRelocation,
	withProjectRelocationLock,
} from "../workdir/project-relocation";
import type { ProjectRegistry } from "./project-registry";

interface ProjectLocationServiceDependencies {
	runRegistrationMutation: <T>(operation: () => Promise<T>) => Promise<T>;
	operations: Pick<TaskResourceOperationCoordinator, "runProjectExclusive">;
	registry: Pick<
		ProjectRegistry,
		"checkProjectAvailability" | "buildProjectSummary" | "buildProjectStateSnapshot" | "rebindProjectLocation"
	>;
	boardCommands: Pick<ProjectBoardCommandService, "relocateProjectPaths">;
	assertRuntimeExclusive: () => Promise<void>;
	stopProject: (scope: { projectId: string; projectPath: string }) => Promise<void>;
	suspendProject: (projectId: string) => Promise<void>;
	refreshProject: (projectId: string, path: string) => Promise<void>;
	publishProjects: () => Promise<void>;
	warn: (message: string) => void;
}

/** Coordinates location intent; filesystem repair and durable board mutation retain their owners. */
export class ProjectLocationService {
	constructor(private readonly deps: ProjectLocationServiceDependencies) {}

	rename = async (input: RuntimeProjectRenameRequest): Promise<RuntimeProjectManagementResponse> =>
		await this.result(input.projectId, async () => {
			await updateProjectIndexMetadata({ projectId: input.projectId, displayName: input.name });
		});

	checkAvailability = async (
		input: RuntimeProjectCheckAvailabilityRequest,
	): Promise<RuntimeProjectManagementResponse> =>
		await this.result(input.projectId, async () => {
			await this.deps.registry.checkProjectAvailability(input.projectId);
		});

	locate = async (input: RuntimeProjectLocateRequest): Promise<RuntimeProjectManagementResponse> =>
		await this.relocate(input.projectId, input.expectedPath, { kind: "locate", path: input.path });

	renameFolder = async (input: RuntimeProjectRenameFolderRequest): Promise<RuntimeProjectManagementResponse> =>
		await this.relocate(input.projectId, input.expectedPath, { kind: "rename", folderName: input.folderName });

	/** Must finish before hydration can queue a startup launch. Uncertain journals stay unavailable. */
	async recoverPendingProjects(): Promise<void> {
		for (const entry of await listProjectIndexEntries()) {
			try {
				if (!(await readProjectRelocationJournal(entry.projectId))) continue;
				await this.deps.runRegistrationMutation(() =>
					this.deps.operations.runProjectExclusive(
						entry.projectId,
						async () =>
							await withProjectRelocationLock(entry.projectId, async () => {
								const plan = await readProjectRelocationJournal(entry.projectId);
								if (!plan) return;
								await this.deps.assertRuntimeExclusive();
								await this.quiesce(plan);
								await recoverProjectRelocation(plan);
								await this.commit(plan);
							}),
					),
				);
			} catch (error) {
				this.deps.warn(`Project folder recovery remains pending: ${errorMessage(error)}`);
			}
		}
	}

	private async relocate(
		projectId: string,
		expectedPath: string,
		destination: { kind: "locate"; path: string } | { kind: "rename"; folderName: string },
	): Promise<RuntimeProjectManagementResponse> {
		return await this.result(projectId, async () => {
			// Read-only validation avoids interrupting sessions for an invalid destination.
			const initialPending = await readProjectRelocationJournal(projectId);
			if (initialPending) await this.assertMatchingRetry(initialPending, expectedPath, destination);
			else await this.prepare(projectId, expectedPath, destination);
			await this.deps.runRegistrationMutation(() =>
				this.deps.operations.runProjectExclusive(
					projectId,
					async () =>
						await withProjectRelocationLock(projectId, async () => {
							const pending = await readProjectRelocationJournal(projectId);
							if (pending) {
								await this.assertMatchingRetry(pending, expectedPath, destination);
								await this.deps.assertRuntimeExclusive();
								await this.quiesce(pending);
								await recoverProjectRelocation(pending);
								await this.commit(pending);
								return;
							}
							const plan = await this.prepare(projectId, expectedPath, destination);
							await this.deps.assertRuntimeExclusive();
							await beginProjectRelocation(plan);
							await this.deps.assertRuntimeExclusive();
							await this.quiesce(plan);
							await applyProjectRelocation(plan);
							await this.commit(plan);
						}),
				),
			);
		});
	}

	private async assertMatchingRetry(
		plan: ProjectRelocationPlan,
		expectedPath: string,
		destination: { kind: "locate"; path: string } | { kind: "rename"; folderName: string },
	): Promise<void> {
		const requestedPath =
			destination.kind === "locate"
				? await realpath(destination.path).catch((error: unknown) => {
						const requested = resolve(destination.path);
						// A failed stop can leave the rename journal before any disk effect.
						// Only its exact recorded destination may resume a still-pending rename.
						if (
							plan.kind === "rename" &&
							isNodeError(error, "ENOENT") &&
							areFileSystemPathsEqual(requested, plan.newPath)
						) {
							return requested;
						}
						throw error;
					})
				: resolve(dirname(plan.oldPath), destination.folderName);
		if (
			(!areFileSystemPathsEqual(expectedPath, plan.oldPath) &&
				!areFileSystemPathsEqual(expectedPath, plan.newPath)) ||
			!areFileSystemPathsEqual(requestedPath, plan.newPath)
		)
			throw new Error(`A previous folder change is pending. Locate ${plan.newPath} to finish it.`);
	}

	private async prepare(
		projectId: string,
		expectedPath: string,
		destination: { kind: "locate"; path: string } | { kind: "rename"; folderName: string },
	): Promise<ProjectRelocationPlan> {
		const scope = await loadProjectScopeById(projectId);
		if (!scope) throw new Error("Project no longer exists.");
		if (!areFileSystemPathsEqual(scope.repoPath, expectedPath)) {
			throw new Error("The project folder changed. Refresh the project and try again.");
		}
		const saved = await loadSavedProjectStateById(projectId);
		if (!saved) throw new Error("Project state is unavailable.");
		return await prepareProjectRelocation({
			projectId,
			oldPath: scope.repoPath,
			destination,
			folderOnly: scope.folderOnly,
			directoryIdentity: scope.directoryIdentity,
			projects: await listProjectIndexEntries(),
			board: saved.board,
		});
	}

	private async quiesce(plan: ProjectRelocationPlan): Promise<void> {
		await this.deps.stopProject({ projectId: plan.projectId, projectPath: plan.oldPath });
		await this.deps.suspendProject(plan.projectId);
	}

	private async commit(plan: ProjectRelocationPlan): Promise<void> {
		await this.deps.boardCommands.relocateProjectPaths(
			plan.projectId,
			plan.oldPath,
			plan.newPath,
			plan.taskWorkingDirectories,
		);
		const current = await loadProjectScopeById(plan.projectId);
		if (!current) throw new Error("Project no longer exists.");
		if (
			!areFileSystemPathsEqual(current.repoPath, plan.oldPath) &&
			!areFileSystemPathsEqual(current.repoPath, plan.newPath)
		) {
			throw new Error("The saved project location changed while folder recovery was pending.");
		}
		await updateProjectIndexMetadata({
			projectId: plan.projectId,
			expectedPath: current.repoPath,
			repoPath: plan.newPath,
			directoryIdentity: plan.directoryIdentity,
		});
		await markProjectRelocationIndexCommitted(plan);
		await this.deps.registry.rebindProjectLocation(plan.projectId, plan.newPath);
		await finalizeProjectRelocation(plan);
		await this.deps.refreshProject(plan.projectId, plan.newPath);
	}

	private async result(projectId: string, operation: () => Promise<void>): Promise<RuntimeProjectManagementResponse> {
		try {
			await operation();
			const scope = await loadProjectScopeById(projectId);
			if (!scope) throw new Error("Project no longer exists.");
			await this.deps.publishProjects();
			return {
				ok: true,
				project: await this.deps.registry.buildProjectSummary(projectId, scope.repoPath),
				state: await this.deps.registry.buildProjectStateSnapshot(projectId),
			};
		} catch (error) {
			await this.deps.publishProjects().catch(() => undefined);
			return { ok: false, project: null, error: errorMessage(error) };
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
