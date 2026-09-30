import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSavedProjectStateById } from "../../src/state";
import { createProjectRelocationFixture, deferred } from "../utilities/project-relocation-fixture";

describe("project relocation manager admission", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each(["snapshot", "selection", "recovery"] as const)(
		"drains an admitted %s and persists the replacement manager",
		async (entryPoint) => {
			const probeReached = deferred();
			const releaseProbe = deferred();
			const exclusiveRequested = deferred();
			let blockProbe = false;
			let didEnterExclusive = false;
			const fixture = await createProjectRelocationFixture({
				beforeDirectoryProbe: async () => {
					if (blockProbe) {
						blockProbe = false;
						probeReached.resolve();
						await releaseProbe.promise;
					}
				},
				onExclusiveRequested: exclusiveRequested.resolve,
				onExclusiveEntered: () => {
					didEnterExclusive = true;
				},
			});
			const {
				project,
				oldPath,
				registry,
				service,
				boardCommands,
				oldManager,
				sessionPersistence,
				readyAfterSuspend,
				pathIsDirectory,
				getAuthoritativeSessions,
				suspension,
			} = fixture;
			const pending: Promise<unknown>[] = [];
			try {
				blockProbe = true;
				const beforeMove =
					entryPoint === "snapshot"
						? registry.buildProjectStateSnapshot(project.projectId)
						: entryPoint === "selection"
							? registry.setActiveProject(project.projectId)
							: registry.resumeInterruptedSessions(project.projectId, oldPath);
				pending.push(beforeMove);
				await probeReached.promise;
				const move = service.renameFolder({
					projectId: project.projectId,
					expectedPath: oldPath,
					folderName: "renamed",
				});
				pending.push(move);
				await exclusiveRequested.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(didEnterExclusive).toBe(false);
				expect(suspension.entered).toBe(false);
				releaseProbe.resolve();
				await beforeMove;
				await suspension.reached;
				const probeCount = pathIsDirectory.mock.calls.length;
				const queuedSnapshot = registry.buildProjectStateSnapshot(project.projectId);
				const queuedSelection = registry.setActiveProject(project.projectId);
				const queuedRecovery = registry.resumeInterruptedSessions(project.projectId, oldPath);
				const sessionAcquisitionCount = getAuthoritativeSessions.mock.calls.length;
				const scope = { projectId: project.projectId, projectPath: oldPath };
				const lateTitle = boardCommands
					.setGeneratedTaskTitle(scope, "task", 1, "Late title", 2, { expectedTitle: "Keep session history" })
					.catch((error: unknown) => error);
				const lateBaseRef = boardCommands
					.resolveMissingTaskBaseRefs(scope, "main")
					.catch((error: unknown) => error);
				pending.push(queuedSnapshot, queuedSelection, queuedRecovery, lateTitle, lateBaseRef);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(pathIsDirectory).toHaveBeenCalledTimes(probeCount);
				expect(getAuthoritativeSessions).toHaveBeenCalledTimes(sessionAcquisitionCount);
				suspension.resume();
				const result = await move;
				expect(result.ok).toBe(true);
				expect((await queuedSnapshot).repoPath).toBe(result.project?.path);
				await queuedSelection;
				expect(await queuedRecovery).toBe(0);
				expect(await lateTitle).toEqual(new Error("Project folder changed."));
				expect(await lateBaseRef).toEqual(new Error("Project folder changed."));
				expect(registry.getActiveProjectPath()).toBe(result.project?.path);
				const replacement = registry.getTerminalManagerForProject(project.projectId);
				if (!replacement) throw new Error("Relocation did not hydrate a replacement manager.");
				expect(replacement).not.toBe(oldManager);
				expect(readyAfterSuspend).not.toContain(oldManager);
				// Let initial hydration persistence finish before testing the automatic
				// store subscription; an explicit flush would mask a stale subscription.
				await sessionPersistence.persistRuntimeSessions(project.projectId);
				replacement.store.update("task", { warningMessage: "New manager remains durable" });
				await vi.waitFor(async () => {
					const saved = await loadSavedProjectStateById(project.projectId);
					expect(saved?.sessions.task.warningMessage).toBe("New manager remains durable");
				});
			} finally {
				releaseProbe.resolve();
				await fixture.cleanup(pending);
			}
		},
	);
});
