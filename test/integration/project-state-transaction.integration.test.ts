import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getTaskColumnId, type RuntimeProjectBoardCommandEnvelope } from "../../src/core";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { ProjectBoardCommandService } from "../../src/state/project-board-command-service";
import {
	loadProjectBoardSnapshotById,
	loadProjectContext,
	loadProjectState,
	saveProjectSessions,
} from "../../src/state/project-state";
import { loadProjectBoardById } from "../../src/state/project-state-index";
import { getProjectStateTransactionPath } from "../../src/state/project-state-transaction";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const move: RuntimeProjectBoardCommandEnvelope = {
	commandId: "start:move",
	expectedRevision: 1,
	command: {
		kind: "move_task",
		taskId: "task-a",
		sourceColumnId: "backlog",
		targetColumnId: "in_progress",
		targetIndex: 0,
		updatedAt: 200,
	},
};

async function withProject(
	run: (fixture: {
		projectPath: string;
		projectId: string;
		statePath: string;
		service: ProjectBoardCommandService;
	}) => Promise<void>,
): Promise<void> {
	const fixture = createTempDir("quarterdeck-state-transaction-");
	vi.stubEnv("QUARTERDECK_STATE_HOME", join(fixture.path, "state"));
	try {
		const projectPath = join(fixture.path, "repo");
		mkdirSync(projectPath);
		initGitRepository(projectPath);
		const context = await loadProjectContext(projectPath);
		const service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
		await service.execute(
			{ projectPath, projectId: context.projectId },
			{
				commandId: "seed",
				expectedRevision: 0,
				command: {
					kind: "create_task",
					taskId: "task-a",
					columnId: "backlog",
					prompt: "Atomic start",
					baseRef: "main",
					createdAt: 100,
				},
			},
		);
		await run({ projectPath, projectId: context.projectId, statePath: context.statePath, service });
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fixture.cleanup();
	}
}

function crashWriter(projectPath: string, statePath: string, boundary: string): void {
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			fileURLToPath(new URL("../fixtures/state/crash-during-project-state-write.ts", import.meta.url)),
			projectPath,
			boundary,
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	expect(child.stderr).toBe("");
	expect(child.signal === "SIGKILL" || (process.platform === "win32" && child.status === 1)).toBe(true);
	// The writer is dead. Age its abandoned lock to exercise normal stale-lock recovery without a 10s wait.
	const stale = new Date(Date.now() - 60_000);
	utimesSync(`${statePath}.lock`, stale, stale);
}

describe("project state transactions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each(["state-transaction.json", "board.json", "sessions.json", "meta.json"])(
		"recovers a process crash after %s with the board, sessions, revision and replay receipt together",
		async (boundary) =>
			await withProject(async ({ projectPath, projectId, statePath, service }) => {
				crashWriter(projectPath, statePath, boundary);
				expect(existsSync(getProjectStateTransactionPath(projectId))).toBe(true);
				const loaded = await loadProjectState(projectPath);
				expect(loaded.revision).toBe(2);
				expect(getTaskColumnId(loaded.board, "task-a")).toBe("in_progress");
				expect(loaded.sessions["task-a"]?.updatedAt).toBe(200);
				expect(existsSync(getProjectStateTransactionPath(projectId))).toBe(false);
				const replay = await service.execute({ projectId, projectPath }, move);
				expect(replay).toMatchObject({
					replayed: true,
					acceptedChange: true,
					changed: false,
					state: { revision: 2 },
				});
				expect(await loadProjectBoardSnapshotById(projectId)).toEqual({ board: loaded.board, revision: 2 });
			}),
	);

	it("leaves the previous state intact if writing the journal fails", async () =>
		await withProject(async (fixture) => {
			const before = await loadProjectState(fixture.projectPath);
			vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockRejectedValueOnce(new Error("disk full"));
			await expect(fixture.service.execute(fixture, move)).rejects.toThrow("disk full");
			expect(await loadProjectState(fixture.projectPath)).toEqual(before);
			expect(existsSync(getProjectStateTransactionPath(fixture.projectId))).toBe(false);
		}));

	it("finishes an interrupted transaction before a sessions-only save", async () =>
		await withProject(async (fixture) => {
			crashWriter(fixture.projectPath, fixture.statePath, "board.json");
			const sessions = { "task-a": createTestTaskSessionSummary({ taskId: "task-a", updatedAt: 300 }) };
			await saveProjectSessions(fixture.projectPath, sessions);
			const loaded = await loadProjectState(fixture.projectPath);
			expect(loaded.revision).toBe(2);
			expect(getTaskColumnId(loaded.board, "task-a")).toBe("in_progress");
			expect(loaded.sessions).toEqual(sessions);
			expect((await fixture.service.execute(fixture, move)).replayed).toBe(true);
		}));

	it("fails closed on an invalid journal instead of exposing partial files", async () =>
		await withProject(async (fixture) => {
			writeFileSync(getProjectStateTransactionPath(fixture.projectId), '{"version":1}');
			await expect(loadProjectState(fixture.projectPath)).rejects.toThrow();
			await expect(loadProjectBoardById(fixture.projectId)).rejects.toThrow();
			await expect(saveProjectSessions(fixture.projectPath, {})).rejects.toThrow();
			expect(JSON.parse(readFileSync(join(fixture.statePath, "meta.json"), "utf8")).revision).toBe(1);
		}));

	it("holds full-state and board-only readers until all files have committed", async () =>
		await withProject(async (fixture) => {
			let releaseWrite!: () => void;
			let reachedPartialWrite!: () => void;
			const paused = new Promise<void>((resolve) => {
				reachedPartialWrite = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			const write = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
			vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, payload, options) => {
				await write(path, payload, options);
				if (path === join(fixture.statePath, "board.json")) {
					reachedPartialWrite();
					await resume;
				}
			});
			const writing = fixture.service.execute(fixture, move);
			await paused;
			let readsFinished = 0;
			const readingState = loadProjectState(fixture.projectPath).then((state) => {
				readsFinished++;
				return state;
			});
			const readingBoard = loadProjectBoardById(fixture.projectId).then((board) => {
				readsFinished++;
				return board;
			});
			const readingSnapshot = loadProjectBoardSnapshotById(fixture.projectId).then((snapshot) => {
				readsFinished++;
				return snapshot;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(readsFinished).toBe(0);
			} finally {
				releaseWrite();
			}
			await writing;
			const [state, board, snapshot] = await Promise.all([readingState, readingBoard, readingSnapshot]);
			expect(state.revision).toBe(2);
			expect(getTaskColumnId(state.board, "task-a")).toBe("in_progress");
			expect(board).toEqual(state.board);
			expect(snapshot).toEqual({ board, revision: 2 });
		}));
});
