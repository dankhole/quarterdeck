import { describe, expect, it } from "vitest";

import type { GitRepositoryProbeResult } from "../../../src/projects/git-repository-probe";
import { type CreateProjectsApiDependencies, createProjectsApi } from "../../../src/trpc/projects-api";
import { createTempDir, withTemporaryHome } from "../../utilities/temp-dir";

/**
 * Add-project must not offer "Initialize Git" when the probe only failed to
 * complete (indeterminate) — doing so risks creating a second, unwanted
 * repository over one that could not be confirmed right now (e.g. the
 * runtime was busy under load). Only a *definitive* "not a repository"
 * result may offer initialization.
 */
function createApi(probeGitRepository: () => Promise<GitRepositoryProbeResult>) {
	const unused = (): never => {
		throw new Error("not expected to be called in this test");
	};
	return createProjectsApi({
		hostIntegrations: { pickDirectory: unused },
		runRegistrationMutation: async <T>(operation: () => Promise<T>) => await operation(),
		runProjectRemoval: async <T>(_projectId: string, operation: () => Promise<T>) => await operation(),
		projectLocations: { rename: unused, locate: unused, renameFolder: unused, checkAvailability: unused },
		projects: {
			getActiveProjectId: () => null,
			getActiveProjectPath: () => null,
			getProjectPathById: unused,
			rememberProject: () => {},
			setActiveProject: unused,
			clearActiveProject: unused,
		},
		boardCommands: { resolveMissingTaskBaseRefs: unused },
		terminals: { getTerminalManagerForProject: unused, ensureTerminalManagerForProject: unused },
		broadcaster: {
			broadcastRuntimeProjectsUpdated: async () => {},
			broadcastRuntimeProjectStateUpdated: async () => {},
		},
		data: { buildProjectStateSnapshot: unused, buildProjectsPayload: unused, buildProjectSummary: unused },
		resolveProjectInputPath: (inputPath: string) => inputPath,
		assertPathIsDirectory: async () => {},
		probeGitRepository,
		disposeProject: unused,
		prepareProjectRemoval: unused,
		collectProjectWorktreeTaskIdsForRemoval: unused,
		warn: () => {},
	} as unknown as CreateProjectsApiDependencies);
}

describe("projects API add-project Git probe handling", () => {
	it("asks to retry instead of offering Git initialization when the probe is indeterminate", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("projects-api-add-indeterminate-");
			try {
				const api = createApi(async () => "indeterminate");
				const response = await api.addProject(null, { path: temp.path });

				expect(response.ok).toBe(false);
				expect(response.requiresGitInitialization).toBeFalsy();
				if (!response.ok) {
					expect(response.error).toMatch(/busy|try again/i);
					expect(response.error).not.toMatch(/initialize/i);
				}
			} finally {
				temp.cleanup();
			}
		});
	});

	it("still offers Git initialization when the probe definitively finds no repository", async () => {
		await withTemporaryHome(async () => {
			const temp = createTempDir("projects-api-add-not-repo-");
			try {
				const api = createApi(async () => "not_repository");
				const response = await api.addProject(null, { path: temp.path });

				expect(response.ok).toBe(false);
				expect(response.requiresGitInitialization).toBe(true);
			} finally {
				temp.cleanup();
			}
		});
	});
});
