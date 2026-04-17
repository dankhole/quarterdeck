import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/project-state.js", () => ({
	getTaskWorktreesHomePath: () => "/home/user/.quarterdeck/worktrees",
}));

import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
} from "../../../src/terminal/claude-workspace-trust";

describe("hasClaudeWorkspaceTrustPrompt", () => {
	it("returns true for plain 'Yes, I trust this folder' text", () => {
		expect(hasClaudeWorkspaceTrustPrompt("Yes, I trust this folder")).toBe(true);
	});

	it("returns true for 'trust this folder' shorter variant", () => {
		expect(hasClaudeWorkspaceTrustPrompt("Do you trust this folder?")).toBe(true);
	});

	it("returns true when text has ANSI escape codes around the trust prompt", () => {
		const ansiText = "\u001b[1m\u001b[33mYes, I trust this folder\u001b[0m";
		expect(hasClaudeWorkspaceTrustPrompt(ansiText)).toBe(true);
	});

	it("returns true when trust prompt has extra whitespace", () => {
		const spaceyText = "Yes,  I   trust\n\tthis   folder";
		expect(hasClaudeWorkspaceTrustPrompt(spaceyText)).toBe(true);
	});

	it("returns false for normal agent output", () => {
		expect(hasClaudeWorkspaceTrustPrompt("I'll fix the bug in the main module")).toBe(false);
	});

	it("returns false for partial match like 'I trust this'", () => {
		expect(hasClaudeWorkspaceTrustPrompt("I trust this")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasClaudeWorkspaceTrustPrompt("")).toBe(false);
	});
});

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	it("returns true for claude agent with worktree path", () => {
		const worktreePath = "/home/user/.quarterdeck/worktrees/task-abc123/my-repo";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", worktreePath)).toBe(true);
	});

	it("returns true for claude agent when cwd matches workspacePath", () => {
		const projectPath = "/tmp/my-project";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", projectPath, projectPath)).toBe(true);
	});

	it("returns false for codex agent even with valid worktree path", () => {
		const worktreePath = "/home/user/.quarterdeck/worktrees/task-abc123/my-repo";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", worktreePath)).toBe(false);
	});

	it("returns false for claude agent with non-worktree non-workspace path", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/random-dir")).toBe(false);
	});

	it("returns false for claude agent when cwd does not match workspacePath", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/other-dir", "/tmp/my-project")).toBe(false);
	});

	it("trusts the main checkout with path normalization", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/my-project/.", "/tmp/my-project")).toBe(true);
	});

	it("rejects non-claude agents even when workspacePath matches", () => {
		const projectPath = "/tmp/my-project";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", projectPath, projectPath)).toBe(false);
	});
});
