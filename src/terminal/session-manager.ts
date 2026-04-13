// PTY-backed runtime for task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, and shell sessions.
import type { RuntimeTaskImage, RuntimeTaskSessionSummary } from "../core/api-contract";
import { createTaggedLogger } from "../core/debug-logger";
import { emitSessionEvent } from "../core/event-log";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { stripAnsi } from "./output-utils";
import { PtySession } from "./pty-session";
import { isProcessAlive, type ReconciliationAction, reconciliationChecks } from "./session-reconciliation";
import { canReturnToRunning } from "./session-state-machine";
import {
	cloneSummary,
	type SessionSummaryStore,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-summary-store";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";

const sessionLog = createTaggedLogger("session-mgr");

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
// Maximum number of trust prompts to auto-confirm per session. Covers the CWD
// trust plus any --add-dir directories. Capped to prevent infinite loops if
// the trust prompt pattern matches non-trust output.
const MAX_AUTO_TRUST_CONFIRMS = 5;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
const INTERRUPT_RECOVERY_DELAY_MS = 5_000;
const SESSION_RECONCILIATION_INTERVAL_MS = 10_000;
const SIGINT_BYTE = 0x03;
const ESC_BYTE = 0x1b;
// Real Ctrl+C arrives as a 1–3 byte sequence; larger buffers are likely pasted text.
const MAX_SIGINT_DETECT_BUFFER_SIZE = 4;
// TUI apps (Codex) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmCount: number;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	interruptRecoveryTimer: NodeJS.Timeout | null;
}

interface ProcessEntry {
	taskId: string;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	pendingExitResolvers: Array<() => void>;
	hookCount: number;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeConversation?: boolean;
	awaitReview?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	workspacePath?: string;
	statuslineEnabled?: boolean;
	worktreeAddParentRepoDir?: boolean;
	worktreeAddParentGitDir?: boolean;
	worktreeAddQuarterdeckDir?: boolean;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

function now(): number {
	return Date.now();
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "quarterdeck",
	};
}

function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

function clearInterruptRecoveryTimer(active: ActiveProcessState): void {
	if (active.interruptRecoveryTimer) {
		clearTimeout(active.interruptRecoveryTimer);
		active.interruptRecoveryTimer = null;
	}
}

export class TerminalSessionManager implements TerminalSessionService {
	readonly store: SessionSummaryStore;
	private readonly entries = new Map<string, ProcessEntry>();
	private reconciliationTimer: NodeJS.Timeout | null = null;

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
	}

	private trySendDeferredCodexStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		const summary = this.store.getSummary(taskId);
		if (!entry || !active || summary?.agentId !== "codex") {
			return false;
		}
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

	private hasLiveOutputListener(entry: ProcessEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Hydrate both the summary store and the process entry map from a persisted
	 * session record. Called once during workspace bootstrap.
	 */
	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		this.store.hydrateFromRecord(record);
		for (const taskId of Object.keys(record)) {
			if (!this.entries.has(taskId)) {
				this.entries.set(taskId, this.createProcessEntry(taskId));
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

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearInterruptRecoveryTimer(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
			scrollOnEraseInDisplay: false,
		});

		const launch = await prepareAgentLaunch({
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
			worktreeAddParentRepoDir: request.worktreeAddParentRepoDir,
			worktreeAddParentGitDir: request.worktreeAddParentGitDir,
			worktreeAddQuarterdeckDir: request.worktreeAddQuarterdeckDir,
		});

		const env = buildTerminalEnvironment(request.env, launch.env);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
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
			worktreeAddParentRepoDir: request.worktreeAddParentRepoDir ?? false,
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

					const liveSummary = this.store.getSummary(request.taskId);
					const needsDecodedOutput =
						entry.active.workspaceTrustBuffer !== null ||
						(entry.active.detectOutputTransition !== null &&
							liveSummary !== null &&
							(entry.active.shouldInspectOutputForTransition?.(liveSummary) ?? true));
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += data;
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
							const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							if (hasClaudePrompt || hasCodexPrompt) {
								entry.active.autoConfirmedWorkspaceTrust = true;
								entry.active.workspaceTrustConfirmCount += 1;
								sessionLog.debug("workspace trust prompt detected, scheduling auto-confirm", {
									taskId: request.taskId,
									confirmCount: entry.active.workspaceTrustConfirmCount,
									maxConfirms: MAX_AUTO_TRUST_CONFIRMS,
									isClaudePrompt: hasClaudePrompt,
									isCodexPrompt: hasCodexPrompt,
								});
								emitSessionEvent(request.taskId, "trust.detected", {
									isClaudePrompt: hasClaudePrompt,
									isCodexPrompt: hasCodexPrompt,
									confirmCount: entry.active.workspaceTrustConfirmCount,
								});
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
									const activeEntry = this.entries.get(request.taskId)?.active;
									if (!activeEntry?.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									emitSessionEvent(request.taskId, "trust.confirmed", {
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
										emitSessionEvent(request.taskId, "trust.cap_reached", {
											confirmCount: activeEntry.workspaceTrustConfirmCount,
										});
										sessionLog.warn("workspace trust auto-confirm cap reached", {
											taskId: request.taskId,
											confirmCount: activeEntry.workspaceTrustConfirmCount,
										});
										this.store.update(request.taskId, {
											warningMessage:
												`Auto-confirmed ${MAX_AUTO_TRUST_CONFIRMS} workspace trust prompts ` +
												"but the agent may still be waiting for trust confirmation. " +
												"Try confirming manually in the terminal.",
										});
									}
								}, trustConfirmDelayMs);
							}
						}
					}
					this.store.update(request.taskId, { lastOutputAt: now() });

					// Codex plan-mode startup input is deferred until we know the TUI rendered.
					// Trigger on either the interactive prompt marker or the startup header text.
					const agentId = liveSummary?.agentId;
					if (
						agentId === "codex" &&
						entry.active.deferredStartupInput !== null &&
						data.length > 0 &&
						(hasCodexInteractivePrompt(data) ||
							hasCodexStartupUiRendered(data) ||
							(entry.active.workspaceTrustBuffer !== null &&
								(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
									hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))))
					) {
						this.trySendDeferredCodexStartupInput(request.taskId);
					}

					const adapterEvent = liveSummary
						? (entry.active.detectOutputTransition?.(data, liveSummary) ?? null)
						: null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							agentId === "codex" &&
							!entry.active.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							this.applySessionEventWithSideEffects(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && agentId === "codex") {
								entry.active.awaitingCodexPromptAfterEnter = false;
							}
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentSummaryAtExit = this.store.getSummary(request.taskId);
					const exitEventData = {
						exitCode: event.exitCode,
						wasInterrupted: this.entries.get(request.taskId)?.active?.session.wasInterrupted() ?? false,
						trustConfirmCount: this.entries.get(request.taskId)?.active?.workspaceTrustConfirmCount ?? 0,
						timeInState: currentSummaryAtExit?.updatedAt ? Date.now() - currentSummaryAtExit.updatedAt : null,
						timeSinceLastHook: currentSummaryAtExit?.lastHookAt
							? Date.now() - currentSummaryAtExit.lastHookAt
							: null,
					};
					sessionLog.info("task session process exited", {
						taskId: request.taskId,
						exitCode: event.exitCode,
						trustConfirmCount: exitEventData.trustConfirmCount,
					});
					emitSessionEvent(request.taskId, "session.exited", exitEventData);
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearInterruptRecoveryTimer(currentActive);

					const result = this.applySessionEventWithSideEffects(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);
					const exitSummary = result?.summary ?? this.store.getSummary(request.taskId);

					for (const taskListener of currentEntry.listeners.values()) {
						if (exitSummary) {
							taskListener.onState?.(cloneSummary(exitSummary));
						}
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					for (const resolve of currentEntry.pendingExitResolvers) {
						resolve();
					}
					currentEntry.pendingExitResolvers = [];
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
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
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
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
			throw new Error(formatSpawnFailure(commandBinary, error));
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

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: willAutoTrust ? "" : null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: false,
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmCount: 0,
			workspaceTrustConfirmTimer: null,
			interruptRecoveryTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		const summary = this.store.update(request.taskId, {
			state: request.awaitReview ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
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

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearInterruptRecoveryTimer(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
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
					this.store.update(request.taskId, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearInterruptRecoveryTimer(currentActive);

					const summary = this.store.update(request.taskId, {
						state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
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
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmCount: 0,
			workspaceTrustConfirmTimer: null,
			interruptRecoveryTimer: null,
		};
		entry.active = active;
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
			startedAt: now(),
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

		// The session is in an active state (running or awaiting_review) but has
		// no backing process. Two scenarios lead here:
		//
		// 1. The task was launched this server lifetime and the process exited
		//    while no WebSocket listeners were attached (so auto-restart in onExit
		//    was skipped). restartRequest is set — we can attempt a restart now
		//    that a viewer is reconnecting.
		//
		// 2. The entry was hydrated from persisted state after a server restart.
		//    restartRequest is null — we don't have the launch parameters and the
		//    process is genuinely gone. Reset to idle.
		if (entry?.restartRequest?.kind === "task" && !entry.pendingAutoRestart) {
			// Clean exit (code 0) means the agent finished its work — restarting
			// would re-run it from scratch. Keep the state as-is so the user can
			// review the completed work in the terminal.
			if (summary.reviewReason === "exit") {
				return summary;
			}
			// Error exits, stale hook/attention reviews, or running state without a
			// process — attempt restart now that a viewer is reconnecting.
			const updated = this.store.update(taskId, {
				state: "awaiting_review",
				reviewReason: "error",
			});
			this.scheduleAutoRestart(entry);
			return updated;
		}

		// Hydrated entry or shell session — reset to idle.
		return this.store.recoverStaleSession(taskId);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		const summary = this.store.getSummary(taskId);
		if (
			summary?.agentId === "codex" &&
			summary.state === "awaiting_review" &&
			(summary.reviewReason === "hook" ||
				summary.reviewReason === "attention" ||
				summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
			emitSessionEvent(taskId, "writeInput.codex_flag", {
				currentState: summary.state,
				reviewReason: summary.reviewReason,
			});
		}

		// Immediately transition to "running" when the user submits input (CR/LF) while
		// the session is awaiting review. This eliminates the perceptible delay between
		// prompt submission and the agent's hook firing to_in_progress — the card moves
		// as soon as the user hits Enter. The agent's hook will arrive later as a no-op
		// since the state is already "running".
		// Codex is excluded — it uses detectOutputTransition for its own prompt-ready flow.
		if (
			summary?.agentId !== "codex" &&
			summary?.state === "awaiting_review" &&
			canReturnToRunning(summary.reviewReason) &&
			(data.includes(13) || data.includes(10))
		) {
			emitSessionEvent(taskId, "state.transition.optimistic", {
				fromState: summary.state,
				toState: "running",
				reviewReason: summary.reviewReason,
			});
			this.store.transitionToRunning(taskId);
		}

		// Detect user interrupt signals — suppress auto-restart and schedule recovery
		// so that cards don't get stuck in "running" after user interrupts.
		// Ctrl+C (0x03) arrives as 1–3 bytes; Escape (0x1B) as exactly 1 byte
		// (longer buffers starting with 0x1B are ANSI escape sequences, not bare Escape).
		const isCtrlC = data.length <= MAX_SIGINT_DETECT_BUFFER_SIZE && data.includes(SIGINT_BYTE);
		const isBareEscape = data.length === 1 && data[0] === ESC_BYTE;
		if (summary?.state === "running" && (isCtrlC || isBareEscape)) {
			emitSessionEvent(taskId, "writeInput.interrupt", {
				isCtrlC,
				isBareEscape,
				currentState: summary.state,
			});
			entry.suppressAutoRestartOnExit = true;
			this.scheduleInterruptRecovery(entry);
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

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
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
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
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
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return this.store.getSummary(taskId);
	}

	/**
	 * Stop a task session and wait for the process to fully exit before resolving.
	 * Falls back to a timeout so callers are never blocked indefinitely.
	 */
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

	startReconciliation(): void {
		if (this.reconciliationTimer) {
			return;
		}
		this.reconciliationTimer = setInterval(() => {
			this.reconcileSessionStates();
		}, SESSION_RECONCILIATION_INTERVAL_MS);
		this.reconciliationTimer.unref();
	}

	stopReconciliation(): void {
		if (this.reconciliationTimer) {
			clearInterval(this.reconciliationTimer);
			this.reconciliationTimer = null;
		}
	}

	// ── Private helpers ──────────────────────────────────────────────────

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
		// When transitioning back to running, cancel any pending interrupt recovery
		// timer. Without this, a timer from a prior Escape/Ctrl+C can fire after the
		// agent has genuinely resumed work (via hook.to_in_progress or agent.prompt-ready)
		// and incorrectly bounce the session back to awaiting_review/attention.
		if (entry.active && result.patch.state === "running") {
			clearInterruptRecoveryTimer(entry.active);
		}
		if (entry.active && result.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return result;
	}

	private createProcessEntry(taskId: string): ProcessEntry {
		return {
			taskId,
			active: null,
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			pendingExitResolvers: [],
			hookCount: 0,
		};
	}

	private ensureProcessEntry(taskId: string): ProcessEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		this.store.ensureEntry(taskId);
		const created = this.createProcessEntry(taskId);
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: ProcessEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			emitSessionEvent(entry.taskId, "autorestart.rate_limited", {
				timestamps: entry.autoRestartTimestamps,
			});
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: ProcessEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		emitSessionEvent(entry.taskId, "autorestart.triggered", {
			restartCount: entry.autoRestartTimestamps.length,
		});
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				const request = cloneStartTaskSessionRequest(restartRequest.request);
				// Don't carry resumeConversation into auto-restarts. If the original
				// --continue attempt failed (e.g. "No conversation found"), retrying
				// with --continue would just fail again. Start a fresh session instead.
				request.resumeConversation = false;
				request.awaitReview = false;
				await this.startTaskSession(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				emitSessionEvent(entry.taskId, "autorestart.failed", {
					error: message,
				});
				const summary = this.store.update(entry.taskId, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[quarterdeck] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					if (summary) {
						listener.onState?.(cloneSummary(summary));
					}
				}
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private reconcileSessionStates(): void {
		const nowMs = Date.now();
		let sessionsChecked = 0;
		let actionsApplied = 0;
		for (const entry of this.entries.values()) {
			try {
				const summary = this.store.getSummary(entry.taskId);
				if (!summary || (summary.state !== "running" && summary.state !== "awaiting_review")) {
					continue;
				}
				sessionsChecked += 1;

				// Emit health snapshot for every active session.
				const pid = summary.pid;
				emitSessionEvent(entry.taskId, "health.snapshot", {
					state: summary.state,
					reviewReason: summary.reviewReason,
					pid,
					processAlive: pid != null ? isProcessAlive(pid) : false,
					msSinceStart: summary.startedAt != null ? nowMs - summary.startedAt : null,
					msSinceLastOutput: summary.lastOutputAt != null ? nowMs - summary.lastOutputAt : null,
					msSinceLastHook: summary.lastHookAt != null ? nowMs - summary.lastHookAt : null,
					msSinceLastStateChange: nowMs - summary.updatedAt,
					hookCount: entry.hookCount,
					listenerCount: entry.listeners.size,
					autoRestartCount: entry.autoRestartTimestamps.length,
				});

				for (const check of reconciliationChecks) {
					const action = check(
						{
							summary,
							active: entry.active,
							restartRequest: entry.restartRequest,
							pendingAutoRestart: entry.pendingAutoRestart,
						},
						nowMs,
					);
					if (action) {
						emitSessionEvent(entry.taskId, "reconciliation.action", {
							actionType: action.type,
							currentState: summary.state,
							pid: summary.pid,
						});
						this.applyReconciliationAction(entry, action);
						actionsApplied += 1;
						break;
					}
				}
			} catch (err) {
				sessionLog.error(`Reconciliation error for ${entry.taskId}`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (sessionsChecked > 0) {
			emitSessionEvent("_system", "reconciliation.sweep", {
				sessionsChecked,
				actionsApplied,
			});
		}
	}

	private applyReconciliationAction(entry: ProcessEntry, action: ReconciliationAction): void {
		switch (action.type) {
			case "recover_dead_process": {
				if (!entry.active) break;
				stopWorkspaceTrustTimers(entry.active);
				clearInterruptRecoveryTimer(entry.active);
				const cleanupFn = entry.active.onSessionCleanup;
				entry.active.onSessionCleanup = null;
				const result = this.applySessionEventWithSideEffects(entry, {
					type: "process.exit",
					exitCode: null,
					interrupted: false,
				});
				const summary = result?.summary ?? this.store.getSummary(entry.taskId);
				for (const listener of entry.listeners.values()) {
					if (summary) {
						listener.onState?.(cloneSummary(summary));
					}
					listener.onExit?.(null);
				}
				entry.active = null;
				for (const resolve of entry.pendingExitResolvers) {
					resolve();
				}
				entry.pendingExitResolvers = [];
				if (cleanupFn) {
					cleanupFn().catch(() => {});
				}
				break;
			}
			case "mark_processless_error": {
				// Route through the state machine instead of directly mutating the
				// store. process.exit with exitCode=null maps to reviewReason="error",
				// which is the same outcome but validated by the reducer.
				this.applySessionEventWithSideEffects(entry, {
					type: "process.exit",
					exitCode: null,
					interrupted: false,
				});
				break;
			}
			case "clear_hook_activity": {
				this.store.update(entry.taskId, { latestHookActivity: null });
				break;
			}
			case "mark_stalled": {
				this.store.update(entry.taskId, { stalledSince: now() });
				break;
			}
		}
	}

	private scheduleInterruptRecovery(entry: ProcessEntry): void {
		if (!entry.active) {
			return;
		}
		clearInterruptRecoveryTimer(entry.active);
		const taskId = entry.taskId;
		emitSessionEvent(taskId, "interrupt_recovery.scheduled", {});
		entry.active.interruptRecoveryTimer = setTimeout(() => {
			const current = this.entries.get(taskId);
			if (!current?.active) {
				return;
			}
			current.active.interruptRecoveryTimer = null;
			const summary = this.store.getSummary(taskId);
			if (summary?.state !== "running") {
				return;
			}
			emitSessionEvent(taskId, "interrupt_recovery.fired", {
				currentState: summary.state,
			});
			// Always transition — even if the agent produced output after the interrupt
			// (e.g. Claude redraws its prompt after Escape). If the agent is genuinely
			// still working, its next hook will move the card back to running.
			this.applySessionEventWithSideEffects(current, { type: "interrupt.recovery" });
		}, INTERRUPT_RECOVERY_DELAY_MS);
	}
}
