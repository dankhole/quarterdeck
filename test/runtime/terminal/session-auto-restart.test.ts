import { describe, expect, it } from "vitest";

import { shouldAutoRestart } from "../../../src/terminal/session-auto-restart";
import { createProcessEntry } from "../../../src/terminal/session-manager-types";

describe("shouldAutoRestart", () => {
	it("classifies interrupted exits as normal lifecycle cleanup before listener checks", () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};

		expect(shouldAutoRestart(entry, "interrupted")).toEqual({
			restart: false,
			reason: "not_running",
		});
	});

	it("keeps no-listener running exits visible as skipped crash recovery", () => {
		const entry = createProcessEntry("task-1");
		entry.restartRequest = {
			kind: "task",
			request: {
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			},
		};

		expect(shouldAutoRestart(entry, "running")).toEqual({
			restart: false,
			reason: "no_listeners",
		});
	});
});
