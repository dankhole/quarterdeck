import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core";
import type { ProjectStateConflictError } from "../../src/state";
import {
	getProjectsRootPath,
	listProjectIndexEntries,
	loadProjectContext,
	loadProjectContextById,
	loadProjectState,
	removeProjectIndexEntry,
	saveProjectState,
} from "../../src/state";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		projectPath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

describe.sequential("workspace-state integration", () => {
	it("persists revision numbers and rejects stale writes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-workspace-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const initial = await loadProjectState(projectPath);
				expect(initial.revision).toBe(0);

				const firstSave = await saveProjectState(projectPath, {
					board: createBoard("Task One"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(firstSave.revision).toBe(1);
				expect(firstSave.board.columns[0]?.cards[0]?.prompt).toBe("Task One");

				const secondSave = await saveProjectState(projectPath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: firstSave.revision,
				});
				expect(secondSave.revision).toBe(2);
				expect(secondSave.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");

				await expect(
					saveProjectState(projectPath, {
						board: createBoard("Stale Task"),
						sessions: {},
						expectedRevision: firstSave.revision,
					}),
				).rejects.toMatchObject({
					name: "ProjectStateConflictError",
					currentRevision: secondSave.revision,
				} satisfies Partial<ProjectStateConflictError>);

				const loadedAfterConflict = await loadProjectState(projectPath);
				expect(loadedAfterConflict.revision).toBe(2);
				expect(loadedAfterConflict.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");
			} finally {
				cleanup();
			}
		});
	});

	it("lists and removes workspace index entries across multiple projects", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-workspaces-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const contextA = await loadProjectContext(workspaceAPath);
				const contextB = await loadProjectContext(workspaceBPath);

				const entries = await listProjectIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.projectId).sort()).toEqual(
					[contextA.projectId, contextB.projectId].sort(),
				);

				expect(await loadProjectContextById(contextA.projectId)).not.toBeNull();
				expect(await removeProjectIndexEntry(contextA.projectId)).toBe(true);
				expect(await loadProjectContextById(contextA.projectId)).toBeNull();
				expect(await removeProjectIndexEntry(contextA.projectId)).toBe(false);

				const entriesAfterRemoval = await listProjectIndexEntries();
				expect(entriesAfterRemoval).toHaveLength(1);
				expect(entriesAfterRemoval[0]?.projectId).toBe(contextB.projectId);
			} finally {
				cleanup();
			}
		});
	});

	it("keeps all workspace index entries when projects are added concurrently", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-workspaces-concurrent-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const [contextA, contextB] = await Promise.all([
					loadProjectContext(workspaceAPath),
					loadProjectContext(workspaceBPath),
				]);

				const entries = await listProjectIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.projectId).sort()).toEqual(
					[contextA.projectId, contextB.projectId].sort(),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("creates readable workspace ids from folder names with random suffix on collisions", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-workspace-id-format-");
			try {
				const workspaceAPath = join(sandboxRoot, "one", "vscrui");
				const workspaceBPath = join(sandboxRoot, "two", "vscrui");
				const workspaceCPath = join(sandboxRoot, "three", "My Cool Repo");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				mkdirSync(workspaceCPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);
				initGitRepository(workspaceCPath);

				const contextA = await loadProjectContext(workspaceAPath);
				const contextB = await loadProjectContext(workspaceBPath);
				const contextC = await loadProjectContext(workspaceCPath);

				expect(contextA.projectId).toBe("vscrui");
				expect(contextB.projectId).toMatch(/^vscrui-[a-z0-9]{4}$/);
				expect(contextB.projectId).not.toBe(contextA.projectId);
				expect(contextC.projectId).toBe("my-cool-repo");

				const contextAAgain = await loadProjectContext(workspaceAPath);
				expect(contextAAgain.projectId).toBe(contextA.projectId);
			} finally {
				cleanup();
			}
		});
	});

	it("can require an existing project without auto-creating workspace entries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-workspace-autocreate-");
			try {
				const projectPath = join(sandboxRoot, "gamma");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				await expect(
					loadProjectContext(projectPath, {
						autoCreateIfMissing: false,
					}),
				).rejects.toThrow("is not added to Quarterdeck yet");

				const created = await loadProjectContext(projectPath);
				expect(created.repoPath).toBeTruthy();

				const existing = await loadProjectContext(projectPath, {
					autoCreateIfMissing: false,
				});
				expect(existing.projectId).toBe(created.projectId);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted board data is malformed", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-malformed-board-");
			try {
				const projectPath = join(sandboxRoot, "project-bad-board");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(
						{
							columns: [
								{
									id: "backlog",
									title: "Backlog",
									cards: [
										{
											prompt: "Missing ID and baseRef",
											startInPlanMode: false,
											createdAt: Date.now(),
											updatedAt: Date.now(),
										},
									],
								},
								{ id: "in_progress", title: "In Progress", cards: [] },
								{ id: "review", title: "Review", cards: [] },
								{ id: "trash", title: "Trash", cards: [] },
							],
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadProjectState(projectPath)).rejects.toThrow("board.json");
				await expect(loadProjectState(projectPath)).rejects.toThrow(/id|baseRef/);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted sessions include unknown states", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-malformed-sessions-");
			try {
				const projectPath = join(sandboxRoot, "project-bad-sessions");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(
					join(context.statePath, "sessions.json"),
					JSON.stringify(
						{
							"task-1": {
								...createSessionSummary("task-1"),
								state: "not-a-valid-state",
							},
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadProjectState(projectPath)).rejects.toThrow("sessions.json");
				await expect(loadProjectState(projectPath)).rejects.toThrow("state");
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted workspace index data is malformed", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getProjectsRootPath(), { recursive: true });
			writeFileSync(
				join(getProjectsRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"workspace-a": {
								projectId: "workspace-a",
							},
						},
						repoPathToId: {},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(listProjectIndexEntries()).rejects.toThrow("index.json");
			await expect(listProjectIndexEntries()).rejects.toThrow("repoPath");
		});
	});
});
