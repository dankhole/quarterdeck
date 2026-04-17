// Workspace trust auto-confirm logic for agent sessions.
// Extracted from session-manager.ts — processes PTY output through the trust
// detection pipeline and auto-confirms workspace trust prompts for both
// Claude and Codex agents.

import type { RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger, emitSessionEvent } from "../core";
import { hasClaudeWorkspaceTrustPrompt, WORKSPACE_TRUST_CONFIRM_DELAY_MS } from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt } from "./codex-workspace-trust";
import type { ActiveProcessState } from "./session-manager-types";
import { hasCodexInteractivePrompt, hasCodexStartupUiRendered } from "./session-manager-types";

const sessionLog = createTaggedLogger("session-trust");

export const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
// Maximum number of trust prompts to auto-confirm per session. Covers the CWD
// trust plus any --add-dir directories. Capped to prevent infinite loops if
// the trust prompt pattern matches non-trust output.
export const MAX_AUTO_TRUST_CONFIRMS = 5;

export interface WorkspaceTrustCallbacks {
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => void;
	getActive: (taskId: string) => ActiveProcessState | null;
}

/**
 * Process a chunk of decoded PTY output through the workspace trust detection pipeline.
 * Detects trust prompts for both Claude and Codex and schedules auto-confirm via CR.
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

	const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(active.workspaceTrustBuffer);
	const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
	if (!hasClaudePrompt && !hasCodexPrompt) {
		return;
	}

	active.autoConfirmedWorkspaceTrust = true;
	active.workspaceTrustConfirmCount += 1;
	sessionLog.debug("workspace trust prompt detected, scheduling auto-confirm", {
		taskId,
		confirmCount: active.workspaceTrustConfirmCount,
		maxConfirms: MAX_AUTO_TRUST_CONFIRMS,
		isClaudePrompt: hasClaudePrompt,
		isCodexPrompt: hasCodexPrompt,
	});
	emitSessionEvent(taskId, "trust.detected", {
		isClaudePrompt: hasClaudePrompt,
		isCodexPrompt: hasCodexPrompt,
		confirmCount: active.workspaceTrustConfirmCount,
	});

	active.workspaceTrustConfirmTimer = setTimeout(() => {
		const activeEntry = callbacks.getActive(taskId);
		if (!activeEntry?.autoConfirmedWorkspaceTrust) {
			return;
		}
		activeEntry.session.write("\r");
		emitSessionEvent(taskId, "trust.confirmed", {
			confirmCount: activeEntry.workspaceTrustConfirmCount,
		});
		// Trust text can remain in the rolling buffer after we auto-confirm.
		// Clear it so later startup/prompt checks do not match stale trust output.
		if (activeEntry.workspaceTrustBuffer !== null) {
			activeEntry.workspaceTrustBuffer = "";
		}
		activeEntry.workspaceTrustConfirmTimer = null;
		// Allow subsequent trust prompts (e.g. from --add-dir directories)
		// to be auto-confirmed. Cap at MAX_AUTO_TRUST_CONFIRMS to prevent
		// infinite confirm loops if the pattern matches non-trust output.
		if (activeEntry.workspaceTrustConfirmCount < MAX_AUTO_TRUST_CONFIRMS) {
			activeEntry.autoConfirmedWorkspaceTrust = false;
		} else {
			// Cap reached — disable the buffer entirely to avoid
			// accumulating output that will never be checked.
			activeEntry.workspaceTrustBuffer = null;
			emitSessionEvent(taskId, "trust.cap_reached", {
				confirmCount: activeEntry.workspaceTrustConfirmCount,
			});
			sessionLog.warn("workspace trust auto-confirm cap reached", {
				taskId,
				confirmCount: activeEntry.workspaceTrustConfirmCount,
			});
			callbacks.updateStore(taskId, {
				warningMessage:
					`Auto-confirmed ${MAX_AUTO_TRUST_CONFIRMS} workspace trust prompts ` +
					"but the agent may still be waiting for trust confirmation. " +
					"Try confirming manually in the terminal.",
			});
		}
	}, WORKSPACE_TRUST_CONFIRM_DELAY_MS);
}

/**
 * Attempt to send deferred Codex startup input (e.g. plan-mode key) once the
 * TUI has rendered past the workspace trust prompt.
 */
export function trySendDeferredCodexStartupInput(active: ActiveProcessState): boolean {
	if (active.deferredStartupInput === null) {
		return false;
	}
	const trustPromptVisible =
		active.workspaceTrustBuffer !== null && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
	if (trustPromptVisible) {
		return false;
	}
	const deferredInput = active.deferredStartupInput;
	active.deferredStartupInput = null;
	active.session.write(deferredInput);
	return true;
}

/**
 * Check whether Codex deferred startup input should be sent based on the current output.
 * Returns true if the input was sent.
 */
export function checkAndSendDeferredCodexInput(
	active: ActiveProcessState,
	data: string,
	agentId: string | null | undefined,
): boolean {
	if (agentId !== "codex" || active.deferredStartupInput === null || data.length === 0) {
		return false;
	}
	if (
		hasCodexInteractivePrompt(data) ||
		hasCodexStartupUiRendered(data) ||
		(active.workspaceTrustBuffer !== null &&
			(hasCodexInteractivePrompt(active.workspaceTrustBuffer) ||
				hasCodexStartupUiRendered(active.workspaceTrustBuffer)))
	) {
		return trySendDeferredCodexStartupInput(active);
	}
	return false;
}
