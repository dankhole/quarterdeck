import { afterEach, describe, expect, it, vi } from "vitest";

const readGitHeadInfoMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ branch: "feature-branch", headCommit: "abc123", isDetached: false }),
);
vi.mock("../../../src/workspace/git-utils.js", () => ({
	readGitHeadInfo: readGitHeadInfoMock,
}));

import { buildWorktreeContextPrompt } from "../../../src/terminal";

describe("buildWorktreeContextPrompt", () => {
	afterEach(() => {
		readGitHeadInfoMock
			.mockReset()
			.mockResolvedValue({ branch: "feature-branch", headCommit: "abc123", isDetached: false });
	});

	it("returns empty string when cwd equals workspacePath", async () => {
		const result = await buildWorktreeContextPrompt({
			cwd: "/repo",
			workspacePath: "/repo",
		});
		expect(result).toBe("");
	});

	it("returns empty string when workspacePath is undefined", async () => {
		const result = await buildWorktreeContextPrompt({
			cwd: "/some/worktree",
		});
		expect(result).toBe("");
	});

	it("returns context when cwd differs from workspacePath", async () => {
		readGitHeadInfoMock.mockResolvedValue({ branch: "feature", headCommit: "abc", isDetached: false });

		const result = await buildWorktreeContextPrompt({
			cwd: "/worktrees/task-1",
			workspacePath: "/repo",
		});

		expect(result).toContain("You are working in a git worktree.");
		expect(result).toContain("/worktrees/task-1");
		expect(result).toContain("/repo");
		expect(result).toContain("Do not check out branches");
		expect(result).toContain("Do not modify files outside your worktree");
		expect(result).not.toContain("detached HEAD");
	});

	it("includes detached HEAD note when HEAD is detached", async () => {
		readGitHeadInfoMock.mockResolvedValue({ branch: null, headCommit: "abc", isDetached: true });

		const result = await buildWorktreeContextPrompt({
			cwd: "/worktrees/task-2",
			workspacePath: "/repo",
		});

		expect(result).toContain("detached HEAD state");
		expect(result).toContain("feature branch if directed");
	});

	it("handles resolve() normalizing trailing slashes", async () => {
		const result = await buildWorktreeContextPrompt({
			cwd: "/repo/",
			workspacePath: "/repo",
		});
		expect(result).toBe("");
	});

	it("gracefully handles git failure without crashing", async () => {
		readGitHeadInfoMock.mockRejectedValue(new Error("not a git repo"));

		const result = await buildWorktreeContextPrompt({
			cwd: "/worktrees/task-3",
			workspacePath: "/repo",
		});

		expect(result).toContain("You are working in a git worktree.");
		expect(result).not.toContain("detached HEAD");
	});

	it("renders a custom template with placeholders", async () => {
		readGitHeadInfoMock.mockResolvedValue({ branch: "feature", headCommit: "abc", isDetached: false });

		const result = await buildWorktreeContextPrompt({
			cwd: "/worktrees/task-4",
			workspacePath: "/repo",
			template: "CWD={{cwd}} REPO={{workspace_path}} NOTE={{detached_head_note}}",
		});

		expect(result).toBe("CWD=/worktrees/task-4 REPO=/repo NOTE=");
	});

	it("renders detached_head_note placeholder when HEAD is detached", async () => {
		readGitHeadInfoMock.mockResolvedValue({ branch: null, headCommit: "abc", isDetached: true });

		const result = await buildWorktreeContextPrompt({
			cwd: "/worktrees/task-5",
			workspacePath: "/repo",
			template: "Hello{{detached_head_note}}",
		});

		expect(result).toContain("Hello");
		expect(result).toContain("detached HEAD state");
	});

	it("returns empty for custom template when not in a worktree", async () => {
		const result = await buildWorktreeContextPrompt({
			cwd: "/repo",
			workspacePath: "/repo",
			template: "Custom prompt for {{cwd}}",
		});

		expect(result).toBe("");
	});
});
