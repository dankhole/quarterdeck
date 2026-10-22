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
 * An indeterminate observation (a load-induced Git timeout, a blocked launch,
 * or resource pressure on a folder check) must never flip a project's
 * availability by itself. These tests
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
	let directoryError: Error | null = null;
	const probeGitRepository = vi.fn(async (): Promise<GitRepositoryProbeResult> => probeResult);
	const pathIsDirectory = vi.fn(async (): Promise<boolean> => {
		if (directoryError) throw directoryError;
		return directoryExists;
	});

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
		/** Simulates resource pressure on the folder check itself. */
		setDirectoryError: (code: string | null) => {
			directoryError = code ? Object.assign(new Error(code), { code }) : null;
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
			// provisional answer for the accessible folder must not touch metadata.
			await rename(movedAsidePath, fixture.project.repoPath);
			fixture.setDirectoryExists(true);
			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
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
			fixture.setProbe("not_repository");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});

			// Flip the existing entry to folderOnly (e.g. re-adding an existing path)
			// without ever calling `rebindProjectLocation`, so the stored observation
			// is never cleared for this project.
			await loadProjectContext(fixture.project.repoPath, { folderOnly: true });

			// The folder check itself is indeterminate. That would carry forward any
			// verdict for the same scope, but "not a Git repository" was observed for
			// the Git scope and says nothing about this folder-only scope.
			fixture.setDirectoryError("EMFILE");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
			await expect(
				fixture.registry.checkProjectAvailabilityFreshness(fixture.project.projectId),
			).resolves.toMatchObject({ indeterminate: true });
		} finally {
			fixture.cleanup();
		}
	});

	it("carries any scope-matched verdict across an indeterminate folder check", async () => {
		const fixture = await createFixture();
		try {
			fixture.setProbe("not_repository");
			await fixture.registry.checkProjectAvailability(fixture.project.projectId);
			const scopeAfterFirst = await loadProjectScopeById(fixture.project.projectId);

			// Resource pressure on the folder check established nothing about it.
			fixture.setDirectoryError("EMFILE");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			expect((await loadProjectScopeById(fixture.project.projectId))?.metadataRevision).toBe(
				scopeAfterFirst?.metadataRevision,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("reports an accessible, never-observed folder as provisionally available without recording it", async () => {
		const fixture = await createFixture();
		try {
			const scopeBefore = await loadProjectScopeById(fixture.project.projectId);
			fixture.setProbe("indeterminate");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "available",
			});
			expect((await loadProjectScopeById(fixture.project.projectId))?.metadataRevision).toBe(
				scopeBefore?.metadataRevision,
			);

			// The provisional answer was never stored, so the next definite probe is
			// first evidence: an unavailable verdict is recorded as a change.
			fixture.setProbe("not_repository");
			await expect(fixture.registry.checkProjectAvailability(fixture.project.projectId)).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			expect((await loadProjectScopeById(fixture.project.projectId))?.metadataRevision).toBe(
				(scopeBefore?.metadataRevision ?? 0) + 1,
			);
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
