// Output processing pipeline for PTY sessions (task and shell).
// Extracted from session-manager.ts — processes each chunk of PTY stdout
// through an ordered pipeline: protocol filter → state mirror → workspace
// trust → store timestamp → codex deferred input → transition detection →
// listener broadcast.

import type { RuntimeTaskSessionSummary } from "../core";
import type { ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";
import {
	checkAndSendDeferredCodexInput,
	MAX_WORKSPACE_TRUST_BUFFER_CHARS,
	processWorkspaceTrustOutput,
} from "./session-workspace-trust";
import { disableOscColorQueryIntercept, filterTerminalProtocolOutput } from "./terminal-protocol-filter";

const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

export interface OutputPipelineDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	applySessionEventWithSideEffects: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

/**
 * Process a chunk of task session PTY output through the full pipeline.
 * Each stage may short-circuit (empty chunk from protocol filter) or trigger
 * side effects (state transitions from agent output detection).
 */
export function processTaskSessionOutput(
	entry: ProcessEntry,
	taskId: string,
	chunk: Buffer,
	deps: OutputPipelineDeps,
): void {
	if (!entry.active) {
		return;
	}

	// 1. Protocol filter — strip/intercept terminal escape sequences, synthesize
	//    color replies for TUI agents that query before a browser is attached.
	const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
		onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
		onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
	});
	if (filteredChunk.byteLength === 0) {
		return;
	}

	// 2. Terminal state mirror — feed filtered output to the headless xterm
	//    so screen state stays current for restore snapshots.
	entry.terminalStateMirror?.applyOutput(filteredChunk);

	// 3. Decode to text only when needed — avoid toString("utf8") cost unless
	//    workspace trust or transition detection actually need the text.
	const liveSummary = deps.getSummary(taskId);
	const needsDecodedOutput =
		entry.active.workspaceTrustBuffer !== null ||
		(entry.active.detectOutputTransition !== null &&
			liveSummary !== null &&
			(entry.active.shouldInspectOutputForTransition?.(liveSummary) ?? true));
	const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

	// 4. Workspace trust auto-confirm
	processWorkspaceTrustOutput(entry.active, taskId, data, {
		updateStore: (id, patch) => deps.updateStore(id, patch),
		getActive: (id) => {
			if (id === taskId) {
				return entry.active;
			}
			return null;
		},
	});

	// 5. Store timestamp
	deps.updateStore(taskId, { lastOutputAt: Date.now() });

	// 6. Codex deferred startup input
	checkAndSendDeferredCodexInput(entry.active, data, liveSummary?.agentId);

	// 7. Agent output transition detection
	const adapterEvent = liveSummary ? (entry.active.detectOutputTransition?.(data, liveSummary) ?? null) : null;
	if (adapterEvent) {
		const requiresEnterForCodex =
			adapterEvent.type === "agent.prompt-ready" &&
			liveSummary?.agentId === "codex" &&
			!entry.active.awaitingCodexPromptAfterEnter;
		if (!requiresEnterForCodex) {
			deps.applySessionEventWithSideEffects(entry, adapterEvent);
			if (adapterEvent.type === "agent.prompt-ready" && liveSummary?.agentId === "codex") {
				entry.active.awaitingCodexPromptAfterEnter = false;
			}
		}
	}

	// 8. Listener broadcast
	for (const taskListener of entry.listeners.values()) {
		taskListener.onOutput?.(filteredChunk);
	}
}

/**
 * Process a chunk of shell session PTY output. Simpler than the task pipeline —
 * no transition detection, no Codex deferred input, but shares protocol filtering,
 * state mirror, workspace trust buffering, and listener broadcast.
 */
export function processShellSessionOutput(
	entry: ProcessEntry,
	taskId: string,
	chunk: Buffer,
	deps: Pick<OutputPipelineDeps, "updateStore">,
): void {
	if (!entry.active) {
		return;
	}

	const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
		onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
		onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
	});
	if (filteredChunk.byteLength === 0) {
		return;
	}

	entry.terminalStateMirror?.applyOutput(filteredChunk);

	if (entry.active.workspaceTrustBuffer !== null) {
		entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
		if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
			entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(-MAX_WORKSPACE_TRUST_BUFFER_CHARS);
		}
	}

	deps.updateStore(taskId, { lastOutputAt: Date.now() });

	for (const taskListener of entry.listeners.values()) {
		taskListener.onOutput?.(filteredChunk);
	}
}

/**
 * Disable the OSC color query interceptor for a session entry. Called when
 * the first live output listener attaches (a browser terminal that can
 * answer OSC queries itself).
 */
export function disableOutputOscIntercept(entry: ProcessEntry): void {
	if (entry.active) {
		disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
	}
}
