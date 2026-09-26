import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findCardInBoard, type RuntimeTaskLifecycleCommand } from "../../src/core";
import { ProjectTaskLifecycleService } from "../../src/server";
import {
	loadProjectContext,
	loadProjectState,
	ProjectBoardCommandService,
	ProjectTaskLifecycleOperationStore,
} from "../../src/state";
import { getProjectLifecycleOperationsPath } from "../../src/state/project-state-utils";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("legacy Backlog lifecycle recovery", { concurrent: false }, () => {
	it("replays an old start receipt and compensates an interrupted pre-launch move to Unstarted", async () => {
		await withTemporaryHome(async () => {
			const { path: projectPath, cleanup } = createTempDir("quarterdeck-legacy-start-");
			try {
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const boardCommands = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
				const created = await boardCommands.execute(scope, {
					commandId: "create",
					expectedRevision: 0,
					command: {
						kind: "create_task",
						columnId: "review",
						taskId: "task-a",
						prompt: "Test",
						baseRef: "main",
						useWorktree: false,
						createdAt: 100,
					},
				});
				const operationStore = new ProjectTaskLifecycleOperationStore();
				const command: RuntimeTaskLifecycleCommand = {
					kind: "start",
					operationId: "legacy-start",
					expectedRevision: created.state.revision,
					taskId: "task-a",
					taskCreatedAt: 100,
				};
				const begun = await operationStore.begin(scope, command);
				const move = {
					kind: "move_task" as const,
					taskId: "task-a",
					sourceColumnId: "review" as const,
					expectedUnstarted: true,
					targetColumnId: "in_progress" as const,
					targetIndex: 0,
					updatedAt: begun.operation.requestedAt,
				};
				await boardCommands.execute(scope, {
					commandId: "legacy-start:move",
					expectedRevision: created.state.revision,
					command: move,
				});
				const metaPath = join(context.statePath, "meta.json");
				const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
					recentBoardCommands: Array<{ commandId: string; fingerprint: string }>;
				};
				const receipt = meta.recentBoardCommands.find((item) => item.commandId === "legacy-start:move");
				if (!receipt) throw new Error("Missing move receipt");
				receipt.fingerprint = hash([
					{
						kind: "move_task",
						taskId: "task-a",
						sourceColumnId: "backlog",
						targetColumnId: "in_progress",
						targetIndex: 0,
						updatedAt: begun.operation.requestedAt,
					},
				]);
				await writeFile(metaPath, JSON.stringify(meta));
				const journalPath = getProjectLifecycleOperationsPath(scope.projectId);
				const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
					operations: Array<{ sourceColumnId: string }>;
				};
				for (const operation of journal.operations) operation.sourceColumnId = "backlog";
				await writeFile(journalPath, JSON.stringify(journal));
				const startTaskSession = vi.fn();
				const lifecycle = new ProjectTaskLifecycleService({
					boardCommands,
					operationStore,
					startTaskSession,
					stopTaskSession: vi.fn(),
				});
				await lifecycle.recover(scope);
				expect(startTaskSession).not.toHaveBeenCalled();
				expect(findCardInBoard((await loadProjectState(projectPath)).board, "task-a")?.unstarted).toBe(true);
				expect(await operationStore.listActive(scope)).toEqual([]);
			} finally {
				cleanup();
			}
		});
	});

	it("recomputes the identity of migrated legacy Trash commands without leaving them busy", async () => {
		await withTemporaryHome(async () => {
			const { path: projectPath, cleanup } = createTempDir("quarterdeck-legacy-trash-");
			try {
				initGitRepository(projectPath);
				const context = await loadProjectContext(projectPath);
				const scope = { projectId: context.projectId, projectPath };
				const store = new ProjectTaskLifecycleOperationStore();
				const command: RuntimeTaskLifecycleCommand = {
					kind: "trash",
					operationId: "legacy-trash",
					expectedRevision: 0,
					taskId: "task-a",
					taskCreatedAt: 100,
					sourceColumnId: "review",
				};
				const begun = await store.begin(scope, command);
				const legacyCommand = { ...begun.operation.command, sourceColumnId: "backlog" };
				await writeFile(
					getProjectLifecycleOperationsPath(scope.projectId),
					JSON.stringify({
						version: 1,
						operations: [
							{
								...begun.operation,
								command: legacyCommand,
								sourceColumnId: "backlog",
								fingerprint: hash(legacyCommand),
							},
						],
					}),
				);
				expect(await store.begin(scope, command)).toMatchObject({
					replayed: true,
					operation: { command: { sourceColumnId: "review" } },
				});
			} finally {
				cleanup();
			}
		});
	});
});
