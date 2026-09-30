import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeProjectStateResponse, TaskResourceOperationCoordinator } from "../../src/core";
import { createProjectRegistry } from "../../src/server/project-registry";
import {
	loadProjectContext,
	loadProjectState,
	ProjectBoardCommandService,
	saveProjectState,
	updateProjectIndexMetadata,
} from "../../src/state";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { createDefaultMockConfig } from "../utilities/runtime-config-factory";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function createFixture() {
	const temp = createTempDir("project-state-publication-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(temp.path, "state"));
	const requestedPath = join(temp.path, "project");
	await mkdir(requestedPath);
	initGitRepository(requestedPath);
	await writeFile(join(requestedPath, "README.md"), "Synthetic publication fixture\n");
	commitAll(requestedPath, "Create synthetic fixture");
	const project = await loadProjectContext(requestedPath);
	const scope = { projectId: project.projectId, projectPath: project.repoPath };
	const sessions = {
		task: createTestTaskSessionSummary({
			taskId: "task",
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			sessionLaunchPath: project.repoPath,
		}),
	};
	await saveProjectState(project.repoPath, {
		board: {
			columns: [
				{
					id: "review",
					title: "Review",
					cards: [
						{
							id: "task",
							title: "Preserve metadata",
							prompt: "Synthetic task",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							useWorktree: false,
							workingDirectory: project.repoPath,
						},
					],
				},
			],
		},
		sessions,
	});
	const config = createDefaultMockConfig();
	const pathIsDirectory = vi.fn(async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false);
	const onTerminalManagerReady = vi.fn();
	const registry = await createProjectRegistry({
		cwd: temp.path,
		loadGlobalRuntimeConfig: async () => config,
		loadRuntimeConfig: async () => config,
		hasGitRepository: async (path) => path === project.repoPath,
		pathIsDirectory,
		onTerminalManagerReady,
	});
	const operations = new TaskResourceOperationCoordinator();
	const admission = vi.fn();
	registry.setProjectOperationRunner((projectId, operation) => {
		admission();
		return operations.runProject(projectId, operation);
	});
	const publications: RuntimeProjectStateResponse[] = [];
	const commands = new ProjectBoardCommandService({
		getAuthoritativeSessions: () => sessions,
		publishAuthoritativeState: async ({ projectId }, result) => {
			const state = await registry.buildProjectStatePublication(projectId, result.state);
			if (state) publications.push(state);
		},
	});
	return {
		project,
		scope,
		registry,
		operations,
		commands,
		publications,
		pathIsDirectory,
		onTerminalManagerReady,
		admission,
		cleanup: () => {
			registry.stopMaintenance();
			for (const { terminalManager } of registry.listManagedProjects()) terminalManager.stopReconciliation();
			temp.cleanup();
		},
	};
}

describe("committed project state publication", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it("preserves Git metadata and publishes unavailable drain writes without admission or manager acquisition", async () => {
		const fixture = await createFixture();
		try {
			const initial = await loadProjectState(fixture.project.repoPath);
			expect(initial.git).toMatchObject({ currentBranch: "main", defaultBranch: "main", branches: ["main"] });
			const result = await fixture.commands.reconcileRuntimeTaskBaseRef(fixture.scope, "task", "feature");
			expect(result.state.git.branches).toEqual([]);
			const published = fixture.publications.at(-1);
			expect(published).toMatchObject({
				repoPath: initial.repoPath,
				git: initial.git,
				availability: { status: "available" },
				revision: result.state.revision,
				board: result.state.board,
				sessions: result.state.sessions,
			});
			expect(published?.revision).toBeGreaterThan(initial.revision);

			await rename(fixture.project.repoPath, join(dirname(fixture.project.repoPath), "moved"));
			const drainReady = deferred();
			// Create the drain before exclusion, matching an already-running persistence
			// owner. It cannot inherit the exclusive caller's reentrant admission lease.
			const drain = drainReady.promise.then(() =>
				fixture.commands.reconcileRuntimeTaskBaseRef(fixture.scope, "task", "after-move"),
			);
			const drained = await fixture.operations.runProjectExclusive(fixture.project.projectId, async () => {
				drainReady.resolve();
				return await drain;
			});
			const unavailable = fixture.publications.at(-1);
			expect(unavailable).toMatchObject({
				revision: drained.state.revision,
				board: drained.state.board,
				availability: { status: "unavailable", reason: "missing" },
			});
			expect(unavailable?.metadataRevision).toBeGreaterThan(published?.metadataRevision ?? 0);
			expect(fixture.admission).not.toHaveBeenCalled();
			expect(fixture.onTerminalManagerReady).not.toHaveBeenCalled();
			expect(fixture.registry.listManagedProjects()).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	it("drops a committed projection when its path or observed metadata revision has been superseded", async () => {
		const fixture = await createFixture();
		const probeReached = deferred();
		const releaseProbe = deferred();
		try {
			const initial = await loadProjectState(fixture.project.repoPath);
			fixture.pathIsDirectory.mockImplementationOnce(async () => {
				probeReached.resolve();
				await releaseProbe.promise;
				return true;
			});
			const publication = fixture.registry.buildProjectStatePublication(fixture.project.projectId, initial);
			await probeReached.promise;
			await updateProjectIndexMetadata({ projectId: fixture.project.projectId, displayName: "A new name" });
			releaseProbe.resolve();
			expect(await publication).toBeNull();

			const movedPath = join(dirname(fixture.project.repoPath), "moved");
			await rename(fixture.project.repoPath, movedPath);
			await updateProjectIndexMetadata({ projectId: fixture.project.projectId, repoPath: movedPath });
			expect(await fixture.registry.buildProjectStatePublication(fixture.project.projectId, initial)).toBeNull();
			expect(fixture.admission).not.toHaveBeenCalled();
			expect(fixture.onTerminalManagerReady).not.toHaveBeenCalled();
		} finally {
			releaseProbe.resolve();
			fixture.cleanup();
		}
	});
});
