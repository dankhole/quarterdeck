import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRuntimeCapabilities } from "../../../src/core";
import { startRuntime } from "../../../src/server/runtime-bootstrap";
import { type CreateRuntimeServerDependencies, createRuntimeServer } from "../../../src/server/runtime-server";
import { RuntimeSessionPersistence } from "../../../src/server/runtime-session-persistence";
import { loadProjectContext, loadSavedProjectStateById } from "../../../src/state";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { initGitRepository } from "../../utilities/git-env";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";
import { withTemporaryHome } from "../../utilities/temp-dir";

// Keep the real bootstrap, registry, command service and persistence writer. The
// HTTP/process host is unnecessary for this ownership-wiring regression.
vi.mock("../../../src/server/runtime-server", () => ({
	createRuntimeServer: vi.fn(async (deps: CreateRuntimeServerDependencies) => ({
		url: "http://127.0.0.1:3500",
		getQuitSummary: () => ({ liveProcessCount: 0, pendingLaunches: false }),
		prepareForShutdown: async () => {
			deps.projectRegistry.stopMaintenance();
			await deps.projectStatePublications?.close();
		},
		stopTaskOwnersForShutdown: async () => undefined,
		stopPersistenceForShutdown: async () => await deps.runtimeSessionPersistence.stopForShutdown(),
		close: async () => {
			await deps.runtimeStateHub.close();
			await deps.diagnostics.close();
		},
	})),
}));

vi.mock("../../../src/state/state-backup", () => ({
	createBackup: vi.fn(async () => null),
	listBackups: vi.fn(async () => []),
	startPeriodicBackups: vi.fn(),
	stopPeriodicBackups: vi.fn(),
	waitForPendingBackups: vi.fn(async () => undefined),
}));

describe("runtime bootstrap final session persistence", () => {
	it("drains the owned store without reopening the registry readiness writer", async () => {
		await withTemporaryHome(async () => {
			const projectPath = join(process.env.HOME as string, "project");
			await mkdir(projectPath);
			initGitRepository(projectPath);
			const context = await loadProjectContext(projectPath);
			const runtime = await startRuntime({
				cwd: projectPath,
				registerCwdProject: false,
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
				stopOwnedProcesses: async (stopSessions) => {
					stopSessions();
					return { status: "stopped" };
				},
			});
			const dependencies = vi.mocked(createRuntimeServer).mock.calls.at(-1)?.[0];
			if (!dependencies) throw new Error("Runtime server dependencies were not captured.");
			const { projectRegistry, boardCommands, runtimeSessionPersistence: persistence } = dependencies;
			if (!(persistence instanceof RuntimeSessionPersistence))
				throw new Error("Expected the real persistence owner.");
			const tracking = vi.spyOn(persistence, "trackTerminalManager");
			const ensureManager = vi.spyOn(projectRegistry, "ensureTerminalManagerForProject");
			const reconcile = vi.spyOn(boardCommands, "reconcileRuntimeSessions");
			try {
				// No manager was hydrated by the fake HTTP host. A real board command
				// exercises getAuthoritativeSessions -> ensure -> onReady -> track.
				expect(projectRegistry.getTerminalManagerForProject(context.projectId)).toBeNull();
				await boardCommands.execute(
					{ projectId: context.projectId, projectPath },
					{
						commandId: "create-shutdown-task",
						expectedRevision: (await loadSavedProjectStateById(context.projectId))?.revision ?? 0,
						command: {
							kind: "create_task",
							columnId: "in_progress",
							taskId: "shutdown-task",
							agentId: "codex",
							prompt: "Synthetic shutdown fixture",
							baseRef: "main",
							createdAt: 100,
						},
					},
				);
				const manager = projectRegistry.getTerminalManagerForProject(context.projectId);
				if (!manager) throw new Error("Command did not hydrate its session manager.");
				expect(ensureManager).toHaveBeenCalledExactlyOnceWith(context.projectId, projectPath);
				expect(tracking).toHaveBeenCalledExactlyOnceWith(context.projectId, manager);
				manager.store.hydrateFromRecord({
					"shutdown-task": createTestTaskSessionSummary({
						taskId: "shutdown-task",
						state: "awaiting_review",
						reviewReason: "hook",
						pid: null,
					}),
				});
				await persistence.persistRuntimeSessions(context.projectId);
				manager.store.update("shutdown-task", { warningMessage: "Final dirty generation" });
				tracking.mockClear();
				ensureManager.mockClear();
				reconcile.mockClear();

				const draining = persistence.stopForShutdown();
				expect(() => persistence.trackTerminalManager(context.projectId, manager)).toThrow("persistence is closed");
				await expect(persistence.persistRuntimeSessions(context.projectId)).rejects.toThrow(
					"persistence is closed",
				);
				await expect(persistence.awaitRuntimeSessionsDurable(context.projectId)).rejects.toThrow(
					"persistence is closed",
				);
				await expect(draining).resolves.toBeUndefined();
				expect(ensureManager).not.toHaveBeenCalled();
				expect(tracking).toHaveBeenCalledTimes(1); // Only the explicitly rejected late call.
				expect(reconcile).toHaveBeenCalledOnce();
				expect((await loadSavedProjectStateById(context.projectId))?.sessions["shutdown-task"]).toMatchObject({
					warningMessage: "Final dirty generation",
				});

				// The old readiness chain still fails closed: reads must not use it
				// after shutdown, even for the identical manager. New owners fail too.
				await expect(
					projectRegistry.ensureTerminalManagerForProject(context.projectId, projectPath),
				).rejects.toThrow("persistence is closed");
				expect(() =>
					persistence.trackTerminalManager(
						"late-project",
						new TerminalSessionManager(new InMemorySessionSummaryStore()),
					),
				).toThrow("persistence is closed");
				const sessionsBeforeLateChange = await readFile(join(context.statePath, "sessions.json"), "utf8");
				manager.store.update("shutdown-task", { warningMessage: "Late producer must not persist" });
				await new Promise((resolve) => setTimeout(resolve, 150));
				expect(reconcile).toHaveBeenCalledOnce();
				expect(await readFile(join(context.statePath, "sessions.json"), "utf8")).toBe(sessionsBeforeLateChange);
			} finally {
				tracking.mockRestore();
				ensureManager.mockRestore();
				reconcile.mockRestore();
				const shutdown = await runtime.shutdown();
				expect((await shutdown.completion).status).toBe("clean");
			}
		});
	});
});
