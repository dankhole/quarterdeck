import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitRepositoryProbeResult } from "../../../src/projects/git-repository-probe";
import { createProjectRegistry } from "../../../src/server/project-registry";
import { loadProjectContext, loadProjectScopeById } from "../../../src/state";
import { commitAll, initGitRepository } from "../../utilities/git-env";
import { createDefaultMockConfig } from "../../utilities/runtime-config-factory";
import { createTempDir } from "../../utilities/temp-dir";

/**
 * Workstream B: an indeterminate Git probe (load-induced timeout or a blocked
 * launch) must never flip a project's availability by itself. These tests
 * exercise `observeProjectLocation`/`checkProjectAvailability` through a real
 * registry and a temp project index so carry-forward, scope-gating, and index
 * metadata touches are all observed end to end rather than mocked away.
 */
async function createFixture() {
	const temp = createTempDir("project-registry-availability-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(temp.path, "state"));
	const projectPath = join(temp.path, "project");
	await mkdir(projectPath);
	// `loadProjectContext`'s own `git` field population uses a real git process
	// (independent of the injected `probeGitRepository` below, which only drives
	// availability), so this fixture still needs a minimal real repository.
	initGitRepository(projectPath);
	await writeFile(join(projectPath, "README.md"), "Synthetic carry-forward fixture\n");
	commitAll(projectPath, "Create synthetic fixture");
	const project = await loadProjectContext(projectPath);

	let probeResult: GitRepositoryProbeResult = "repository";
	let directoryExists = true;
	const probeGitRepository = vi.fn(async (): Promise<GitRepositoryProbeResult> => probeResult);
	const pathIsDirectory = vi.fn(async (): Promise<boolean> => directoryExists);

	const config = createDefaultMockConfig();
	const registry = await createProjectRegistry({
		cwd: temp.path,
		registerCwdProject: false,
		loadGlobalRuntimeConfig: async () => config,
		loadRuntimeConfig: async () => config,
		probeGitRepository,
		pathIsDirectory,
	});

	return {
		project,
		registry,
		probeGitRepository,
		setProbe: (result: GitRepositoryProbeResult) => {
			probeResult = result;
		},
		setDirectoryExists: (value: boolean) => {
			directoryExists = value;
		},
		cleanup: () => {
			registry.stopMaintenance();
			for (const { terminalManager } of registry.listManagedProjects()) terminalManager.stopReconciliation();
			temp.cleanup();
		},
	};
}

describe("project availability carry-forward across an indeterminate probe", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("keeps available through an indeterminate probe without touching index metadata", async () => {
		const fixture = await createFixture();
		try {
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
			const scopeAfterFirst = await loadProjectScopeById(fixture.project.projectId);

			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
			const scopeAfterSecond = await loadProjectScopeById(fixture.project.projectId);

			expect(scopeAfterSecond?.metadataRevision).toBe(scopeAfterFirst?.metadataRevision);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps unavailable/not_git_repository through an indeterminate probe without touching index metadata again", async () => {
		const fixture = await createFixture();
		try {
			fixture.setProbe("not_repository");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			const scopeAfterFirst = await loadProjectScopeById(fixture.project.projectId);

			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			const scopeAfterSecond = await loadProjectScopeById(fixture.project.projectId);

			expect(scopeAfterSecond?.metadataRevision).toBe(scopeAfterFirst?.metadataRevision);
		} finally {
			fixture.cleanup();
		}
	});

	it("does not carry forward a disproved missing verdict across an indeterminate probe", async () => {
		const fixture = await createFixture();
		const movedAsidePath = `${fixture.project.repoPath}-moved-aside`;
		try {
			// `pathIsDirectory` returning false falls back to a real `stat`, so the
			// directory must actually be gone to get a genuine "missing" verdict.
			await rename(fixture.project.repoPath, movedAsidePath);
			fixture.setDirectoryExists(false);
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "missing",
			});
			const scopeAfterFirst = await loadProjectScopeById(fixture.project.projectId);

			// The directory reappearing disproves "missing", but the probe itself is
			// indeterminate: the stale "missing" verdict must not be reused, and the
			// conservative fallback must not touch metadata a second time.
			await rename(movedAsidePath, fixture.project.repoPath);
			fixture.setDirectoryExists(true);
			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			const scopeAfterSecond = await loadProjectScopeById(fixture.project.projectId);
			expect(scopeAfterSecond?.metadataRevision).toBe(scopeAfterFirst?.metadataRevision);

			fixture.setProbe("repository");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("does not carry forward across a scope change made without rebindProjectLocation", async () => {
		const fixture = await createFixture();
		try {
			// Flip the existing entry to folderOnly (e.g. re-adding an existing path)
			// without ever calling `rebindProjectLocation`, so `observedAvailability`
			// is never cleared for this project.
			await loadProjectContext(fixture.project.repoPath, { folderOnly: true });
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});

			// Flip back to a Git project scope. The "available" verdict above was
			// observed for the folderOnly scope: it must not be treated as evidence
			// for this different scope now that the probe is indeterminate.
			await loadProjectContext(fixture.project.repoPath, { folderOnly: false });
			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("has no previous evidence to carry forward on the very first observation", async () => {
		const fixture = await createFixture();
		try {
			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});

			// Because the conservative fallback above was never stored, the next
			// definitive probe is treated as first evidence rather than a "change".
			fixture.setProbe("repository");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("launch admission always probes fresh and never reuses a cached definitive result", async () => {
		// `assertProjectLaunchAvailable` calls this same `checkProjectAvailability`
		// function with no cache in front of it; a Workstream C optimization layer
		// would be a regression here.
		const fixture = await createFixture();
		try {
			fixture.setProbe("repository");
			fixture.probeGitRepository.mockClear(); // registry construction itself probes once at startup
			await fixture.registry.checkProjectAvailability(fixture.project.projectId);
			await fixture.registry.checkProjectAvailability(fixture.project.projectId);
			expect(fixture.probeGitRepository).toHaveBeenCalledTimes(2);
		} finally {
			fixture.cleanup();
		}
	});

	it("exposes the fresh indeterminate probe to the explicit Check again flow", async () => {
		const fixture = await createFixture();
		try {
			fixture.setProbe("repository");
			await fixture.registry.checkProjectAvailability(fixture.project.projectId);

			fixture.setProbe("indeterminate");
			const detailed = await fixture.registry.checkProjectAvailabilityFreshness(fixture.project.projectId);
			expect(detailed.indeterminate).toBe(true);
			// Carry-forward still applies to the ordinary availability value.
			expect(detailed.availability).toEqual({ status: "available" });
		} finally {
			fixture.cleanup();
		}
	});
});
