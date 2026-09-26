import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/project-state.js", () => ({
	getTaskWorktreesHomePath: () => "/home/user/.quarterdeck/worktrees",
}));

import {
	CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS,
	CLAUDE_WORKSPACE_TRUST_KEY_RESPONSE_TIMEOUT_MS,
	CLAUDE_WORKSPACE_TRUST_KEY_SETTLE_MS,
	createClaudeWorkspaceTrustDriverState,
	decideClaudeWorkspaceTrustAction,
	MAX_CLAUDE_WORKSPACE_TRUST_NAVIGATION_KEYS,
	observeClaudeWorkspaceTrustScreen,
	readClaudeWorkspaceTrustScreen,
	recordClaudeWorkspaceTrustKey,
	shouldAutoConfirmClaudeWorkspaceTrust,
} from "../../../src/terminal/claude-workspace-trust";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-state-mirror";

function screen(lines: string[]): TerminalScreenSnapshot {
	return { lines, cursorRow: 0, cols: 80, rows: lines.length };
}

// Claude Code >= 2.1.283: decline listed first and focused.
const CURRENT_DIALOG_DECLINE_FOCUSED = screen([
	" Accessing workspace:",
	" /tmp/my-project",
	"",
	" \u276f No, exit",
	"   Yes, I trust this folder",
	"",
	" Enter to confirm \u00b7 Esc to cancel",
]);
const CURRENT_DIALOG_CONFIRM_FOCUSED = screen([
	" Accessing workspace:",
	" /tmp/my-project",
	"",
	"   No, exit",
	" \u276f Yes, I trust this folder",
	"",
	" Enter to confirm \u00b7 Esc to cancel",
]);
// Claude Code <= 2.1.224: confirm listed first and focused, with indexes.
const LEGACY_DIALOG = screen([" \u276f 1. Yes, I trust this folder", "   2. No, exit"]);

describe("readClaudeWorkspaceTrustScreen", () => {
	it("reads the focused decline option in the current dialog", () => {
		expect(readClaudeWorkspaceTrustScreen(CURRENT_DIALOG_DECLINE_FOCUSED)).toEqual({
			visible: true,
			selection: "cancel",
		});
	});

	it("reads the focused confirm option in the current and legacy dialogs", () => {
		expect(readClaudeWorkspaceTrustScreen(CURRENT_DIALOG_CONFIRM_FOCUSED)).toEqual({
			visible: true,
			selection: "confirm",
		});
		expect(readClaudeWorkspaceTrustScreen(LEGACY_DIALOG)).toEqual({ visible: true, selection: "confirm" });
	});

	it("recognizes the gated-permissions decline label and ASCII pointers", () => {
		expect(
			readClaudeWorkspaceTrustScreen(
				screen(["> No, continue without these permissions", "  Yes, I trust this folder"]),
			),
		).toEqual({ visible: true, selection: "cancel" });
	});

	it("reports an unknown selection when no option carries the pointer", () => {
		expect(readClaudeWorkspaceTrustScreen(screen(["No, exit", "Yes, I trust this folder"]))).toEqual({
			visible: true,
			selection: null,
		});
	});

	it("ignores ordinary output and a lone trust phrase", () => {
		expect(readClaudeWorkspaceTrustScreen(screen(["I'll fix the bug in the main module"])).visible).toBe(false);
		expect(readClaudeWorkspaceTrustScreen(screen(["\u276f Yes, I trust this folder"])).visible).toBe(false);
	});

	it("ignores option labels that are far apart on screen", () => {
		expect(
			readClaudeWorkspaceTrustScreen(screen(["\u276f Yes, I trust this folder", "", "", "", "", "No, exit"]))
				.visible,
		).toBe(false);
	});

	it("does not treat the settings-trust dialog as folder trust", () => {
		expect(
			readClaudeWorkspaceTrustScreen(screen(["\u276f No, exit Claude Code", "  Yes, I trust these settings"]))
				.visible,
		).toBe(false);
	});
});

describe("Claude workspace trust driver", () => {
	it("waits out Claude's input guard before any key", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_CONFIRM_FOCUSED, 1_000);
		expect(decideClaudeWorkspaceTrustAction(state, 1_000)).toEqual({
			type: "wait",
			until: 1_000 + CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS,
		});
		expect(decideClaudeWorkspaceTrustAction(state, 1_000 + CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS)).toEqual({
			type: "confirm",
		});
	});

	it("moves focus to confirm and only confirms after a frame shows it selected", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_DECLINE_FOCUSED, 0);
		const guardEnd = CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS;
		expect(decideClaudeWorkspaceTrustAction(state, guardEnd)).toEqual({ type: "select_confirm" });
		recordClaudeWorkspaceTrustKey(state, "select_confirm", guardEnd);

		// No frame yet: never act on the stale decline-focused frame.
		expect(decideClaudeWorkspaceTrustAction(state, guardEnd + 1_000).type).toBe("wait");

		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_CONFIRM_FOCUSED, guardEnd + 20);
		expect(decideClaudeWorkspaceTrustAction(state, guardEnd + 20)).toEqual({
			type: "wait",
			until: guardEnd + CLAUDE_WORKSPACE_TRUST_KEY_SETTLE_MS,
		});
		expect(decideClaudeWorkspaceTrustAction(state, guardEnd + CLAUDE_WORKSPACE_TRUST_KEY_SETTLE_MS)).toEqual({
			type: "confirm",
		});
	});

	it("gives up when Claude never re-renders after a key", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_DECLINE_FOCUSED, 0);
		recordClaudeWorkspaceTrustKey(state, "select_confirm", 500);
		expect(decideClaudeWorkspaceTrustAction(state, 500 + CLAUDE_WORKSPACE_TRUST_KEY_RESPONSE_TIMEOUT_MS)).toEqual({
			type: "give_up",
			reason: "no_frame_after_key",
		});
	});

	it("gives up when focus never reaches confirm", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		let now = 0;
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_DECLINE_FOCUSED, now);
		for (let press = 0; press < MAX_CLAUDE_WORKSPACE_TRUST_NAVIGATION_KEYS; press += 1) {
			now += CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS;
			expect(decideClaudeWorkspaceTrustAction(state, now)).toEqual({ type: "select_confirm" });
			recordClaudeWorkspaceTrustKey(state, "select_confirm", now);
			observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_DECLINE_FOCUSED, now + 10);
		}
		now += CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS;
		expect(decideClaudeWorkspaceTrustAction(state, now)).toEqual({
			type: "give_up",
			reason: "confirm_option_unreachable",
		});
	});

	it("does nothing while the selection is unknown or the dialog is hidden", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		expect(decideClaudeWorkspaceTrustAction(state, 0)).toEqual({ type: "idle" });
		observeClaudeWorkspaceTrustScreen(state, screen(["No, exit", "Yes, I trust this folder"]), 0);
		expect(decideClaudeWorkspaceTrustAction(state, 10_000)).toEqual({ type: "idle" });
	});

	it("restarts the guard when the dialog reappears after a confirm", () => {
		const state = createClaudeWorkspaceTrustDriverState();
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_CONFIRM_FOCUSED, 0);
		recordClaudeWorkspaceTrustKey(state, "confirm", 400);
		observeClaudeWorkspaceTrustScreen(state, CURRENT_DIALOG_DECLINE_FOCUSED, 450);
		expect(decideClaudeWorkspaceTrustAction(state, 450)).toEqual({
			type: "wait",
			until: 450 + CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS,
		});
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
