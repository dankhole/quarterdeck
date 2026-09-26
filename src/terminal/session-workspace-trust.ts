// Workspace trust auto-confirm logic for agent sessions.
// Extracted from session-manager.ts — Codex trust is detected in raw PTY
// output; Claude trust is driven from the rendered screen because Claude's
// select focus and input guard decide what a keypress means.

import type { RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger } from "../core";
import {
	CLAUDE_WORKSPACE_TRUST_NEXT_OPTION_KEY,
	decideClaudeWorkspaceTrustAction,
	observeClaudeWorkspaceTrustScreen,
	recordClaudeWorkspaceTrustKey,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt } from "./codex-workspace-trust";
import type { ActiveProcessState } from "./session-manager-types";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

const sessionLog = createTaggedLogger("session-trust");

export const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
// Maximum number of trust prompts to auto-confirm per session. Some CLIs can
// prompt more than once while resolving launch context. Cap confirmations to
// prevent infinite loops if the pattern matches non-trust output.
export const MAX_AUTO_TRUST_CONFIRMS = 5;

export interface WorkspaceTrustCallbacks {
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => void;
	getActive: (taskId: string) => ActiveProcessState | null;
}

const TRUST_CAP_WARNING =
	`Auto-confirmed ${MAX_AUTO_TRUST_CONFIRMS} workspace trust prompts ` +
	"but the agent may still be waiting for trust confirmation. " +
	"Try confirming manually in the terminal.";

/**
 * Process a chunk of decoded PTY output through the Codex workspace trust
 * detection pipeline and schedule auto-confirm via CR.
 */
export function processWorkspaceTrustOutput(
	active: ActiveProcessState,
	taskId: string,
	data: string,
	callbacks: WorkspaceTrustCallbacks,
): void {
	if (active.workspaceTrustBuffer === null) {
		return;
	}

	active.workspaceTrustBuffer += data;
	if (active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
		active.workspaceTrustBuffer = active.workspaceTrustBuffer.slice(-MAX_WORKSPACE_TRUST_BUFFER_CHARS);
	}

	if (active.autoConfirmedWorkspaceTrust || active.workspaceTrustConfirmTimer !== null) {
		return;
	}

	if (!hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer)) {
		return;
	}

	active.autoConfirmedWorkspaceTrust = true;
	active.workspaceTrustConfirmCount += 1;
	sessionLog.debug("workspace trust prompt detected, scheduling auto-confirm", {
		taskId,
		confirmCount: active.workspaceTrustConfirmCount,
		maxConfirms: MAX_AUTO_TRUST_CONFIRMS,
	});

	active.workspaceTrustConfirmTimer = setTimeout(() => {
		const activeEntry = callbacks.getActive(taskId);
		if (!activeEntry?.autoConfirmedWorkspaceTrust) {
			return;
		}
		activeEntry.session.write("\r");
		// Trust text can remain in the rolling buffer after we auto-confirm.
		// Clear it so later startup/prompt checks do not match stale trust output.
		if (activeEntry.workspaceTrustBuffer !== null) {
			activeEntry.workspaceTrustBuffer = "";
		}
		activeEntry.workspaceTrustConfirmTimer = null;
		// Allow subsequent trust prompts to be auto-confirmed. Cap at
		// MAX_AUTO_TRUST_CONFIRMS to prevent infinite confirm loops if the
		// pattern matches non-trust output.
		if (activeEntry.workspaceTrustConfirmCount < MAX_AUTO_TRUST_CONFIRMS) {
			activeEntry.autoConfirmedWorkspaceTrust = false;
		} else {
			// Cap reached — disable the buffer entirely to avoid
			// accumulating output that will never be checked.
			activeEntry.workspaceTrustBuffer = null;
			sessionLog.warn("workspace trust auto-confirm cap reached", {
				taskId,
				confirmCount: activeEntry.workspaceTrustConfirmCount,
			});
			callbacks.updateStore(taskId, { warningMessage: TRUST_CAP_WARNING });
		}
	}, WORKSPACE_TRUST_CONFIRM_DELAY_MS);
}

/**
 * Observe a rendered screen for Claude's workspace trust dialog and advance
 * the confirmation driver. Keys are written only after Claude's input guard
 * and only once the rendered selection says what the key will do.
 */
export function processClaudeWorkspaceTrustScreen(
	active: ActiveProcessState,
	taskId: string,
	screen: TerminalScreenSnapshot,
	callbacks: WorkspaceTrustCallbacks,
): void {
	if (!active.claudeWorkspaceTrust) {
		return;
	}
	observeClaudeWorkspaceTrustScreen(active.claudeWorkspaceTrust, screen, Date.now());
	advanceClaudeWorkspaceTrust(active, taskId, callbacks);
}

function advanceClaudeWorkspaceTrust(
	active: ActiveProcessState,
	taskId: string,
	callbacks: WorkspaceTrustCallbacks,
): void {
	const state = active.claudeWorkspaceTrust;
	if (!state || callbacks.getActive(taskId) !== active) {
		return;
	}
	stopWorkspaceTrustTimers(active);
	const now = Date.now();
	const action = decideClaudeWorkspaceTrustAction(state, now);
	switch (action.type) {
		case "idle":
			return;
		case "wait":
			active.workspaceTrustConfirmTimer = setTimeout(() => {
				active.workspaceTrustConfirmTimer = null;
				advanceClaudeWorkspaceTrust(active, taskId, callbacks);
			}, action.until - now);
			return;
		case "select_confirm":
			sessionLog.debug("claude workspace trust dialog focused on decline, selecting confirm", {
				taskId,
				navigationKeyCount: state.navigationKeyCount,
			});
			active.session.write(CLAUDE_WORKSPACE_TRUST_NEXT_OPTION_KEY);
			recordClaudeWorkspaceTrustKey(state, "select_confirm", now);
			advanceClaudeWorkspaceTrust(active, taskId, callbacks);
			return;
		case "confirm":
			active.session.write("\r");
			recordClaudeWorkspaceTrustKey(state, "confirm", now);
			active.workspaceTrustConfirmCount += 1;
			sessionLog.debug("claude workspace trust confirmed", {
				taskId,
				confirmCount: active.workspaceTrustConfirmCount,
				maxConfirms: MAX_AUTO_TRUST_CONFIRMS,
			});
			if (active.workspaceTrustConfirmCount >= MAX_AUTO_TRUST_CONFIRMS) {
				active.claudeWorkspaceTrust = null;
				sessionLog.warn("workspace trust auto-confirm cap reached", {
					taskId,
					confirmCount: active.workspaceTrustConfirmCount,
				});
				callbacks.updateStore(taskId, { warningMessage: TRUST_CAP_WARNING });
			}
			return;
		case "give_up":
			active.claudeWorkspaceTrust = null;
			sessionLog.warn("claude workspace trust auto-confirm abandoned", { taskId, reason: action.reason });
			callbacks.updateStore(taskId, {
				warningMessage:
					"Quarterdeck could not confirm Claude's workspace trust prompt automatically. " +
					'Select "Yes, I trust this folder" in the terminal.',
			});
			return;
	}
}
