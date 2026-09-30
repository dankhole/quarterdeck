import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../src/core";
import { ProjectLocationService } from "../../src/server/project-location-service";
import { createProjectRegistry } from "../../src/server/project-registry";
import { RuntimeSessionPersistence } from "../../src/server/runtime-session-persistence";
import {
	loadProjectContext,
	loadProjectScopeById,
	ProjectBoardCommandService,
	saveProjectState,
} from "../../src/state";
import type { TerminalSessionManager } from "../../src/terminal";
import type { RuntimeTrpcContext, RuntimeTrpcProjectScope } from "../../src/trpc";
import { createDefaultMockConfig } from "./runtime-config-factory";
import { createTestTaskSessionSummary } from "./task-session-factory";
import { createTempDir } from "./temp-dir";

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export async function createProjectRelocationFixture(
	callbacks: {
		beforeDirectoryProbe?: () => Promise<void>;
		onExclusiveRequested?: () => void;
		onExclusiveEntered?: () => void;
	} = {},
) {
	const temp = createTempDir("project-relocation-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(temp.path, "state"));
	await mkdir(join(temp.path, "project"));
	const project = await loadProjectContext(join(temp.path, "project"), { folderOnly: true });
	const oldPath = project.repoPath;
	await saveProjectState(oldPath, {
		board: {
			columns: [
				{
					id: "review",
					title: "Review",
					cards: [
						{
							id: "task",
							title: "Keep session history",
							prompt: "Synthetic task",
							baseRef: "",
							createdAt: 1,
							updatedAt: 1,
							useWorktree: false,
							workingDirectory: oldPath,
						},
					],
				},
			],
		},
		sessions: {
			task: createTestTaskSessionSummary({
				taskId: "task",
				sessionLaunchPath: oldPath,
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
			}),
		},
	});
	const operations = new TaskResourceOperationCoordinator();
	const suspended = deferred();
	const continueMove = deferred();
	const suspension = { entered: false, reached: suspended.promise, resume: continueMove.resolve };
	let persistence: RuntimeSessionPersistence | undefined;
	const readyAfterSuspend: TerminalSessionManager[] = [];
	const pathIsDirectory = vi.fn(async (path: string) => {
		await callbacks.beforeDirectoryProbe?.();
		return (await stat(path)).isDirectory();
	});
	const config = createDefaultMockConfig({ llmSummaryPolishEnabled: true });
	const registry = await createProjectRegistry({
		cwd: oldPath,
		loadGlobalRuntimeConfig: async () => config,
		loadRuntimeConfig: async () => config,
		hasGitRepository: async () => false,
		pathIsDirectory,
		onTerminalManagerReady: (projectId, manager) => {
			if (suspension.entered) readyAfterSuspend.push(manager);
			persistence?.trackTerminalManager(projectId, manager);
		},
	});
	registry.setProjectOperationRunner((projectId, operation) => operations.runProject(projectId, operation));
	const oldManager = registry.getTerminalManagerForProject(project.projectId);
	if (!oldManager) throw new Error("Fixture did not hydrate the original manager.");
	const runProjectOperation: RuntimeTrpcContext["runProjectOperation"] = (scope, operation) =>
		operations.runProject(scope.projectId, async () => {
			const current = await loadProjectScopeById(scope.projectId);
			if (current?.repoPath !== scope.projectPath) throw new Error("Project folder changed.");
			if ((await registry.checkProjectAvailability(scope.projectId)).status !== "available") {
				throw new Error("Project folder unavailable.");
			}
			return await operation();
		});
	const getAuthoritativeSessions = vi.fn(async ({ projectId, projectPath }: RuntimeTrpcProjectScope) => {
		const manager = await registry.ensureTerminalManagerForProject(projectId, projectPath);
		return Object.fromEntries(manager.store.listSummaries().map((summary) => [summary.taskId, summary]));
	});
	const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions });
	boardCommands.setProjectOperationRunner(runProjectOperation);
	persistence = new RuntimeSessionPersistence({ projectRegistry: registry, boardCommands });
	const sessionPersistence = persistence;
	sessionPersistence.trackTerminalManager(project.projectId, oldManager);
	await sessionPersistence.persistRuntimeSessions(project.projectId);
	const service = new ProjectLocationService({
		runRegistrationMutation: async (operation) => await operation(),
		operations: {
			runProjectExclusive: (projectId, operation) => {
				const result = operations.runProjectExclusive(projectId, async () => {
					callbacks.onExclusiveEntered?.();
					return await operation();
				});
				callbacks.onExclusiveRequested?.();
				return result;
			},
		},
		registry,
		boardCommands,
		assertRuntimeExclusive: async () => {},
		stopProject: async ({ projectId }) => {
			const manager = registry.getTerminalManagerForProject(projectId);
			if (!manager) throw new Error("Original manager disappeared before relocation.");
			manager.stopReconciliation();
			manager.markInterruptedAndStopAll();
			await manager.waitForShutdownQuiescence();
			await sessionPersistence.persistRuntimeSessions(projectId);
		},
		suspendProject: async (projectId) => {
			await sessionPersistence.disposeProject(projectId);
			suspension.entered = true;
			suspended.resolve();
			await continueMove.promise;
		},
		refreshProject: async (projectId) => {
			await registry.buildProjectStateSnapshot(projectId);
		},
		publishProjects: async () => {},
		warn: () => {},
	});
	return {
		project,
		oldPath,
		registry,
		oldManager,
		service,
		boardCommands,
		sessionPersistence,
		runProjectOperation,
		getAuthoritativeSessions,
		pathIsDirectory,
		readyAfterSuspend,
		suspension,
		cleanup: async (pending: Promise<unknown>[]) => {
			suspension.resume();
			await Promise.allSettled(pending);
			registry.stopMaintenance();
			for (const { terminalManager } of registry.listManagedProjects()) terminalManager.stopReconciliation();
			oldManager.stopReconciliation();
			await sessionPersistence.close();
			temp.cleanup();
		},
	};
}
