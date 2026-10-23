import type * as FsPromises from "node:fs/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createProjectRegistry } from "../../../src/server/project-registry";
import { loadProjectContext } from "../../../src/state";
import {
	getProjectBoardPath,
	getProjectDirectoryLockRequest,
	getProjectDirectoryPath,
	getProjectMetaPath,
} from "../../../src/state/project-state-utils";
import { commitAll, initGitRepository } from "../../utilities/git-env";
import { createDefaultMockConfig } from "../../utilities/runtime-config-factory";
import { createTempDir } from "../../utilities/temp-dir";

const readFileCalls = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
			readFileCalls.paths.push(String(path));
			return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
		}) as typeof actual.readFile,
	};
});

async function createFixture(options: { projectSummaryTimeBoxMs?: number } = {}) {
	const temp = createTempDir("project-registry-summary-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(temp.path, "state"));
	const projectPath = join(temp.path, "project");
	await mkdir(projectPath);
	initGitRepository(projectPath);
	await writeFile(join(projectPath, "README.md"), "Synthetic summary fixture\n");
	commitAll(projectPath, "Create synthetic fixture");
	const project = await loadProjectContext(projectPath);
	const config = createDefaultMockConfig();
	const onDeferredProjectSummaryReady = vi.fn();
	const registry = await createProjectRegistry({
		cwd: temp.path,
		registerCwdProject: false,
		loadGlobalRuntimeConfig: async () => config,
		loadRuntimeConfig: async () => config,
		probeGitRepository: async () => "repository",
		pathIsDirectory: async () => true,
		onDeferredProjectSummaryReady,
		...options,
	});
	return {
		projectId: project.projectId,
		registry,
		onDeferredProjectSummaryReady,
		cleanup: () => {
			registry.stopMaintenance();
			for (const { terminalManager } of registry.listManagedProjects()) terminalManager.stopReconciliation();
			temp.cleanup();
		},
	};
}

/** Another process's commit: meta.json atomically replaced with a newer revision. */
async function advanceRevisionExternally(projectId: string): Promise<void> {
	const metaPath = getProjectMetaPath(projectId);
	const meta = JSON.parse(await readFile(metaPath, "utf8").catch(() => '{"revision":0,"updatedAt":0}')) as {
		revision: number;
	};
	await writeFile(`${metaPath}.external`, JSON.stringify({ ...meta, revision: meta.revision + 1 }), "utf8");
	await rename(`${metaPath}.external`, metaPath);
}

describe("project list summaries", { concurrent: false }, () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("rebuilds an unchanged project's summary without its state lock or a state-file read", async () => {
		const fixture = await createFixture();
		try {
			const first = await fixture.registry.buildProjectsPayload(null);
			const withLock = vi.spyOn(lockedFileSystem, "withLock");
			readFileCalls.paths.length = 0;
			const second = await fixture.registry.buildProjectsPayload(null);
			expect(second.projects).toEqual(first.projects);
			const projectLocks = withLock.mock.calls.filter(
				([request]) => request.path === getProjectDirectoryPath(fixture.projectId),
			);
			expect(projectLocks).toEqual([]);
			const stateFiles = new Set([getProjectBoardPath(fixture.projectId), getProjectMetaPath(fixture.projectId)]);
			expect(readFileCalls.paths.filter((path) => stateFiles.has(path))).toEqual([]);

			await advanceRevisionExternally(fixture.projectId);
			await fixture.registry.buildProjectsPayload(null);
			expect(
				withLock.mock.calls.filter(([request]) => request.path === getProjectDirectoryPath(fixture.projectId))
					.length,
			).toBeGreaterThan(0);
		} finally {
			fixture.cleanup();
		}
	});

	it("serves the previous summary when a project's state lock outlasts the time box", async () => {
		const fixture = await createFixture({ projectSummaryTimeBoxMs: 50 });
		try {
			const first = await fixture.registry.buildProjectsPayload(null);
			const previous = first.projects.find((summary) => summary.id === fixture.projectId);
			expect(previous).toBeDefined();
			await advanceRevisionExternally(fixture.projectId);

			let release = () => {};
			let held = () => {};
			const lockHeld = new Promise<void>((resolve) => {
				held = resolve;
			});
			const holder = lockedFileSystem.withLock(getProjectDirectoryLockRequest(fixture.projectId), async () => {
				held();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			await lockHeld;

			const startedAt = Date.now();
			const blocked = await fixture.registry.buildProjectsPayload(null);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			expect(blocked.projects.find((summary) => summary.id === fixture.projectId)).toBe(previous);
			expect(fixture.onDeferredProjectSummaryReady).not.toHaveBeenCalled();

			release();
			await holder;
			await vi.waitFor(() => expect(fixture.onDeferredProjectSummaryReady).toHaveBeenCalledWith(fixture.projectId));
			const healed = await fixture.registry.buildProjectsPayload(null);
			expect(healed.projects.find((summary) => summary.id === fixture.projectId)).not.toBe(previous);
		} finally {
			fixture.cleanup();
		}
	});
});
