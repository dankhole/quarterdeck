import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core";
import { loadProjectContext, loadProjectState, saveProjectState } from "../../src/state";
import { initGitRepository } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: "Durable task",
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

describe.sequential("startup session pruning", () => {
	it("rewrites sessions.json before terminal-manager hydration", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-startup-prune-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-project-startup-prune-");
		const projectPath = join(tempRoot, "project-a");
		let statePath = "";
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		try {
			mkdirSync(projectPath, { recursive: true });
			initGitRepository(projectPath);
			const context = await loadProjectContext(projectPath);
			statePath = context.statePath;
			const initial = await loadProjectState(projectPath);
			await saveProjectState(projectPath, {
				board: createBoard(),
				sessions: {
					"task-1": createTestTaskSessionSummary({ taskId: "task-1" }),
					"deleted-task": createTestTaskSessionSummary({
						taskId: "deleted-task",
						state: "awaiting_review",
						reviewReason: "hook",
						pid: 12345,
					}),
					__home_terminal__: createTestTaskSessionSummary({
						taskId: "__home_terminal__",
						state: "running",
						pid: 23456,
					}),
				},
				expectedRevision: initial.revision,
			});
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
		}

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port,
		});
		try {
			const sessions = JSON.parse(readFileSync(join(statePath, "sessions.json"), "utf8")) as Record<string, unknown>;
			expect(Object.keys(sessions)).toEqual(["task-1"]);
		} finally {
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 30_000);
});
