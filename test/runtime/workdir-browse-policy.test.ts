import { describe, expect, it } from "vitest";

import {
	isBrowseExcludedChildDirectory,
	isGeneratedWorktreeContainer,
	isWithinGeneratedWorktreeContainer,
	resolveWorkdirBrowseDirectory,
} from "../../src/workdir/workdir-browse-policy";

describe("workdir browse policy", () => {
	it("matches the .claude/worktrees component sequence at any depth, never .claude itself", () => {
		expect(isGeneratedWorktreeContainer(".claude", "worktrees", "linux")).toBe(true);
		expect(isGeneratedWorktreeContainer("repos/child/.claude", "worktrees", "linux")).toBe(true);
		expect(isGeneratedWorktreeContainer("", "worktrees", "linux")).toBe(false);
		expect(isGeneratedWorktreeContainer("claude", "worktrees", "linux")).toBe(false);
		expect(isGeneratedWorktreeContainer("", ".claude", "linux")).toBe(false);
		expect(isWithinGeneratedWorktreeContainer("a/.claude/worktrees/agent-1/src", "linux")).toBe(true);
		expect(isWithinGeneratedWorktreeContainer(".claude/commands", "linux")).toBe(false);
		expect(isWithinGeneratedWorktreeContainer("x.claude/worktrees", "linux")).toBe(false);
		expect(isWithinGeneratedWorktreeContainer(".CLAUDE/Worktrees", "win32")).toBe(true);
		expect(isWithinGeneratedWorktreeContainer(".CLAUDE/Worktrees", "linux")).toBe(false);
	});

	it("reveals generated worktrees on request but never skipped VCS or dependency directories", () => {
		expect(isBrowseExcludedChildDirectory(".claude", "worktrees", { showExcluded: false }, "linux")).toBe(true);
		expect(isBrowseExcludedChildDirectory(".claude", "worktrees", { showExcluded: true }, "linux")).toBe(false);
		for (const name of [".git", "node_modules", ".hg", ".svn"]) {
			expect(isBrowseExcludedChildDirectory("", name, { showExcluded: true }, "linux")).toBe(true);
		}
	});

	it("normalizes requested directories and classifies rejected ones", () => {
		expect(resolveWorkdirBrowseDirectory(undefined, { showExcluded: false }, "linux")).toEqual({
			ok: true,
			directory: "",
		});
		expect(resolveWorkdirBrowseDirectory("src/lib/", { showExcluded: false }, "linux")).toEqual({
			ok: true,
			directory: "src/lib",
		});
		expect(resolveWorkdirBrowseDirectory("src\\lib", { showExcluded: false }, "win32")).toEqual({
			ok: true,
			directory: "src/lib",
		});
		expect(resolveWorkdirBrowseDirectory("../x", { showExcluded: false }, "linux")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(resolveWorkdirBrowseDirectory("/abs", { showExcluded: false }, "linux")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(resolveWorkdirBrowseDirectory("pkg/node_modules/x", { showExcluded: true }, "linux")).toMatchObject({
			ok: false,
			reason: "skipped",
		});
		expect(resolveWorkdirBrowseDirectory(".claude/worktrees", { showExcluded: false }, "linux")).toMatchObject({
			ok: false,
			reason: "generated_worktree",
		});
		expect(resolveWorkdirBrowseDirectory(".claude/worktrees", { showExcluded: true }, "linux")).toEqual({
			ok: true,
			directory: ".claude/worktrees",
		});
	});
});
