import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeSessionPersistence } from "../../src/server/runtime-session-persistence";
import { loadProjectContext, loadProjectState, ProjectBoardCommandService } from "../../src/state";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../src/terminal";
import { createHooksApi } from "../../src/trpc";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

describe("RuntimeSessionPersistence integration", { concurrent: false }, () => {
	it("durably acknowledges hook receipts and flushes later session changes without a WebSocket hub", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-session-persistence-");
			const previousStateHome = process.env.QUARTERDECK_STATE_HOME;
			process.env.QUARTERDECK_STATE_HOME = join(sandboxRoot, "state");
			let persistence: RuntimeSessionPersistence | undefined;
			try {
				const projectPath = join(sandboxRoot, "project");
				mkdirSync(projectPath);
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const initial = await loadProjectState(projectPath);
				const taskId = "recovered-task";
				const sessionInstanceId = "recovered-process";
				const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
				manager.hydrateFromRecord({
					[taskId]: createTestTaskSessionSummary({
						taskId,
						agentId: "codex",
						sessionInstanceId,
						state: "running",
						pid: 4321,
						startedAt: 100,
						lastProviderHookOccurredAt: 100,
						startupRecoveryRequired: true,
					}),
				});
				const boardCommands = new ProjectBoardCommandService({
					getAuthoritativeSessions: () =>
						Object.fromEntries(manager.store.listSummaries().map((summary) => [summary.taskId, summary])),
				});
				await boardCommands.execute(
					{ projectId: context.projectId, projectPath },
					{
						commandId: "create-recovered-task",
						expectedRevision: initial.revision,
						command: {
							kind: "create_task",
							columnId: "in_progress",
							taskId,
							agentId: "codex",
							prompt: "Synthetic recovered task",
							baseRef: "main",
							createdAt: 100,
						},
					},
				);
				const projects = {
					getProjectPathById: (projectId: string) => (projectId === context.projectId ? projectPath : null),
				};
				persistence = new RuntimeSessionPersistence({ projectRegistry: projects, boardCommands });
				persistence.trackTerminalManager(context.projectId, manager);
				const api = createHooksApi({
					projects,
					terminals: {
						getTerminalManagerForProject: () => manager,
						ensureTerminalManagerForProject: async () => manager,
					},
					persistSessionState: persistence.persistRuntimeSessions,
				});
				const deliveryId = "00000000-0000-4000-8000-000000000001";
				await expect(
					api.ingest({
						taskId,
						projectId: context.projectId,
						event: "to_review",
						metadata: {
							source: "codex",
							hookEventName: "Stop",
							sessionInstanceId,
							turnId: "turn-1",
						},
						delivery: { id: deliveryId, occurredAt: 200 },
					}),
				).resolves.toEqual({ ok: true });

				// Read synchronously at acknowledgement: a later debounce cannot make this pass.
				const acknowledged: unknown = JSON.parse(readFileSync(join(context.statePath, "sessions.json"), "utf8"));
				expect(acknowledged).toMatchObject({
					[taskId]: {
						state: "awaiting_review",
						reviewReason: "hook",
						pid: null,
						startupRecoveryRequired: false,
						recentProviderHookDeliveryIds: [deliveryId],
						recentProviderHookOrderObservations: [
							{ deliveryId, hookEventName: "Stop", sessionInstanceId, turnId: "turn-1", occurredAt: 200 },
						],
					},
				});

				const newest = manager.store.update(taskId, { warningMessage: "Newest shutdown update" });
				await persistence.close();
				const reloaded = await loadProjectState(projectPath);
				expect(reloaded.sessions[taskId]).toMatchObject({
					warningMessage: "Newest shutdown update",
					updatedAt: newest?.updatedAt,
					recentProviderHookDeliveryIds: [deliveryId],
				});
				expect(reloaded.board.columns.find((column) => column.id === "review")?.cards).toEqual([
					expect.objectContaining({ id: taskId }),
				]);
			} finally {
				await persistence?.close();
				if (previousStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
				else process.env.QUARTERDECK_STATE_HOME = previousStateHome;
				cleanup();
			}
		});
	});
});
