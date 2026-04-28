// Output processing pipeline for PTY sessions (task and shell).
// Extracted from session-manager.ts — processes each chunk of PTY stdout
// through an ordered pipeline: protocol filter → state mirror →
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

// [perf-investigation] Count PTY output before/after protocol filtering and
// time the synchronous cost of the headless terminal mirror + lastOutputAt
// summary update. This is the server-side source of terminal redraw and summary
// fanout churn. Uses direct console output to avoid feeding Quarterdeck's
// runtime log stream while investigating degraded performance. Remove once the
// idle-agent CPU investigation concludes.
const OUTPUT_REPORT_INTERVAL_MS = 5000;
interface OutputPerfWindow {
	rawChunks: number;
	rawBytes: number;
	filteredChunks: number;
	filteredBytes: number;
	filteredOutChunks: number;
	mirrorApplyCount: number;
	mirrorApplyMs: number;
	mirrorApplyMaxMs: number;
	summaryUpdateCount: number;
	summaryUpdateMs: number;
	summaryUpdateMaxMs: number;
	listenerBroadcasts: number;
	lastKind: "task" | "shell";
	lastTaskId: string;
	startedAt: number;
}

const outputPerfWindow: OutputPerfWindow = {
	rawChunks: 0,
	rawBytes: 0,
	filteredChunks: 0,
	filteredBytes: 0,
	filteredOutChunks: 0,
	mirrorApplyCount: 0,
	mirrorApplyMs: 0,
	mirrorApplyMaxMs: 0,
	summaryUpdateCount: 0,
	summaryUpdateMs: 0,
	summaryUpdateMaxMs: 0,
	listenerBroadcasts: 0,
	lastKind: "task",
	lastTaskId: "",
	startedAt: Date.now(),
};

function roundPerf(value: number): number {
	return Math.round(value * 100) / 100;
}

function maybeReportOutputPerf(kind: "task" | "shell", taskId: string): void {
	const now = Date.now();
	const elapsed = now - outputPerfWindow.startedAt;
	if (elapsed < OUTPUT_REPORT_INTERVAL_MS) {
		return;
	}
	console.warn("[perf-investigation] pty output pipeline rate", {
		windowMs: elapsed,
		rawChunks: outputPerfWindow.rawChunks,
		rawBytes: outputPerfWindow.rawBytes,
		filteredChunks: outputPerfWindow.filteredChunks,
		filteredBytes: outputPerfWindow.filteredBytes,
		filteredOutChunks: outputPerfWindow.filteredOutChunks,
		chunksPerSec: roundPerf((outputPerfWindow.rawChunks / elapsed) * 1000),
		bytesPerSec: Math.round((outputPerfWindow.filteredBytes / elapsed) * 1000),
		mirrorApplyCount: outputPerfWindow.mirrorApplyCount,
		mirrorApplyTotalMs: roundPerf(outputPerfWindow.mirrorApplyMs),
		mirrorApplyMaxMs: roundPerf(outputPerfWindow.mirrorApplyMaxMs),
		summaryUpdateCount: outputPerfWindow.summaryUpdateCount,
		summaryUpdateTotalMs: roundPerf(outputPerfWindow.summaryUpdateMs),
		summaryUpdateMaxMs: roundPerf(outputPerfWindow.summaryUpdateMaxMs),
		listenerBroadcasts: outputPerfWindow.listenerBroadcasts,
		lastKind: kind,
		lastTaskId: taskId,
	});
	outputPerfWindow.rawChunks = 0;
	outputPerfWindow.rawBytes = 0;
	outputPerfWindow.filteredChunks = 0;
	outputPerfWindow.filteredBytes = 0;
	outputPerfWindow.filteredOutChunks = 0;
	outputPerfWindow.mirrorApplyCount = 0;
	outputPerfWindow.mirrorApplyMs = 0;
	outputPerfWindow.mirrorApplyMaxMs = 0;
	outputPerfWindow.summaryUpdateCount = 0;
	outputPerfWindow.summaryUpdateMs = 0;
	outputPerfWindow.summaryUpdateMaxMs = 0;
	outputPerfWindow.listenerBroadcasts = 0;
	outputPerfWindow.lastKind = kind;
	outputPerfWindow.lastTaskId = taskId;
	outputPerfWindow.startedAt = now;
}

function reportRawOutput(kind: "task" | "shell", taskId: string, byteLength: number): void {
	outputPerfWindow.rawChunks += 1;
	outputPerfWindow.rawBytes += byteLength;
	outputPerfWindow.lastKind = kind;
	outputPerfWindow.lastTaskId = taskId;
}

function reportFilteredOutput(kind: "task" | "shell", taskId: string, byteLength: number): void {
	if (byteLength === 0) {
		outputPerfWindow.filteredOutChunks += 1;
		maybeReportOutputPerf(kind, taskId);
		return;
	}
	outputPerfWindow.filteredChunks += 1;
	outputPerfWindow.filteredBytes += byteLength;
}

function reportMirrorApply(elapsedMs: number): void {
	outputPerfWindow.mirrorApplyCount += 1;
	outputPerfWindow.mirrorApplyMs += elapsedMs;
	outputPerfWindow.mirrorApplyMaxMs = Math.max(outputPerfWindow.mirrorApplyMaxMs, elapsedMs);
}

function reportSummaryUpdate(elapsedMs: number): void {
	outputPerfWindow.summaryUpdateCount += 1;
	outputPerfWindow.summaryUpdateMs += elapsedMs;
	outputPerfWindow.summaryUpdateMaxMs = Math.max(outputPerfWindow.summaryUpdateMaxMs, elapsedMs);
}

function reportListenerBroadcasts(count: number): void {
	outputPerfWindow.listenerBroadcasts += count;
}

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
	reportRawOutput("task", taskId, chunk.byteLength);

	// 1. Protocol filter — strip/intercept terminal escape sequences, synthesize
	//    color replies for TUI agents that query before a browser is attached.
	const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
		onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
		onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
	});
	reportFilteredOutput("task", taskId, filteredChunk.byteLength);
	if (filteredChunk.byteLength === 0) {
		return;
	}

	// 2. Terminal state mirror — feed filtered output to the headless xterm
	//    so screen state stays current for restore snapshots.
	if (entry.terminalStateMirror) {
		const mirrorApplyStart = performance.now();
		entry.terminalStateMirror.applyOutput(filteredChunk);
		reportMirrorApply(performance.now() - mirrorApplyStart);
	}

	// 3. Decode to text only when needed — avoid toString("utf8") cost unless
	//    trust or transition detection actually need the text.
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
	const summaryUpdateStart = performance.now();
	deps.updateStore(taskId, { lastOutputAt: Date.now() });
	reportSummaryUpdate(performance.now() - summaryUpdateStart);

	// 6. Codex deferred startup input
	checkAndSendDeferredCodexInput(entry.active, data, liveSummary?.agentId);

	// 7. Agent output transition detection
	const adapterEvent = liveSummary ? (entry.active.detectOutputTransition?.(data, liveSummary) ?? null) : null;
	if (adapterEvent) {
		deps.applyTransitionEvent(entry, adapterEvent);
	}

	// 8. Listener broadcast
	reportListenerBroadcasts(entry.listeners.size);
	for (const taskListener of entry.listeners.values()) {
		taskListener.onOutput?.(filteredChunk);
	}
	maybeReportOutputPerf("task", taskId);
}

/**
 * Process a chunk of shell session PTY output. Simpler than the task pipeline —
 * no transition detection, no Codex deferred input, but shares protocol filtering,
 * state mirror, trust buffering, and listener broadcast.
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
	reportRawOutput("shell", taskId, chunk.byteLength);

	const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
		onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
		onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
	});
	reportFilteredOutput("shell", taskId, filteredChunk.byteLength);
	if (filteredChunk.byteLength === 0) {
		return;
	}

	if (entry.terminalStateMirror) {
		const mirrorApplyStart = performance.now();
		entry.terminalStateMirror.applyOutput(filteredChunk);
		reportMirrorApply(performance.now() - mirrorApplyStart);
	}

	if (entry.active.workspaceTrustBuffer !== null) {
		entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
		if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
			entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(-MAX_WORKSPACE_TRUST_BUFFER_CHARS);
		}
	}

	const summaryUpdateStart = performance.now();
	deps.updateStore(taskId, { lastOutputAt: Date.now() });
	reportSummaryUpdate(performance.now() - summaryUpdateStart);

	reportListenerBroadcasts(entry.listeners.size);
	for (const taskListener of entry.listeners.values()) {
		taskListener.onOutput?.(filteredChunk);
	}
	maybeReportOutputPerf("shell", taskId);
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
