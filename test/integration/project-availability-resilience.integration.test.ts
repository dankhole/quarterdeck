import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitRepositoryProbeResult } from "../../src/projects/git-repository-probe";
import { createProjectRegistry, ProjectGitBusyError } from "../../src/server/project-registry";
import {
	loadProjectContext,
	loadProjectScopeById,
	ProjectBoardCommandService,
	saveProjectState,
	updateProjectIndexMetadata,
} from "../../src/state";
import { createEmptyBoard } from "../../src/state/project-state-index";
import type { TerminalSessionManager } from "../../src/terminal";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { createDefaultMockConfig } from "../utilities/runtime-config-factory";
import { createTempDir } from "../utilities/temp-dir";

async function createFixture() {
	const temp = createTempDir("project-availability-resilience-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(temp.path, "state"));
	const requestedPath = join(temp.path, "project");
	await mkdir(requestedPath);
	initGitRepository(requestedPath);
	await writeFile(join(requestedPath, "README.md"), "Synthetic availability fixture\n");
	commitAll(requestedPath, "Create synthetic fixture");
	const project = await loadProjectContext(requestedPath);
	await saveProjectState(project.repoPath, { board: createEmptyBoard(), sessions: {} });
	const config = createDefaultMockConfig();
	const probeResults: GitRepositoryProbeResult[] = [];
	const probeGitRepository = vi.fn(
		async (path: string): Promise<GitRepositoryProbeResult> =>
			path === project.repoPath ? (probeResults.shift() ?? "repository") : "not_repository",
	);
	const registry = await createProjectRegistry({
		cwd: temp.path,
		loadGlobalRuntimeConfig: async () => config,
		loadRuntimeConfig: async () => config,
		probeGitRepository,
		pathIsDirectory: async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
	});
	probeGitRepository.mockClear();
	const metadataRevision = async () => (await loadProjectScopeById(project.projectId))?.metadataRevision;
	return {
		temp,
		project,
		registry,
		probeResults,
		probeGitRepository,
		metadataRevision,
		cleanup: () => {
			registry.stopMaintenance();
			for (const { terminalManager } of registry.listManagedProjects()) terminalManager.stopReconciliation();
			temp.cleanup();
		},
	};
}

describe("project availability resilience", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it("keeps the last definite availability and leaves the index untouched when Git cannot answer", async () => {
		const fixture = await createFixture();
		try {
			const { projectId } = fixture.project;
			await expect(fixture.registry.checkProjectAvailability(projectId)).resolves.toEqual({ status: "available" });
			const initialRevision = await fixture.metadataRevision();

			fixture.probeResults.push("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(projectId)).resolves.toEqual({ status: "available" });
			expect(await fixture.metadataRevision()).toBe(initialRevision);

			fixture.probeResults.push("not_repository");
			await expect(fixture.registry.checkProjectAvailability(projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			const notRepositoryRevision = await fixture.metadataRevision();
			expect(notRepositoryRevision).toBe((initialRevision ?? 0) + 1);

			// An indeterminate probe keeps the definite absence instead of flipping back.
			fixture.probeResults.push("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			expect(await fixture.metadataRevision()).toBe(notRepositoryRevision);
		} finally {
			fixture.cleanup();
		}
	});

	it("reuses a recent Git answer for cached reads while explicit checks probe again", async () => {
		const fixture = await createFixture();
		try {
			const { projectId } = fixture.project;
			await fixture.registry.checkProjectAvailability(projectId, "cached");
			await fixture.registry.checkProjectAvailability(projectId, "cached");
			await fixture.registry.buildProjectSummary(projectId, fixture.project.repoPath);
			expect(fixture.probeGitRepository).toHaveBeenCalledTimes(1);
			await fixture.registry.checkProjectAvailability(projectId);
			expect(fixture.probeGitRepository).toHaveBeenCalledTimes(2);

			// Concurrent readers share one in-flight probe instead of queueing one each.
			let releaseProbe!: () => void;
			const probeGate = new Promise<void>((resolveGate) => {
				releaseProbe = resolveGate;
			});
			fixture.probeGitRepository.mockImplementationOnce(async () => {
				await probeGate;
				return "repository";
			});
			const readers = Promise.all(
				Array.from({ length: 5 }, () => fixture.registry.checkProjectAvailability(projectId, "fresh")),
			);
			await vi.waitFor(() => expect(fixture.probeGitRepository).toHaveBeenCalledTimes(3));
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
			releaseProbe();
			await expect(readers).resolves.toEqual(Array.from({ length: 5 }, () => ({ status: "available" })));
			expect(fixture.probeGitRepository).toHaveBeenCalledTimes(3);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects a launch with a retryable error after an indeterminate probe is retried once", async () => {
		const fixture = await createFixture();
		try {
			const { projectId, repoPath } = fixture.project;
			const manager: TerminalSessionManager = await fixture.registry.ensureTerminalManagerForProject(
				projectId,
				repoPath,
			);
			await fixture.registry.checkProjectAvailability(projectId, "cached");
			fixture.probeGitRepository.mockClear();
			fixture.probeResults.push("indeterminate", "indeterminate");
			const launch = manager.startTaskSession({
				taskId: "synthetic-task",
				agentId: "claude",
				binary: "synthetic-agent",
				args: [],
				cwd: repoPath,
				prompt: "",
			} as unknown as Parameters<TerminalSessionManager["startTaskSession"]>[0]);
			await expect(launch).rejects.toBeInstanceOf(ProjectGitBusyError);
			// Launch admission ignored the cached answer and probed twice.
			expect(fixture.probeGitRepository).toHaveBeenCalledTimes(2);
		} finally {
			fixture.cleanup();
		}
	});

	it("reuses project summaries until the board revision or index metadata changes", async () => {
		const fixture = await createFixture();
		try {
			const { projectId, repoPath } = fixture.project;
			const first = await fixture.registry.buildProjectsPayload(projectId);
			const second = await fixture.registry.buildProjectsPayload(projectId);
			expect(second.projects[0]).toBe(first.projects[0]);

			const commands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
			await commands.execute({ projectId, projectPath: repoPath }, {
				commandId: "create-synthetic-task",
				expectedRevision: first.projects[0]?.boardRevision ?? 0,
				command: {
					kind: "create_task",
					columnId: "review",
					taskId: "synthetic-task",
					prompt: "Synthetic task",
					baseRef: "main",
					createdAt: 1,
				},
			} as Parameters<ProjectBoardCommandService["execute"]>[1]);
			const afterCommand = await fixture.registry.buildProjectsPayload(projectId);
			expect(afterCommand.projects[0]).not.toBe(first.projects[0]);
			expect(afterCommand.projects[0]?.taskCounts.review).toBe(1);

			await updateProjectIndexMetadata({ projectId, displayName: "Renamed synthetic project" });
			const afterRename = await fixture.registry.buildProjectsPayload(projectId);
			expect(afterRename.projects[0]?.name).toBe("Renamed synthetic project");
		} finally {
			fixture.cleanup();
		}
	});

	it("reports why a committed projection cannot be published", async () => {
		const fixture = await createFixture();
		try {
			const { projectId } = fixture.project;
			const state = await fixture.registry.buildProjectStateSnapshot(projectId);
			await expect(fixture.registry.prepareProjectStatePublication(projectId, state)).resolves.toMatchObject({
				status: "ready",
				state: { revision: state.revision, availability: { status: "available" } },
			});
			await expect(
				fixture.registry.prepareProjectStatePublication(projectId, {
					...state,
					repoPath: join(fixture.temp.path, "x"),
				}),
			).resolves.toEqual({ status: "superseded" });
		} finally {
			fixture.cleanup();
		}
	});
});
