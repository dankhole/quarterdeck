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
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						unstarted: true,
						id: "task-1",
						title: null,
						prompt: "Durable task",
						baseRef: "main",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
	};
}

describe("startup session pruning", { concurrent: false }, () => {
	it.each([
		{ name: "prunes PID-free stale sessions before terminal-manager hydration", hasLegacyProcessEvidence: false },
		{ name: "retains legacy PID evidence and refuses startup before pruning", hasLegacyProcessEvidence: true },
	])(
		"$name",
		async ({ hasLegacyProcessEvidence }) => {
			const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-startup-prune-");
			const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-project-startup-prune-");
			const projectPath = join(tempRoot, "project-a");
			let statePath = "";
			try {
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
								pid: hasLegacyProcessEvidence ? 12345 : null,
							}),
							__home_terminal__: createTestTaskSessionSummary({
								taskId: "__home_terminal__",
								state: "running",
								pid: hasLegacyProcessEvidence ? 23456 : null,
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

				const sessionsPath = join(statePath, "sessions.json");
				const boardPath = join(statePath, "board.json");
				const sessionsEvidence = readFileSync(sessionsPath, "utf8");
				const boardEvidence = readFileSync(boardPath, "utf8");
				const port = await getAvailablePort();
				const startup = startQuarterdeckServer({
					cwd: projectPath,
					homeDir: tempHome,
					port,
				});
				if (hasLegacyProcessEvidence) {
					await expect(startup).rejects.toThrow("cannot prove that a prior agent's detached children have exited");
					expect(readFileSync(sessionsPath, "utf8")).toBe(sessionsEvidence);
					expect(readFileSync(boardPath, "utf8")).toBe(boardEvidence);
					return;
				}
				const server = await startup;
				try {
					const sessions = JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, unknown>;
					expect(Object.keys(sessions)).toEqual(["task-1"]);
				} finally {
					await server.stop();
				}
			} finally {
				cleanupRoot();
				cleanupHome();
			}
		},
		30_000,
	);
});
