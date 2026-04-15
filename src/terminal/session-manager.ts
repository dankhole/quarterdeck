// PTY-backed runtime for task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, and shell sessions.
//
// Responsibility groups are extracted into focused modules:
//   session-manager-types.ts     — shared types, helpers, factories
//   session-workspace-trust.ts   — workspace trust auto-confirm
//   session-interrupt-recovery.ts — interrupt detection and recovery
//   session-auto-restart.ts      — auto-restart after unexpected exit
//   session-reconciliation-sweep.ts — periodic reconciliation sweep
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { createTaggedLogger } from "../core/debug-logger";
import { emitSessionEvent } from "../core/event-log";
import { cleanStaleIndexLockForWorktree } from "../fs/lock-cleanup";
import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { prepareAgentLaunch } from "./agent-session-adapters";
import { shouldAutoConfirmClaudeWorkspaceTrust, stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { PtySession } from "./pty-session";
// Extracted modules
import { scheduleAutoRestart, shouldAutoRestart } from "./session-auto-restart";
import {
	clearInterruptRecoveryTimer,
	detectInterruptSignal,
	scheduleInterruptRecovery,
} from "./session-interrupt-recovery";
import {
	buildTerminalEnvironment,
	cloneStartShellSessionRequest,
	cloneStartTaskSessionRequest,
	createActiveProcessState,
	createProcessEntry,
	finalizeProcessExit,
	formatSpawnFailure,
	hasLiveOutputListener,
	normalizeDimension,
	type ProcessEntry,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	teardownActiveSession,
} from "./session-manager-types";
import { isPermissionActivity } from "./session-reconciliation";
import { createReconciliationTimer, type ReconciliationTimer } from "./session-reconciliation-sweep";
import {
	cloneSummary,
	type SessionSummaryStore,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-summary-store";
import {
	checkAndSendDeferredCodexInput,
	MAX_WORKSPACE_TRUST_BUFFER_CHARS,
	processWorkspaceTrustOutput,
} from "./session-workspace-trust";
import { disableOscColorQueryIntercept, filterTerminalProtocolOutput } from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";

export type { StartShellSessionRequest, StartTaskSessionRequest };

const sessionLog = createTaggedLogger("session-mgr");

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // [

/**
 * Detects whether a writeInput buffer is entirely a terminal protocol response
 * (not user input). xterm.js sends these automatically through onData — e.g.
 * focus-in/out events when focus reporting is enabled, or DSR cursor position
 * reports. These should not be treated as user interaction.
 *
 * Known sequences:
 *   \x1b[I    — focus-in  (DECSET 1004)
 *   \x1b[O    — focus-out (DECSET 1004)
 *   \x1b[r;cR — DSR cursor position report
 */
function isTerminalProtocolResponse(data: Buffer): boolean {
	if (data.length < 3 || data[0] !== ESC || data[1] !== CSI_BRACKET) {
		return false;
	}
	const finalByte = data[data.length - 1] as number;
	// Focus-in (\x1b[I) and focus-out (\x1b[O) — exactly 3 bytes.
	if (data.length === 3 && (finalByte === 0x49 /* I */ || finalByte === 0x4f) /* O */) {
		return true;
	}
	// DSR cursor position report: \x1b[<digits>;<digits>R
	if (finalByte === 0x52 /* R */) {
		for (let i = 2; i < data.length - 1; i++) {
			const byte = data[i] as number;
			if (byte !== 0x3b /* ; */ && (byte < 0x30 || byte > 0x39) /* 0-9 */) {
				return false;
			}
		}
		return true;
	}
	return false;
}

// TUI apps (Codex) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output,
// synthesize foreground/background color replies, then disable the filter once a
// live terminal listener has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

export class TerminalSessionManager implements TerminalSessionService {
	readonly store: SessionSummaryStore;
	private readonly entries = new Map<string, ProcessEntry>();
	private readonly reconciliation: ReconciliationTimer;

	constructor(store: SessionSummaryStore) {
		this.store = store;
		// Relay store summary changes to per-task terminal listeners.
		// This covers mutations from external callers (hooks-api, runtime-api)
		// that bypass the session manager's own methods.
		this.store.onChange((summary) => {
			const entry = this.entries.get(summary.taskId);
			if (entry?.active) {
				for (const listener of entry.listeners.values()) {
					listener.onState?.(cloneSummary(summary));
				}
			}
		});
		this.reconciliation = createReconciliationTimer({
			entries: this.entries,
			store: this.store,
			applySessionEventWithSideEffects: (entry, event) => this.applySessionEventWithSideEffects(entry, event),
		});
	}

	/**
	 * Hydrate both the summary store and the process entry map from a persisted
	 * session record. Called once during workspace bootstrap.
	 *
	 * Sessions persisted as "running" or "awaiting_review" are processless
	 * survivors — the server died or the workspace was evicted from memory.
	 * Mark them as interrupted so resumeInterruptedSessions can auto-restart
	 * them with --continue when the first viewer connects.
	 */
	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		this.store.hydrateFromRecord(record);
		for (const [taskId, summary] of Object.entries(record)) {
			if (!this.entries.has(taskId)) {
				this.entries.set(taskId, createProcessEntry(taskId));
			}
			if (summary.state === "running" || summary.state === "awaiting_review") {
				this.store.update(taskId, {
					state: "interrupted",
					reviewReason: "interrupted",
					pid: null,
					stalledSince: null,
					latestHookActivity: null,
				});
			}
		}
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureProcessEntry(taskId);

		const summary = this.store.getSummary(taskId);
		if (summary) {
			listener.onState?.(summary);
		}
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		return await entry.terminalStateMirror.getSnapshot();
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		const currentSummary = this.store.getSummary(request.taskId);
		if (
			entry.active &&
			currentSummary &&
			(currentSummary.state === "running" || currentSummary.state === "awaiting_review")
		) {
			return currentSummary;
		}

		teardownActiveSession(entry);
		entry.pendingSessionStart = true;

		const cols = normalizeDimension(request.cols, 120);
		const rows = normalizeDimension(request.rows, 40);
		let terminalStateMirror: TerminalStateMirror;
		let launch: PreparedAgentLaunch;
		try {
			terminalStateMirror = new TerminalStateMirror(cols, rows, {
				onInputResponse: (data) => {
					if (!entry.active || hasLiveOutputListener(entry)) {
						return;
					}
					entry.active.session.write(data);
				},
				scrollback: 3_000,
			});

			launch = await prepareAgentLaunch({
				taskId: request.taskId,
				agentId: request.agentId,
				binary: request.binary,
				args: request.args,
				autonomousModeEnabled: request.autonomousModeEnabled,
				cwd: request.cwd,
				prompt: request.prompt,
				images: request.images,
				startInPlanMode: request.startInPlanMode,
				resumeConversation: request.resumeConversation,
				env: request.env,
				workspaceId: request.workspaceId,
				workspacePath: request.workspacePath,
				statuslineEnabled: request.statuslineEnabled,
				worktreeAddParentGitDir: request.worktreeAddParentGitDir,
				worktreeAddQuarterdeckDir: request.worktreeAddQuarterdeckDir,
				worktreeSystemPromptTemplate: request.worktreeSystemPromptTemplate,
			});
		} catch (error) {
			entry.pendingSessionStart = false;
			throw error;
		}

		const env = buildTerminalEnvironment(request.env, launch.env);
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);

		const willAutoTrust =
			shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd, request.workspacePath) ||
			shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
			hasCodexLaunchSignature;
		const spawnData = {
			agentId: request.agentId,
			binary: commandBinary,
			cwd: request.cwd,
			workspacePath: request.workspacePath ?? null,
			argCount: commandArgs.length,
			willAutoTrust,
			worktreeAddParentGitDir: request.worktreeAddParentGitDir ?? false,
			worktreeAddQuarterdeckDir: request.worktreeAddQuarterdeckDir ?? false,
		};
		sessionLog.info("spawning task session", { taskId: request.taskId, ...spawnData });

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => this.handleTaskSessionOutput(entry, request.taskId, chunk),
				onExit: (event) => this.handleTaskSessionExit(request, event),
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			sessionLog.error("failed to spawn task session", {
				taskId: request.taskId,
				agentId: request.agentId,
				binary: commandBinary,
				error: errorMessage,
			});
			emitSessionEvent(request.taskId, "session.spawn_failed", {
				agentId: request.agentId,
				binary: commandBinary,
				error: errorMessage,
			});
			entry.pendingSessionStart = false;
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {});
			}
			terminalStateMirror.dispose();
			this.store.update(request.taskId, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				stalledSince: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			throw new Error(formatSpawnFailure(commandBinary, error, "task"));
		}

		sessionLog.info("task session spawned successfully", {
			taskId: request.taskId,
			pid: session.pid,
			willAutoTrust,
		});
		emitSessionEvent(request.taskId, "session.started", {
			...spawnData,
			pid: session.pid,
		});

		entry.active = createActiveProcessState({ session, cols, rows, willAutoTrust, launch });
		entry.pendingSessionStart = false;
		entry.terminalStateMirror = terminalStateMirror;

		const summary = this.store.update(request.taskId, {
			state: request.awaitReview ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: Date.now(),
			lastOutputAt: null,
			reviewReason: request.awaitReview ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			stalledSince: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		return summary ?? this.store.ensureEntry(request.taskId);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		const currentSummary = this.store.getSummary(request.taskId);
		if (entry.active && currentSummary?.state === "running") {
			return currentSummary;
		}

		teardownActiveSession(entry);

		const cols = normalizeDimension(request.cols, 120);
		const rows = normalizeDimension(request.rows, 40);
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment(request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
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
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					this.store.update(request.taskId, { lastOutputAt: Date.now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry?.active) {
						return;
					}
					stopWorkspaceTrustTimers(currentEntry.active);
					clearInterruptRecoveryTimer(currentEntry.active);

					const summary = this.store.update(request.taskId, {
						state: currentEntry.active.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentEntry.active.session.wasInterrupted() ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						if (summary) {
							taskListener.onState?.(cloneSummary(summary));
						}
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			this.store.update(request.taskId, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				stalledSince: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			throw new Error(formatSpawnFailure(request.binary, error, "shell"));
		}

		entry.active = createActiveProcessState({ session, cols, rows, willAutoTrust: false });
		entry.terminalStateMirror = terminalStateMirror;

		emitSessionEvent(request.taskId, "session.started.shell", {
			binary: request.binary,
			cwd: request.cwd,
			pid: session.pid,
		});

		const summary = this.store.update(request.taskId, {
			state: "running",
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: Date.now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			stalledSince: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		return summary ?? this.store.ensureEntry(request.taskId);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		const summary = this.store.getSummary(taskId);
		if (!summary) {
			return null;
		}
		if (entry?.active || (summary.state !== "running" && summary.state !== "awaiting_review")) {
			return summary;
		}

		// A session start is already in-flight (awaiting prepareAgentLaunch / PtySession.spawn).
		// Don't clobber the summary — the start will set the correct state when it completes.
		if (entry?.pendingSessionStart) {
			return summary;
		}

		if (entry?.restartRequest?.kind === "task" && !entry.pendingAutoRestart) {
			if (summary.reviewReason === "exit") {
				return summary;
			}
			const updated = this.store.update(taskId, {
				state: "awaiting_review",
				reviewReason: "error",
			});
			scheduleAutoRestart(entry, {
				startTaskSession: (r) => this.startTaskSession(r),
				updateStore: (id, patch) => this.store.update(id, patch),
				applyDenied: () => this.applySessionEventWithSideEffects(entry, { type: "autorestart.denied" }),
			});
			return updated;
		}

		sessionLog.warn("recovering stale session to idle", {
			taskId,
			previousState: summary.state,
			previousReviewReason: summary.reviewReason,
			hasRestartRequest: entry?.restartRequest != null,
			restartRequestKind: entry?.restartRequest?.kind ?? null,
		});
		emitSessionEvent(taskId, "session.recover_to_idle", {
			previousState: summary.state,
			previousReviewReason: summary.reviewReason,
			hasRestartRequest: entry?.restartRequest != null,
			restartRequestKind: entry?.restartRequest?.kind ?? null,
		});
		return this.store.recoverStaleSession(taskId);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		const summary = this.store.getSummary(taskId);

		// Clear permission activity on user input — the user is interacting with
		// the permission prompt (approving/denying). This unblocks the permission-
		// aware transition guard in hooks-api so the next PostToolUse to_in_progress
		// hook can move the task back to running.
		//
		// Guard: skip clearing for terminal protocol responses (focus-in/out events,
		// DSR cursor position reports). xterm.js sends these automatically — e.g.
		// focus-in (\x1b[I) fires when the terminal panel gains DOM focus during
		// task selection. Without this guard, selecting a "Waiting for Approval"
		// card clears the permission metadata and the badge flips to "Ready for
		// review" before the user has interacted with the prompt.
		if (
			summary?.state === "awaiting_review" &&
			summary.latestHookActivity != null &&
			isPermissionActivity(summary.latestHookActivity) &&
			!isTerminalProtocolResponse(data)
		) {
			this.store.update(taskId, { latestHookActivity: null });
		}

		// Codex: flag that we're waiting for a prompt after Enter
		// Only trigger on CR (byte 13 = Enter), not LF (byte 10 = Shift+Enter newline).
		if (
			summary?.agentId === "codex" &&
			summary.state === "awaiting_review" &&
			(summary.reviewReason === "hook" ||
				summary.reviewReason === "attention" ||
				summary.reviewReason === "error") &&
			data.includes(13)
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
			emitSessionEvent(taskId, "writeInput.codex_flag", {
				currentState: summary.state,
				reviewReason: summary.reviewReason,
			});
		}

		// Detect user interrupt signals
		const { isCtrlC, isBareEscape } = detectInterruptSignal(data);
		if (summary?.state === "running" && (isCtrlC || isBareEscape)) {
			emitSessionEvent(taskId, "writeInput.interrupt", {
				isCtrlC,
				isBareEscape,
				currentState: summary.state,
			});
			entry.suppressAutoRestartOnExit = true;
			scheduleInterruptRecovery(entry, {
				getEntry: (id) => this.entries.get(id),
				getSummary: (id) => this.store.getSummary(id),
				applySessionEventWithSideEffects: (e, ev) => this.applySessionEventWithSideEffects(e, ev),
			});
		}

		entry.active.session.write(data);
		return this.store.getSummary(taskId);
	}

	recordHookReceived(taskId: string): void {
		const entry = this.entries.get(taskId);
		if (entry) {
			entry.hookCount += 1;
		}
	}

	resize(
		taskId: string,
		cols: number,
		rows: number,
		pixelWidth?: number,
		pixelHeight?: number,
		force?: boolean,
	): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		const dimensionsUnchanged = safeCols === entry.active.cols && safeRows === entry.active.rows;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		// The kernel only sends SIGWINCH when PTY dimensions actually change.
		// On task switch the viewer sends force:true so TUI agents redraw even
		// when the container happens to be the same size as the PTY.
		if (force && dimensionsUnchanged) {
			entry.active.session.sendSignal("SIGWINCH");
		}
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return this.store.getSummary(taskId);
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {});
		}
		return this.store.getSummary(taskId);
	}

	async stopTaskSessionAndWaitForExit(taskId: string, timeoutMs = 5_000): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return this.store.getSummary(taskId);
		}
		const exitPromise = new Promise<void>((resolve) => {
			entry.pendingExitResolvers.push(resolve);
		});
		this.stopTaskSession(taskId);
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
		await Promise.race([exitPromise, timeout]);
		return this.store.getSummary(taskId);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeTaskIds: string[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.active) {
				continue;
			}
			activeTaskIds.push(entry.taskId);
			stopWorkspaceTrustTimers(entry.active);
			clearInterruptRecoveryTimer(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return this.store.markAllInterrupted(activeTaskIds);
	}

	startReconciliation(repoPath?: string): void {
		this.reconciliation.start(repoPath);
	}

	stopReconciliation(): void {
		this.reconciliation.stop();
	}

	// ── Private helpers ──────────────────────────────────────────────────

	private handleTaskSessionOutput(entry: ProcessEntry, taskId: string, chunk: Buffer): void {
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

		const liveSummary = this.store.getSummary(taskId);
		const needsDecodedOutput =
			entry.active.workspaceTrustBuffer !== null ||
			(entry.active.detectOutputTransition !== null &&
				liveSummary !== null &&
				(entry.active.shouldInspectOutputForTransition?.(liveSummary) ?? true));
		const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

		// Workspace trust auto-confirm
		processWorkspaceTrustOutput(entry.active, taskId, data, {
			updateStore: (id, patch) => this.store.update(id, patch),
			getActive: (id) => this.entries.get(id)?.active ?? null,
		});
		this.store.update(taskId, { lastOutputAt: Date.now() });

		// Codex deferred startup input
		checkAndSendDeferredCodexInput(entry.active, data, liveSummary?.agentId);

		// Agent output transition detection
		const adapterEvent = liveSummary ? (entry.active.detectOutputTransition?.(data, liveSummary) ?? null) : null;
		if (adapterEvent) {
			const requiresEnterForCodex =
				adapterEvent.type === "agent.prompt-ready" &&
				liveSummary?.agentId === "codex" &&
				!entry.active.awaitingCodexPromptAfterEnter;
			if (!requiresEnterForCodex) {
				this.applySessionEventWithSideEffects(entry, adapterEvent);
				if (adapterEvent.type === "agent.prompt-ready" && liveSummary?.agentId === "codex") {
					entry.active.awaitingCodexPromptAfterEnter = false;
				}
			}
		}

		for (const taskListener of entry.listeners.values()) {
			taskListener.onOutput?.(filteredChunk);
		}
	}

	private handleTaskSessionExit(request: StartTaskSessionRequest, event: { exitCode: number | null }): void {
		const currentSummaryAtExit = this.store.getSummary(request.taskId);
		const exitEventData = {
			exitCode: event.exitCode,
			wasInterrupted: this.entries.get(request.taskId)?.active?.session.wasInterrupted() ?? false,
			trustConfirmCount: this.entries.get(request.taskId)?.active?.workspaceTrustConfirmCount ?? 0,
			timeInState: currentSummaryAtExit?.updatedAt ? Date.now() - currentSummaryAtExit.updatedAt : null,
			timeSinceLastHook: currentSummaryAtExit?.lastHookAt ? Date.now() - currentSummaryAtExit.lastHookAt : null,
		};
		sessionLog.info("task session process exited", {
			taskId: request.taskId,
			displaySummary: currentSummaryAtExit?.displaySummary ?? null,
			exitCode: event.exitCode,
			trustConfirmCount: exitEventData.trustConfirmCount,
		});
		emitSessionEvent(request.taskId, "session.exited", exitEventData);

		const currentEntry = this.entries.get(request.taskId);
		if (!currentEntry?.active) {
			return;
		}
		stopWorkspaceTrustTimers(currentEntry.active);
		clearInterruptRecoveryTimer(currentEntry.active);

		const result = this.applySessionEventWithSideEffects(currentEntry, {
			type: "process.exit",
			exitCode: event.exitCode,
			interrupted: currentEntry.active.session.wasInterrupted(),
		});
		const autoRestartDecision = shouldAutoRestart(currentEntry);
		if (!autoRestartDecision.restart) {
			const skipData = {
				taskId: request.taskId,
				displaySummary: currentSummaryAtExit?.displaySummary ?? null,
				reason: autoRestartDecision.reason,
				listenerCount: currentEntry.listeners.size,
				restartRequestKind: currentEntry.restartRequest?.kind ?? null,
				exitCode: event.exitCode,
				exitState: result?.summary?.state ?? null,
				exitReviewReason: result?.summary?.reviewReason ?? null,
			};
			// Intentional suppression (stop/trash) is expected — log at debug, not warn.
			if (autoRestartDecision.reason === "suppressed") {
				sessionLog.debug("auto-restart suppressed on exit", skipData);
			} else {
				sessionLog.warn("auto-restart skipped on exit", skipData);
			}
			emitSessionEvent(request.taskId, "session.autorestart_skipped", skipData);
		}
		const exitSummary = result?.summary ?? this.store.getSummary(request.taskId);
		const cleanupFn = finalizeProcessExit(currentEntry, exitSummary, event.exitCode);

		if (autoRestartDecision.restart) {
			scheduleAutoRestart(currentEntry, {
				startTaskSession: (r) => this.startTaskSession(r),
				updateStore: (id, patch) => this.store.update(id, patch),
				applyDenied: () => this.applySessionEventWithSideEffects(currentEntry, { type: "autorestart.denied" }),
			});
		} else if (exitSummary?.state === "interrupted") {
			// Auto-restart was denied (suppressed, rate-limited, or no listeners).
			// Move to awaiting_review so the card lands in review for the user.
			this.applySessionEventWithSideEffects(currentEntry, { type: "autorestart.denied" });
		}
		if (cleanupFn) {
			cleanupFn().catch(() => {});
		}
		void cleanStaleIndexLockForWorktree(request.cwd).catch(() => {});
	}

	/**
	 * Apply a session state machine event via the store and handle process-side
	 * side effects (clearing attention buffer, resetting codex flags).
	 */
	private applySessionEventWithSideEffects(
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		const beforeSummary = this.store.getSummary(entry.taskId);
		const result = this.store.applySessionEvent(entry.taskId, event);
		if (!result?.changed) {
			if (beforeSummary) {
				emitSessionEvent(entry.taskId, "state.transition.noop", {
					eventType: event.type,
					currentState: beforeSummary.state,
					currentReviewReason: beforeSummary.reviewReason,
				});
			}
			return result;
		}
		emitSessionEvent(entry.taskId, "state.transition", {
			eventType: event.type,
			fromState: beforeSummary?.state ?? null,
			toState: result.patch.state ?? beforeSummary?.state ?? null,
			fromReviewReason: beforeSummary?.reviewReason ?? null,
			toReviewReason: result.patch.reviewReason ?? null,
		});
		if (result.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (entry.active && result.patch.state === "running") {
			clearInterruptRecoveryTimer(entry.active);
		}
		if (entry.active && result.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return result;
	}

	private ensureProcessEntry(taskId: string): ProcessEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		this.store.ensureEntry(taskId);
		const created = createProcessEntry(taskId);
		this.entries.set(taskId, created);
		return created;
	}
}
