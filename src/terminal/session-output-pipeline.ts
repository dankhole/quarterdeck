// Output processing pipeline for PTY sessions (task and shell).
// Extracted from session-manager.ts — processes each chunk of PTY stdout
// through an ordered pipeline: protocol filter → state mirror →
// trust → transition detection → listener broadcast.

import type { RuntimeTaskSessionSummary } from "../core";
import type { ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";
import {
	beginClaudeWorkspaceTrustOutput,
	beginCodexWorkspaceTrustOutput,
	MAX_WORKSPACE_TRUST_BUFFER_CHARS,
	processClaudeWorkspaceTrustScreen,
	processCodexWorkspaceTrustScreen,
	processWorkspaceTrustOutput,
} from "./session-workspace-trust";
import { disableOscColorQueryIntercept, filterTerminalProtocolOutput } from "./terminal-protocol-filter";
import type { TerminalOutputCursor, TerminalStateMirror } from "./terminal-state-mirror";

const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

/**
 * Broadcasts still queued behind the mirror for render-inspected chunks. While
 * any are pending, later chunks are broadcast through the same FIFO so an
 * inspection predicate flip cannot deliver output to listeners out of order.
 */
const pendingDeferredBroadcasts = new WeakMap<TerminalStateMirror, number>();

export interface OutputPipelineDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	applyTransitionEvent: (
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
		entry.terminalStateMirror?.applyOutput(filteredChunk, undefined, {
			restoreSnapshotSafe: entry.active.terminalProtocolFilter.framing.isSnapshotSafe,
		});
		return;
	}

	// 2. Resolve whether this write needs a rendered-screen inspection. Approval
	//    overlays are terminal UI, so transcript chunks are not lifecycle truth.
	const liveSummary = deps.getSummary(taskId);
	const activeAtWrite = entry.active;
	const codexTrustRevision = beginCodexWorkspaceTrustOutput(activeAtWrite);
	const claudeTrustRevision = beginClaudeWorkspaceTrustOutput(activeAtWrite);
	const inspectRenderedScreen =
		entry.terminalStateMirror !== null &&
		activeAtWrite.detectOutputTransition !== null &&
		liveSummary !== null &&
		(activeAtWrite.shouldInspectOutputForTransition?.(liveSummary) ?? true);
	const mirror = entry.terminalStateMirror;
	const deferBroadcast =
		mirror !== null && (inspectRenderedScreen || (pendingDeferredBroadcasts.get(mirror) ?? 0) > 0);
	const outputListeners = deferBroadcast
		? Array.from(entry.listeners.entries()).filter(([, listener]) => listener.onOutput)
		: [];

	// 3. Terminal state mirror — feed filtered output to the headless xterm.
	//    When inspection is required, transition before the same chunk becomes
	//    visible to listeners so the card cannot briefly claim it is Running.
	//    Claude and modern Codex workspace trust also use the rendered screen.
	let outputCursor: TerminalOutputCursor | null = null;
	let broadcastFromMirror = deferBroadcast;
	if (mirror) {
		if (deferBroadcast) pendingDeferredBroadcasts.set(mirror, (pendingDeferredBroadcasts.get(mirror) ?? 0) + 1);
		outputCursor = mirror.applyOutput(
			filteredChunk,
			deferBroadcast || claudeTrustRevision !== null || codexTrustRevision !== null
				? (screen) => {
						try {
							if (entry.active !== activeAtWrite) {
								return;
							}
							if (claudeTrustRevision !== null) {
								processClaudeWorkspaceTrustScreen(activeAtWrite, taskId, screen, claudeTrustRevision, {
									updateStore: (id, patch) => deps.updateStore(id, patch),
									getActive: (id) => (id === taskId ? entry.active : null),
								});
							}
							if (codexTrustRevision !== null) {
								processCodexWorkspaceTrustScreen(activeAtWrite, taskId, screen, codexTrustRevision, {
									updateStore: (id, patch) => deps.updateStore(id, patch),
									getActive: (id) => (id === taskId ? entry.active : null),
								});
							}
							if (inspectRenderedScreen) {
								const summary = deps.getSummary(taskId);
								if (summary && (activeAtWrite.shouldInspectOutputForTransition?.(summary) ?? true)) {
									const adapterEvent = activeAtWrite.detectOutputTransition?.(screen, summary) ?? null;
									if (adapterEvent) {
										deps.applyTransitionEvent(entry, adapterEvent);
									}
								}
							}
							for (const [listenerId, listener] of outputListeners) {
								if (entry.listeners.get(listenerId) === listener) {
									listener.onOutput?.(filteredChunk, outputCursor);
								}
							}
						} finally {
							if (deferBroadcast) {
								pendingDeferredBroadcasts.set(
									mirror,
									Math.max(0, (pendingDeferredBroadcasts.get(mirror) ?? 1) - 1),
								);
							}
						}
					}
				: undefined,
			{ restoreSnapshotSafe: activeAtWrite.terminalProtocolFilter.framing.isSnapshotSafe },
		);
		if (outputCursor === null && deferBroadcast) {
			// A disposed mirror cannot run its applied callback. Preserve the
			// output as explicitly untracked instead of waiting on that callback.
			pendingDeferredBroadcasts.set(mirror, Math.max(0, (pendingDeferredBroadcasts.get(mirror) ?? 1) - 1));
			broadcastFromMirror = false;
		}
	}

	// 4. Decode only for Codex workspace trust, which still consumes raw output.
	const needsDecodedOutput = entry.active.workspaceTrustBuffer !== null;
	const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

	// 5. Codex workspace trust auto-confirm
	processWorkspaceTrustOutput(entry.active, taskId, data, {
		updateStore: (id, patch) => deps.updateStore(id, patch),
		getActive: (id) => {
			if (id === taskId) {
				return entry.active;
			}
			return null;
		},
	});

	// 6. Listener broadcast. Render-inspected output, and any output queued
	//    behind it, is broadcast from the mirror callback in arrival order after
	//    any state transition has been applied.
	if (!broadcastFromMirror) {
		for (const taskListener of entry.listeners.values()) {
			taskListener.onOutput?.(filteredChunk, outputCursor);
		}
	}
}

/**
 * Process a chunk of shell session PTY output. Simpler than the task pipeline —
 * no transition detection, but shares protocol filtering, state mirror, trust
 * buffering, and listener broadcast.
 */
export function processShellSessionOutput(entry: ProcessEntry, _taskId: string, chunk: Buffer): void {
	if (!entry.active) {
		return;
	}

	const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
		onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
		onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
	});
	if (filteredChunk.byteLength === 0) {
		entry.terminalStateMirror?.applyOutput(filteredChunk, undefined, {
			restoreSnapshotSafe: entry.active.terminalProtocolFilter.framing.isSnapshotSafe,
		});
		return;
	}

	const outputCursor =
		entry.terminalStateMirror?.applyOutput(filteredChunk, undefined, {
			restoreSnapshotSafe: entry.active.terminalProtocolFilter.framing.isSnapshotSafe,
		}) ?? null;

	if (entry.active.workspaceTrustBuffer !== null) {
		entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
		if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
			entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(-MAX_WORKSPACE_TRUST_BUFFER_CHARS);
		}
	}

	for (const taskListener of entry.listeners.values()) {
		taskListener.onOutput?.(filteredChunk, outputCursor);
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
