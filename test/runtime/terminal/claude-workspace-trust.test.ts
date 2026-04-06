import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { shouldAutoConfirmClaudeWorkspaceTrust } from "../../../src/terminal/claude-workspace-trust";

const originalHome = process.env.HOME;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-claude-workspace-trust-"));
	process.env.HOME = tempHome;
	// Create the worktrees root so isTaskWorktreePath can resolve it.
	mkdirSync(join(tempHome, ".kanban", "worktrees"), { recursive: true });
	return tempHome;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
});

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	it("trusts worktree paths under ~/.kanban/worktrees/", () => {
		const home = setupTempHome();
		const worktreePath = join(home, ".kanban", "worktrees", "task-abc123", "my-repo");
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", worktreePath)).toBe(true);
	});

	it("rejects non-claude agents even for worktree paths", () => {
		const home = setupTempHome();
		const worktreePath = join(home, ".kanban", "worktrees", "task-abc123", "my-repo");
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", worktreePath)).toBe(false);
	});

	it("trusts the main checkout when workspacePath matches cwd", () => {
		setupTempHome();
		const projectPath = "/tmp/my-project";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", projectPath, projectPath)).toBe(true);
	});

	it("trusts the main checkout with path normalization", () => {
		setupTempHome();
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/my-project/.", "/tmp/my-project")).toBe(true);
	});

	it("rejects when cwd does not match workspacePath and is not a worktree", () => {
		setupTempHome();
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/other-dir", "/tmp/my-project")).toBe(false);
	});

	it("rejects when no workspacePath is provided and cwd is not a worktree", () => {
		setupTempHome();
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/some-dir")).toBe(false);
	});

	it("rejects non-claude agents even when workspacePath matches", () => {
		setupTempHome();
		const projectPath = "/tmp/my-project";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", projectPath, projectPath)).toBe(false);
	});
});
