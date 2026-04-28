import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
	saveProjectSessions,
	saveProjectState,
} from "../../src/state";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
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
	return createTestTaskSessionSummary({
		taskId,
		state: "idle",
		updatedAt: Date.now(),
	});
}

describe.sequential("project-state integration", () => {
	it("persists revision numbers and rejects stale writes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-project-");
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

	it("persists sessions without rewriting board state or bumping the board revision", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-project-sessions-");
			try {
				const projectPath = join(sandboxRoot, "project-a");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const initial = await loadProjectState(projectPath);
				const saved = await saveProjectState(projectPath, {
					board: createBoard("Task One"),
					sessions: {
						"task-1": createSessionSummary("task-1"),
					},
					expectedRevision: initial.revision,
				});

				await saveProjectSessions(projectPath, {
					"task-1": createTestTaskSessionSummary({
						taskId: "task-1",
						state: "interrupted",
						reviewReason: "interrupted",
						pid: null,
						updatedAt: Date.now(),
					}),
				});

				const loaded = await loadProjectState(projectPath);
				expect(loaded.revision).toBe(saved.revision);
				expect(loaded.board).toEqual(saved.board);
				expect(loaded.sessions["task-1"]?.state).toBe("interrupted");
				expect(loaded.sessions["task-1"]?.reviewReason).toBe("interrupted");
			} finally {
				cleanup();
			}
		});
	});

	it("lists and removes project index entries across multiple projects", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-projects-");
			try {
				const projectAPath = join(sandboxRoot, "alpha");
				const projectBPath = join(sandboxRoot, "beta");
				mkdirSync(projectAPath, { recursive: true });
				mkdirSync(projectBPath, { recursive: true });
				initGitRepository(projectAPath);
				initGitRepository(projectBPath);

				const contextA = await loadProjectContext(projectAPath);
				const contextB = await loadProjectContext(projectBPath);

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

	it("keeps all project index entries when projects are added concurrently", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-projects-concurrent-");
			try {
				const projectAPath = join(sandboxRoot, "alpha");
				const projectBPath = join(sandboxRoot, "beta");
				mkdirSync(projectAPath, { recursive: true });
				mkdirSync(projectBPath, { recursive: true });
				initGitRepository(projectAPath);
				initGitRepository(projectBPath);

				const [contextA, contextB] = await Promise.all([
					loadProjectContext(projectAPath),
					loadProjectContext(projectBPath),
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

	it("creates readable project ids from folder names with random suffix on collisions", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-project-id-format-");
			try {
				const projectAPath = join(sandboxRoot, "one", "vscrui");
				const projectBPath = join(sandboxRoot, "two", "vscrui");
				const projectCPath = join(sandboxRoot, "three", "My Cool Repo");
				mkdirSync(projectAPath, { recursive: true });
				mkdirSync(projectBPath, { recursive: true });
				mkdirSync(projectCPath, { recursive: true });
				initGitRepository(projectAPath);
				initGitRepository(projectBPath);
				initGitRepository(projectCPath);

				const contextA = await loadProjectContext(projectAPath);
				const contextB = await loadProjectContext(projectBPath);
				const contextC = await loadProjectContext(projectCPath);

				expect(contextA.projectId).toBe("vscrui");
				expect(contextB.projectId).toMatch(/^vscrui-[a-z0-9]{4}$/);
				expect(contextB.projectId).not.toBe(contextA.projectId);
				expect(contextC.projectId).toBe("my-cool-repo");

				const contextAAgain = await loadProjectContext(projectAPath);
				expect(contextAAgain.projectId).toBe(contextA.projectId);
			} finally {
				cleanup();
			}
		});
	});

	it("can require an existing project without auto-creating project entries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-project-autocreate-");
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

	it("drops invalid session entries, backs up the original file, and repairs sessions.json", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-malformed-sessions-");
			try {
				const projectPath = join(sandboxRoot, "project-bad-sessions");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				mkdirSync(context.statePath, { recursive: true });
				const sessionsPath = join(context.statePath, "sessions.json");
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(
					sessionsPath,
					JSON.stringify(
						{
							"task-good": createSessionSummary("task-good"),
							"task-bad": {
								...createSessionSummary("task-bad"),
								state: "not-a-valid-state",
							},
						},
						null,
						2,
					),
					"utf8",
				);

				const state = await loadProjectState(projectPath);
				expect(Object.keys(state.sessions)).toEqual(["task-good"]);
				expect(state.warnings).toEqual([
					expect.objectContaining({
						kind: "sessions_corruption",
						droppedCount: 1,
					}),
				]);
				const backupPath = state.warnings?.[0]?.backupPath;
				expect(backupPath).toMatch(/sessions\.json\.corrupt-/);
				if (!backupPath) {
					throw new Error("Expected corrupt sessions backup path.");
				}
				expect(existsSync(backupPath)).toBe(true);
				expect(readFileSync(backupPath, "utf8")).toContain("not-a-valid-state");

				const repairedSessions = JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, unknown>;
				expect(Object.keys(repairedSessions)).toEqual(["task-good"]);

				const loadedAgain = await loadProjectState(projectPath);
				expect(Object.keys(loadedAgain.sessions)).toEqual(["task-good"]);
				expect(loadedAgain.warnings).toEqual(state.warnings);
				const backupFiles = readdirSync(context.statePath).filter((entry) =>
					entry.startsWith("sessions.json.corrupt-"),
				);
				expect(backupFiles).toHaveLength(1);

				await saveProjectState(projectPath, {
					board: loadedAgain.board,
					sessions: loadedAgain.sessions,
					expectedRevision: loadedAgain.revision,
				});
				const loadedAfterSave = await loadProjectState(projectPath);
				expect(loadedAfterSave.warnings).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	});

	it("still throws when sessions.json outer shape is invalid", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-sessions-nonobject-");
			try {
				const projectPath = join(sandboxRoot, "project-non-object-sessions");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const context = await loadProjectContext(projectPath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(join(context.statePath, "sessions.json"), JSON.stringify(["not", "an", "object"]), "utf8");

				await expect(loadProjectState(projectPath)).rejects.toThrow("sessions.json");
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted project index data is malformed", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getProjectsRootPath(), { recursive: true });
			writeFileSync(
				join(getProjectsRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"project-a": {
								projectId: "project-a",
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
