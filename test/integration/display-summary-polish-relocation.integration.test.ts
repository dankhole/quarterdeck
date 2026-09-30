import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listProjectIndexEntries, loadSavedProjectStateById } from "../../src/state";
import { generateDisplaySummary } from "../../src/title/summary-generator";
import { polishTaskDisplaySummary, type RuntimeTrpcProjectScope } from "../../src/trpc";
import { createProjectRelocationFixture, deferred } from "../utilities/project-relocation-fixture";

vi.mock("../../src/title/summary-generator", () => ({ generateDisplaySummary: vi.fn() }));

describe("display summary polish relocation admission", { concurrent: false }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it.each(["queued", "generating"] as const)(
		"fences %s polish without reviving the old path or losing session persistence",
		async (timing) => {
			const generating = deferred();
			const finishGeneration = deferred();
			const fixture = await createProjectRelocationFixture();
			const {
				project,
				oldPath,
				registry,
				service,
				oldManager,
				sessionPersistence,
				runProjectOperation,
				readyAfterSuspend,
				suspension,
			} = fixture;
			vi.mocked(generateDisplaySummary).mockImplementation(async () => {
				generating.resolve();
				await finishGeneration.promise;
				return "Late generated summary";
			});
			const getScopedTerminalManager = vi.fn(
				async ({ projectId, projectPath }: RuntimeTrpcProjectScope) =>
					await registry.ensureTerminalManagerForProject(projectId, projectPath),
			);
			const polish = () =>
				polishTaskDisplaySummary({
					projectScope: { projectId: project.projectId, projectPath: oldPath },
					taskId: "task",
					reason: "hook.task_complete",
					deps: { runProjectOperation, config: registry, getScopedTerminalManager },
				}).catch((error: unknown) => error);
			const pending: Promise<unknown>[] = [];
			try {
				let result: Promise<unknown> | undefined;
				if (timing === "generating") {
					result = polish();
					pending.push(result);
					await generating.promise;
				}
				const move = service.renameFolder({
					projectId: project.projectId,
					expectedPath: oldPath,
					folderName: "renamed",
				});
				pending.push(move);
				await suspension.reached;
				if (timing === "queued") {
					result = polish();
					pending.push(result);
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(getScopedTerminalManager).not.toHaveBeenCalled();
				}
				suspension.resume();
				const moved = await move;
				expect(moved.ok).toBe(true);
				finishGeneration.resolve();
				expect(await result).toEqual(new Error("Project folder changed."));
				expect(generateDisplaySummary).toHaveBeenCalledTimes(timing === "queued" ? 0 : 1);
				const entries = await listProjectIndexEntries();
				expect(entries).toHaveLength(1);
				expect(entries[0]).toMatchObject({ projectId: project.projectId, repoPath: moved.project?.path });
				await expect(stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
				const replacement = registry.getTerminalManagerForProject(project.projectId);
				if (!replacement) throw new Error("Relocation did not hydrate a replacement manager.");
				expect(replacement).not.toBe(oldManager);
				expect(readyAfterSuspend).not.toContain(oldManager);
				expect(oldManager.store.getSummary("task")?.displaySummary).not.toBe("Late generated summary");
				expect(replacement.store.getSummary("task")?.displaySummary).not.toBe("Late generated summary");
				// Finish hydration writes first, then test the automatic subscription.
				await sessionPersistence.persistRuntimeSessions(project.projectId);
				replacement.store.update("task", { warningMessage: "Replacement remains durable" });
				await vi.waitFor(async () => {
					expect((await loadSavedProjectStateById(project.projectId))?.sessions.task.warningMessage).toBe(
						"Replacement remains durable",
					);
				});
			} finally {
				finishGeneration.resolve();
				await fixture.cleanup(pending);
			}
		},
	);
});
