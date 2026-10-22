import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findCardInBoard } from "../../../src/core";
import { loadProjectBoardById } from "../../../src/state/project-state-index";
import { getProjectBoardPath } from "../../../src/state/project-state-utils";
import { createTempDir } from "../../utilities/temp-dir";

describe("persisted Claude task options", () => {
	const fixtures: Array<() => void> = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const cleanup of fixtures.splice(0)) cleanup();
	});

	it("loads a board whose Claude effort level is unknown to this runtime", async () => {
		const fixture = createTempDir("quarterdeck-claude-options-");
		fixtures.push(fixture.cleanup);
		vi.stubEnv("QUARTERDECK_STATE_HOME", join(fixture.path, "state"));
		const boardPath = getProjectBoardPath("project-1");
		mkdirSync(dirname(boardPath), { recursive: true });
		const card = (id: string, claudeOptions?: Record<string, string>) => ({
			id,
			title: null,
			prompt: id,
			baseRef: "main",
			agentId: "claude",
			...(claudeOptions ? { claudeOptions } : {}),
			colorIndex: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		writeFileSync(
			boardPath,
			JSON.stringify({
				columns: [
					{ id: "in_progress", title: "In Progress", cards: [] },
					{
						id: "review",
						title: "Review",
						cards: [card("future", { model: "opus", effort: "future_level" }), card("plain")],
					},
					{ id: "trash", title: "Trash", cards: [] },
				],
			}),
		);

		const board = await loadProjectBoardById("project-1");

		expect(findCardInBoard(board, "future")?.claudeOptions).toEqual({ model: "opus", effort: "future_level" });
		expect(findCardInBoard(board, "plain")).not.toBeNull();
	});
});
