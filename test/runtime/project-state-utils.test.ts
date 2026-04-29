import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getTaskWorktreesHomePath, isUnderWorktreesHome } from "../../src/state/project-state-utils";
import { createTempDir } from "../utilities/temp-dir";

describe("isUnderWorktreesHome", () => {
	const originalPlatform = process.platform;
	const originalStateHome = process.env.QUARTERDECK_STATE_HOME;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalStateHome === undefined) {
			delete process.env.QUARTERDECK_STATE_HOME;
		} else {
			process.env.QUARTERDECK_STATE_HOME = originalStateHome;
		}
	});

	it("matches the configured worktrees root and descendants only", () => {
		const { path: stateHome, cleanup } = createTempDir("quarterdeck-state-utils-");
		try {
			process.env.QUARTERDECK_STATE_HOME = stateHome;
			const worktreesHome = getTaskWorktreesHomePath();

			expect(isUnderWorktreesHome(worktreesHome)).toBe(true);
			expect(isUnderWorktreesHome(join(worktreesHome, "task-1", "repo"))).toBe(true);
			expect(isUnderWorktreesHome(`${worktreesHome}-sibling`)).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("normalizes Windows separators and drive casing", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.QUARTERDECK_STATE_HOME = "C:\\Users\\Dev\\.quarterdeck";

		expect(isUnderWorktreesHome("c:\\users\\dev\\.quarterdeck\\worktrees\\task-1\\repo")).toBe(true);
		expect(isUnderWorktreesHome("c:\\users\\dev\\.quarterdeck\\worktrees-sibling\\repo")).toBe(false);
	});
});
