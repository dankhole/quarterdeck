import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import {
	CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
	CLAUDE_STRUCTURED_CLI_VERSION,
	CODEX_APP_SERVER_SCHEMA_FINGERPRINT,
	type CodexAppServerTransport,
	CodexStructuredOwnerRegistry,
	fingerprintClaudeProfileRoot,
	fingerprintCodexProfileRoot,
	type StartStructuredOwnerInput,
	type StructuredOwner,
	type StructuredOwnerEvents,
	type StructuredOwnerRegistryContract,
	type TaskExecutionOwnership,
	TaskExecutionOwnershipService,
} from "../../../src/execution";
import type { PreparedTaskSessionStart } from "../../../src/server/task-session-start-service";
import { ProjectExecutionOwnershipStore } from "../../../src/state";
import {
	InMemorySessionSummaryStore,
	type StartTaskSessionRequest,
	type TerminalSessionManager,
} from "../../../src/terminal";
import type { TaskSessionLaunchReadinessOutcome } from "../../../src/terminal/session-launch-readiness";
import type { NativeTaskSessionProcessIdentity } from "../../../src/terminal/session-manager-types";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";
import { createTempDir } from "../../utilities/temp-dir";

class ProtocolTransport implements CodexAppServerTransport {
	readonly pid: number;
	readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly exitListeners = new Set<
		(event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
	>();
	private exited = false;
	private heldInitializeRequestId: number | null = null;
	private interruptFails = false;

	constructor(
		pid: number,
		private readonly codexHome: string,
		private readonly cwd: string,
		private readonly configReasoningEffort = "high",
		private readonly holdInitialize = false,
		private readonly delayExitEvent = false,
		private stopConfirmed = true,
		private readonly holdTurnStart = false,
	) {
		this.pid = pid;
	}

	write(message: unknown): void {
		const request = message as { id?: number; method?: string; params?: Record<string, unknown> };
		if (request.id === undefined || !request.method) return;
		this.requests.push({ id: request.id, method: request.method, params: request.params ?? {} });
		if (request.method === "initialize" && this.holdInitialize) {
			this.heldInitializeRequestId = request.id;
			return;
		}
		queueMicrotask(() => this.respond(request.id as number, request.method as string));
	}

	onMessage(listener: (message: unknown) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onExit(listener: (event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	requestStop(): void {
		if (this.exited) return;
		this.exited = true;
		if (!this.delayExitEvent) this.emitExit();
	}

	crash(): void {
		if (this.exited) return;
		this.exited = true;
		this.emitExit();
	}

	async waitForExit(): Promise<boolean> {
		return this.exited && this.stopConfirmed;
	}

	setStopConfirmed(stopConfirmed: boolean): void {
		this.stopConfirmed = stopConfirmed;
	}

	setInterruptFails(interruptFails: boolean): void {
		this.interruptFails = interruptFails;
	}

	releaseInitialize(): void {
		if (this.heldInitializeRequestId === null) return;
		this.respond(this.heldInitializeRequestId, "initialize");
		this.heldInitializeRequestId = null;
	}

	releaseExit(): void {
		if (this.exited) this.emitExit();
	}

	emitServerMessage(message: unknown): void {
		this.emit(message);
	}

	private emitExit(): void {
		for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
	}

	private emit(message: unknown): void {
		for (const listener of this.messageListeners) listener(message);
	}

	private respond(id: number, method: string): void {
		if (method === "initialize") {
			this.emit({
				id,
				result: {
					userAgent: "codex/0.149.1",
					codexHome: this.codexHome,
					platformFamily: "unix",
					platformOs: "macos",
				},
			});
			return;
		}
		if (method === "config/read") {
			this.emit({
				id,
				result: { config: { model_reasoning_effort: this.configReasoningEffort }, origins: {}, layers: [] },
			});
			return;
		}
		if (method === "thread/resume") {
			this.emit({ id, result: this.resumeResponse() });
			return;
		}
		if (method === "thread/read") {
			this.emit({ id, result: { thread: this.thread() } });
			return;
		}
		if (method === "thread/turns/list") {
			this.emit({ id, result: { data: [], nextCursor: null, backwardsCursor: null } });
			return;
		}
		if (method === "turn/start") {
			if (this.holdTurnStart) return;
			this.emit({ id, result: { turn: this.turn("turn-structured", "inProgress") } });
			this.emit({
				method: "turn/started",
				params: { threadId: "session-1", turn: this.turn("turn-structured", "inProgress") },
			});
			return;
		}
		if (method === "turn/interrupt") {
			if (this.interruptFails) {
				this.emit({ id, error: { code: -32000, message: "Synthetic interrupt failure." } });
				return;
			}
			this.emit({ id, result: {} });
			queueMicrotask(() => {
				this.emit({
					method: "turn/completed",
					params: { threadId: "session-1", turn: this.turn("turn-structured", "interrupted") },
				});
			});
		}
	}

	private turn(id: string, status: "completed" | "interrupted" | "failed" | "inProgress") {
		return {
			id,
			status,
			startedAt: 1,
			completedAt: status === "inProgress" ? null : 2,
			durationMs: status === "inProgress" ? null : 1,
			error: null,
			items: [],
			itemsView: "summary",
		};
	}

	private thread() {
		return {
			id: "session-1",
			sessionId: "session-1",
			forkedFromId: null,
			parentThreadId: null,
			ephemeral: false,
			historyMode: "paginated",
			cwd: this.cwd,
			cliVersion: "0.149.1",
			modelProvider: "openai",
			status: { type: "idle" },
			turns: [],
			canAcceptDirectInput: true,
		};
	}

	private resumeResponse() {
		return {
			thread: this.thread(),
			model: "gpt-test",
			modelProvider: "openai",
			serviceTier: null,
			cwd: this.cwd,
			runtimeWorkspaceRoots: [this.cwd],
			instructionSources: [],
			approvalPolicy: "on-request",
			approvalsReviewer: "user",
			sandbox: {
				type: "workspaceWrite",
				writableRoots: [this.cwd],
				networkAccess: false,
				excludeTmpdirEnvVar: false,
				excludeSlashTmp: false,
			},
			activePermissionProfile: { id: ":workspace", extends: null },
			reasoningEffort: "high",
			multiAgentMode: "explicitRequestOnly",
			initialTurnsPage: null,
			turnsBackwardsCursor: null,
			itemsBackwardsCursor: null,
		};
	}
}

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
let cleanup = () => {};
let root = "";

beforeEach(() => {
	const temp = createTempDir("quarterdeck-ownership-service-");
	root = temp.path;
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = root;
	process.env.CODEX_HOME = `${root}/codex-home`;
	process.env.CLAUDE_CONFIG_DIR = `${root}/claude-home`;
});

afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
	if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
});

function createManager(
	initialState: "running" | "awaiting_review",
	initialProcessActive = true,
	provider: "codex" | "claude" = "codex",
) {
	const store = new InMemorySessionSummaryStore();
	const confirmedAt = Date.now();
	store.hydrateFromRecord({
		"task-1": createTestTaskSessionSummary({
			taskId: "task-1",
			state: initialState,
			reviewReason: initialState === "running" ? null : "hook",
			agentId: provider,
			resumeSessionId: "session-1",
			sessionLaunchPath: `${root}/project`,
			sessionInstanceId: "native-1",
			pid: initialProcessActive ? 111 : null,
			nativeWorkEvidence:
				initialState === "running" && initialProcessActive
					? {
							provider,
							sessionInstanceId: "native-1",
							providerSessionId: "session-1",
							turnId: "native-turn-1",
							hookEventName: "UserPromptSubmit",
							confirmedAt,
							expiresAt: confirmedAt + 300_000,
						}
					: null,
		}),
	});
	if (initialState === "running" && initialProcessActive) {
		store.update("task-1", {
			state: "running",
			reviewReason: null,
			pid: 111,
			nativeWorkEvidence: {
				provider,
				sessionInstanceId: "native-1",
				providerSessionId: "session-1",
				turnId: "native-turn-1",
				hookEventName: "UserPromptSubmit",
				confirmedAt,
				expiresAt: confirmedAt + 300_000,
			},
		});
	}
	let processIdentity: NativeTaskSessionProcessIdentity | null = initialProcessActive
		? {
				pid: 111,
				sessionInstanceId: "native-1",
				launchOperationId: "native-launch",
				agentId: provider,
				binary: provider,
				profileEnvironment:
					provider === "codex"
						? { CODEX_HOME: process.env.CODEX_HOME }
						: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
			}
		: null;
	const stop = vi.fn(async (_taskId?: string, _timeoutMs?: number, sessionInstanceId?: string) => {
		processIdentity = null;
		store.update("task-1", { pid: null });
		return {
			summary: store.getSummary("task-1"),
			requestedSessionInstanceId: sessionInstanceId ?? null,
			didExit: true,
			outcome: "exited" as const,
		};
	});
	const start = vi.fn(async (request: StartTaskSessionRequest) => {
		processIdentity = {
			pid: 222,
			sessionInstanceId: "native-2",
			launchOperationId: request.launchOperationId ?? null,
			agentId: "codex",
			binary: request.binary,
			profileEnvironment:
				request.agentId === "codex"
					? { CODEX_HOME: process.env.CODEX_HOME }
					: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
		};
		return (
			store.update("task-1", {
				state: "awaiting_review",
				reviewReason: "hook",
				pid: 222,
				sessionInstanceId: "native-2",
				launchOperationId: request.launchOperationId ?? null,
				resumeSessionId: request.resumeSessionId ?? null,
			}) ?? store.ensureEntry("task-1")
		);
	});
	const manager = {
		store,
		getTaskSessionProcessIdentity: () => processIdentity,
		stopTaskSessionAndWaitForExit: stop,
		startTaskSession: start,
		waitForTaskSessionLaunch: vi.fn(
			async (_taskId: string, sessionInstanceId: string): Promise<TaskSessionLaunchReadinessOutcome> => ({
				status: "ready",
				sessionInstanceId,
				observedSessionId: "session-1",
			}),
		),
		applyStructuredTransition: (
			taskId: string,
			event: Parameters<InMemorySessionSummaryStore["applySessionEvent"]>[1],
		) => store.applySessionEvent(taskId, event),
		applyStructuredLaunchPathMissing: (taskId: string, warningMessage: string) =>
			store.applySessionEvent(taskId, {
				type: "reconciliation.launch_path_missing",
				warningMessage,
			}),
	} as unknown as TerminalSessionManager;
	return { manager, stop, start };
}

function prepared(
	manager: TerminalSessionManager,
	operationId: string,
	provider: "codex" | "claude" = "codex",
): PreparedTaskSessionStart {
	return {
		terminalManager: manager,
		request: {
			taskId: "task-1",
			launchOperationId: operationId,
			agentId: provider,
			binary: provider,
			args: provider === "claude" ? ["--resume", "session-1", "--permission-mode", "dontAsk"] : [],
			cwd: `${root}/project`,
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "session-1",
			awaitReview: true,
			...(provider === "claude" ? { claudeLaunchPermissionMode: "dontAsk" as const } : {}),
			...(provider === "codex" ? { codexApprovalsReviewer: "user" as const } : {}),
		},
		taskCwd: `${root}/project`,
		llmSummaryPolishEnabled: false,
		resumeContextWarning: null,
		resumeSessionWarning: null,
	};
}

function persistedStructuredOwnership(overrides: Partial<TaskExecutionOwnership> = {}): TaskExecutionOwnership {
	return {
		projectId: "project-1",
		taskId: "task-1",
		provider: "codex",
		providerSessionId: "session-1",
		providerSessionTreeId: "session-1",
		providerProfileFingerprint: fingerprintCodexProfileRoot(process.env.CODEX_HOME as string),
		configurationFingerprint: null,
		providerVersion: "0.149.1",
		protocolSchemaFingerprint: CODEX_APP_SERVER_SCHEMA_FINGERPRINT,
		historyMode: "paginated",
		state: "structured",
		ownerGeneration: 3,
		ownerSessionInstanceId: "structured-3",
		ownerProcess: null,
		activeTurn: null,
		pendingHandoff: null,
		lastFailure: null,
		updatedAt: Date.now(),
		...overrides,
	};
}

describe.sequential("TaskExecutionOwnershipService", () => {
	it("hands a native Claude session to the Agent SDK owner with the exact profile and process kind", async () => {
		const harness = createManager("awaiting_review", true, "claude");
		const store = new ProjectExecutionOwnershipStore();
		let liveOwner: StructuredOwner | null = null;
		let events: StructuredOwnerEvents = {};
		const start = vi.fn(async (input: StartStructuredOwnerInput): Promise<StructuredOwner> => {
			const owner: StructuredOwner = {
				context: {
					provider: "claude",
					projectId: input.projectId,
					projectPath: input.projectPath,
					taskId: input.taskId,
					ownerGeneration: input.ownerGeneration,
					ownerSessionInstanceId: input.ownerSessionInstanceId,
				},
				identity: {
					providerSessionId: input.providerSessionId,
					providerSessionTreeId: null,
					providerProfileFingerprint: fingerprintClaudeProfileRoot(process.env.CLAUDE_CONFIG_DIR as string),
					configurationFingerprint: "c".repeat(64),
					providerVersion: CLAUDE_STRUCTURED_CLI_VERSION,
					protocolSchemaFingerprint: CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
					historyMode: null,
					ownerSessionInstanceId: input.ownerSessionInstanceId,
					pid: 444,
					processKind: "stdio_agent_sdk",
				},
				hasActiveTurn: () => false,
				getActiveTurnId: () => null,
				getActiveTurn: () => null,
				hasPendingInteractions: () => false,
				listPendingInteractions: () => [],
				hasWriteAuthority: () => true,
				startMessage: async () => {
					throw new Error("not used");
				},
				interruptActiveTurn: async () => null,
				readRecentTurns: async () => [],
				answerInteraction: () => "question_not_found",
				stopAndWait: async () => true,
			};
			await input.onProcessStarted?.({ pid: 444, ownerSessionInstanceId: input.ownerSessionInstanceId });
			liveOwner = owner;
			return owner;
		});
		const registry: StructuredOwnerRegistryContract = {
			setEvents: (next) => {
				events = next;
			},
			get: () => liveOwner,
			start,
			stop: async () => "not_running",
			stopAll: async () => 0,
		};
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId, provider }) => prepared(harness.manager, operationId, provider),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => CLAUDE_STRUCTURED_CLI_VERSION,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };

		const result = await service.handoffToStructured(scope, {
			operationId: "claude-handoff",
			taskId: "task-1",
			expectedOwnerGeneration: 0,
		});
		expect(result).toMatchObject({
			ok: true,
			ownership: {
				provider: "claude",
				state: "structured",
				ownerProcess: { processKind: "stdio_agent_sdk", pid: 444 },
			},
		});
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "claude",
				providerSessionId: "session-1",
				claudeLaunchPermissionMode: "dontAsk",
				env: expect.objectContaining({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }),
			}),
		);
		expect(events.onTurnStarted).toBeTypeOf("function");
	});

	it("registers the first native owner after an admitted hook persists the exact session id", async () => {
		const harness = createManager("running");
		harness.manager.store.update("task-1", { resumeSessionId: null });
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		const resolveProviderVersion = vi.fn(async () => "0.149.1");
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.observeNativeOwner(scope, "task-1", harness.manager)).resolves.toBeNull();
		expect(resolveProviderVersion).not.toHaveBeenCalled();

		harness.manager.store.update("task-1", { resumeSessionId: "session-1" });
		await expect(service.observeNativeOwner(scope, "task-1", harness.manager)).resolves.toMatchObject({
			providerSessionId: "session-1",
			providerProfileFingerprint: fingerprintCodexProfileRoot(process.env.CODEX_HOME as string),
			providerVersion: "0.149.1",
			state: "native_tui",
			ownerGeneration: 0,
			ownerSessionInstanceId: "native-1",
		});
		expect(resolveProviderVersion).toHaveBeenCalledWith("codex");
	});

	it("allows a native restart after the prior native process was stopped", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "native_tui",
				ownerProcess: null,
				ownerSessionInstanceId: "stopped-native-owner",
			}),
		);
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.assertNativeStartAllowed(scope, "task-1")).resolves.toBeUndefined();
		await expect(service.stopCurrentOwner(scope, "task-1")).resolves.toMatchObject({
			didExit: true,
			outcome: "not_running",
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			ownerGeneration: 3,
			ownerSessionInstanceId: "stopped-native-owner",
			ownerProcess: null,
		});

		await store.updateOwnership(scope, "task-1", (current) => ({ ...current, state: "structured" }));
		await expect(service.assertNativeStartAllowed(scope, "task-1")).rejects.toThrow(
			"Task is owned by the structured execution runner.",
		);
	});

	it("does not let a delayed native observation overwrite a pending handoff fence", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		let releaseVersion!: (version: string) => void;
		const version = new Promise<string>((resolve) => {
			releaseVersion = resolve;
		});
		const resolveProviderVersion = vi.fn(async () => await version);
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		const observation = service.observeNativeOwner(scope, "task-1", harness.manager);
		await vi.waitFor(() => expect(resolveProviderVersion).toHaveBeenCalledOnce());
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				providerSessionTreeId: null,
				state: "handoff_to_structured_pending",
				ownerGeneration: 0,
				ownerSessionInstanceId: "native-1",
				ownerProcess: {
					processKind: "pty",
					pid: 111,
					sessionInstanceId: "native-1",
					launchOperationId: "native-launch",
				},
				pendingHandoff: {
					operationId: "pending-handoff",
					targetOwner: "structured",
					expectedOwnerGeneration: 0,
					phase: "stopping_owner",
					startedAt: Date.now(),
				},
			}),
		);
		releaseVersion("0.149.1");

		await expect(observation).resolves.toMatchObject({
			state: "handoff_to_structured_pending",
			pendingHandoff: { operationId: "pending-handoff" },
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "handoff_to_structured_pending",
			pendingHandoff: { operationId: "pending-handoff" },
		});
	});

	it("advances the owner generation and clears the manifest for a replacement native process", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "native_tui",
				ownerGeneration: 4,
				ownerSessionInstanceId: "native-old",
				ownerProcess: {
					processKind: "pty",
					pid: 987_654,
					sessionInstanceId: "native-old",
					launchOperationId: "native-old-launch",
				},
				configurationFingerprint: "b".repeat(64),
			}),
		);
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.observeNativeOwner(scope, "task-1", harness.manager)).resolves.toMatchObject({
			state: "native_tui",
			ownerGeneration: 5,
			ownerSessionInstanceId: "native-1",
			ownerProcess: { processKind: "pty", pid: 111, sessionInstanceId: "native-1" },
			configurationFingerprint: null,
		});
	});

	it("records an unsupported native upgrade before rejecting conversion and stops the live process identity", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "native_tui",
				ownerGeneration: 4,
				ownerSessionInstanceId: "native-old",
				ownerProcess: {
					processKind: "pty",
					pid: 987_654,
					sessionInstanceId: "native-old",
					launchOperationId: "native-old-launch",
				},
				configurationFingerprint: "b".repeat(64),
			}),
		);
		const spawnTransport = vi.fn();
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3", spawnTransport }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.150.0",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.observeNativeOwner(scope, "task-1", harness.manager)).resolves.toMatchObject({
			ownerGeneration: 5,
			ownerSessionInstanceId: "native-1",
			providerVersion: "0.150.0",
			providerSessionTreeId: null,
			historyMode: null,
			configurationFingerprint: null,
		});
		await expect(
			service.handoffToStructured(scope, {
				operationId: "unsupported-upgrade",
				taskId: "task-1",
				expectedOwnerGeneration: 5,
			}),
		).resolves.toMatchObject({ ok: false, outcome: "unsupported_provider_version" });
		expect(harness.stop).not.toHaveBeenCalled();
		expect(spawnTransport).not.toHaveBeenCalled();

		await expect(service.stopCurrentOwner(scope, "task-1")).resolves.toMatchObject({
			didExit: true,
			outcome: "exited",
			requestedSessionInstanceId: "native-1",
		});
		expect(harness.stop).toHaveBeenCalledWith("task-1", 3_000, "native-1");
	});

	it("rejects a Codex handoff when app-server does not honor the frozen reviewer policy", async () => {
		const harness = createManager("awaiting_review");
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => new ProtocolTransport(333, process.env.CODEX_HOME as string, cwd),
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => {
				const resolved = prepared(harness.manager, operationId);
				return {
					...resolved,
					request: { ...resolved.request, codexApprovalsReviewer: "auto_review" },
				};
			},
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(
			service.handoffToStructured(
				{ projectId: "project-1", projectPath: `${root}/project` },
				{ operationId: "reviewer-mismatch", taskId: "task-1", expectedOwnerGeneration: 0 },
			),
		).resolves.toMatchObject({ ok: false, outcome: "configuration_mismatch" });
	});

	it("fails closed when a stale persisted native PID remains alive after the current PTY exits", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "native_tui",
				ownerGeneration: 4,
				ownerSessionInstanceId: "native-stale",
				ownerProcess: {
					processKind: "pty",
					pid: process.pid,
					sessionInstanceId: "native-stale",
					launchOperationId: "native-stale-launch",
				},
			}),
		);
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.stopCurrentOwner(scope, "task-1")).resolves.toMatchObject({
			didExit: false,
			outcome: "failed",
			requestedSessionInstanceId: "native-1",
		});
		expect(harness.stop).toHaveBeenCalledWith("task-1", 3_000, "native-1");
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			ownerGeneration: 4,
			ownerSessionInstanceId: "native-stale",
			ownerProcess: { pid: process.pid },
		});
	});

	it("rejects a mid-turn transition before stopping the native owner", async () => {
		const harness = createManager("running");
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(333, process.env.CODEX_HOME as string, cwd);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const result = await service.handoffToStructured(
			{ projectId: "project-1", projectPath: `${root}/project` },
			{ operationId: "handoff-1", taskId: "task-1", expectedOwnerGeneration: 0 },
		);
		expect(result).toMatchObject({ ok: false, outcome: "mid_turn_rejected" });
		expect(harness.stop).not.toHaveBeenCalled();
		expect(transports).toHaveLength(0);
	});

	it("rejects native handoff while a durable interaction still needs resolution", async () => {
		const harness = createManager("awaiting_review");
		harness.manager.store.update("task-1", {
			outstandingInteraction: {
				provider: "codex",
				kind: "question",
				status: "waiting",
				requestEventName: "Question",
				openedAt: 1,
				updatedAt: 1,
				responseSubmittedAt: null,
				responseKind: null,
				sessionInstanceId: "native-1",
				providerSessionId: "session-1",
				turnId: "turn-native",
				promptId: "prompt-1",
				toolUseId: null,
				elicitationId: null,
				providerAgentId: null,
				toolName: null,
			},
		});
		const spawnTransport = vi.fn();
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3", spawnTransport }),
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(
			service.handoffToStructured(
				{ projectId: "project-1", projectPath: `${root}/project` },
				{ operationId: "handoff-with-wait", taskId: "task-1", expectedOwnerGeneration: 0 },
			),
		).resolves.toMatchObject({ ok: false, outcome: "mid_turn_rejected" });
		expect(harness.stop).not.toHaveBeenCalled();
		expect(spawnTransport).not.toHaveBeenCalled();
	});

	it("rejects native handback while the structured owner retains an unresolved callback", async () => {
		const harness = createManager("awaiting_review");
		let transport: ProtocolTransport | null = null;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				transport = new ProtocolTransport(334, process.env.CODEX_HOME as string, cwd);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "handoff-before-callback",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured", ownerGeneration: 1 } });
		const owner = registry.get(scope.projectId, "task-1");
		const activeTransport = transport as ProtocolTransport | null;
		if (!owner || !activeTransport) throw new Error("Expected the structured owner transport.");
		const started = await owner.startMessage("synthetic message", "callback-message");
		activeTransport.emitServerMessage({
			id: 77,
			method: "item/tool/requestUserInput",
			params: {
				threadId: "session-1",
				turnId: "turn-structured",
				itemId: "item-1",
				questions: [
					{
						id: "question-1",
						header: "Synthetic header",
						question: "Synthetic question?",
						options: [],
					},
				],
				isBlocking: true,
				autoResolutionMs: null,
			},
		});
		activeTransport.emitServerMessage({
			method: "turn/completed",
			params: {
				threadId: "session-1",
				turn: {
					id: "turn-structured",
					status: "completed",
					startedAt: 1,
					completedAt: 2,
					durationMs: 1,
					error: null,
					items: [],
					itemsView: "summary",
				},
			},
		});
		await expect(started.completion).resolves.toMatchObject({ id: "turn-structured", status: "completed" });
		expect(owner.getActiveTurnId()).toBeNull();
		expect(owner.hasPendingInteractions()).toBe(true);

		await expect(
			service.handoffToNative(scope, {
				operationId: "handoff-with-callback",
				taskId: "task-1",
				expectedOwnerGeneration: 1,
			}),
		).resolves.toMatchObject({ ok: false, outcome: "mid_turn_rejected" });
		expect(harness.start).not.toHaveBeenCalled();
		expect(owner.hasWriteAuthority()).toBe(true);
		await service.stopCurrentOwner(scope, "task-1");
	});

	it("round-trips the exact session with stop/wait ordering and generation fencing", async () => {
		const harness = createManager("awaiting_review");
		const transports: ProtocolTransport[] = [];
		const structuredLaunches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ args, cwd, env }) => {
				structuredLaunches.push({ args, env });
				const transport = new ProtocolTransport(333 + transports.length, process.env.CODEX_HOME as string, cwd);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		const structured = await service.handoffToStructured(scope, {
			operationId: "to-structured",
			taskId: "task-1",
			expectedOwnerGeneration: 0,
		});
		expect(structured).toMatchObject({
			ok: true,
			outcome: "completed",
			ownership: {
				state: "structured",
				ownerGeneration: 1,
				providerSessionId: "session-1",
				providerSessionTreeId: "session-1",
				historyMode: "paginated",
			},
		});
		expect(harness.stop).toHaveBeenCalledWith("task-1", 3_000, "native-1");
		expect(transports[0]?.requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
			threadId: "session-1",
		});
		expect(structuredLaunches[0]?.args).toEqual(
			expect.arrayContaining([
				"app-server",
				"--enable",
				"hooks",
				"-c",
				'approvals_reviewer="user"',
				"-c",
				"check_for_update_on_startup=false",
				"--stdio",
			]),
		);
		expect(structuredLaunches[0]?.args).not.toContain("resume");
		expect(structuredLaunches[0]?.env).toMatchObject({
			QUARTERDECK_HOOK_PROJECT_ID: "project-1",
			QUARTERDECK_HOOK_TASK_ID: "task-1",
			QUARTERDECK_HOOK_SESSION_INSTANCE_ID: structured.ownership?.ownerSessionInstanceId,
		});
		await expect(
			service.handoffToStructured(scope, {
				operationId: "to-structured",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({
			ok: true,
			outcome: "already_applied",
			replayed: true,
			ownership: { state: "structured", ownerGeneration: 1 },
		});
		expect(harness.stop).toHaveBeenCalledTimes(1);
		expect(transports).toHaveLength(1);
		await expect(
			service.handoffToNative(scope, {
				operationId: "to-structured",
				taskId: "task-1",
				expectedOwnerGeneration: 1,
			}),
		).resolves.toMatchObject({ ok: false, outcome: "operation_identity_conflict" });

		const native = await service.handoffToNative(scope, {
			operationId: "to-native",
			taskId: "task-1",
			expectedOwnerGeneration: 1,
		});
		expect(native).toMatchObject({
			ok: true,
			outcome: "completed",
			ownership: {
				state: "native_tui",
				ownerGeneration: 2,
				providerSessionId: "session-1",
				ownerSessionInstanceId: "native-2",
			},
		});
		expect(harness.start).toHaveBeenCalledWith(
			expect.objectContaining({ resumeConversation: true, resumeSessionId: "session-1" }),
		);
		await expect(service.stopCurrentOwner(scope, "task-1")).resolves.toMatchObject({
			didExit: true,
			outcome: "exited",
			requestedSessionInstanceId: "native-2",
		});
		await expect(service.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "native_tui",
			ownerGeneration: 3,
			ownerProcess: null,
		});
	});

	it("persists replacement process identity before app-server initialization completes", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		let transport: ProtocolTransport | null = null;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				transport = new ProtocolTransport(444, process.env.CODEX_HOME as string, cwd, "high", true);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		const handoff = service.handoffToStructured(scope, {
			operationId: "persist-before-init",
			taskId: "task-1",
			expectedOwnerGeneration: 0,
		});
		await vi.waitFor(async () => {
			expect(await store.getOwnership(scope, "task-1")).toMatchObject({
				state: "handoff_to_structured_pending",
				ownerGeneration: 1,
				ownerProcess: { processKind: "stdio_app_server", pid: 444 },
			});
		});
		expect(transport).not.toBeNull();
		(transport as ProtocolTransport | null)?.releaseInitialize();
		await expect(handoff).resolves.toMatchObject({ ok: true, outcome: "completed" });
	});

	it("settles a running summary before a structured stop advances the owner generation", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const coordinator = new TaskResourceOperationCoordinator();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => new ProtocolTransport(445, process.env.CODEX_HOME as string, cwd),
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: coordinator,
		});
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-active-stop",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured", ownerGeneration: 1 } });
		const owner = registry.get(scope.projectId, "task-1");
		if (!owner) throw new Error("Expected a structured owner.");
		const started = await owner.startMessage("synthetic message", "client-message-active-stop");
		await vi.waitFor(() => {
			expect(harness.manager.store.getSummary("task-1")).toMatchObject({ state: "running", pid: 445 });
		});

		await expect(
			coordinator.run(scope.projectId, "task-1", async () => await service.stopCurrentOwner(scope, "task-1")),
		).resolves.toMatchObject({ didExit: true, outcome: "exited" });
		await expect(started.completion).resolves.toMatchObject({ status: "interrupted" });
		expect(harness.manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "native_tui",
			ownerGeneration: 2,
			ownerProcess: null,
		});
	});

	it("retries reconstruction after a confirmed structured restart compatibility failure", async () => {
		const harness = createManager("awaiting_review");
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const effort = transports.length === 1 ? "low" : "high";
				const transport = new ProtocolTransport(
					555 + transports.length,
					process.env.CODEX_HOME as string,
					cwd,
					effort,
				);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "initial-structured",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { ownerGeneration: 1 } });

		await expect(service.restartStructuredOwner(scope, "task-1", "restart-structured")).resolves.toMatchObject({
			ok: false,
		});
		await expect(service.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "handoff_to_structured_pending",
			ownerGeneration: 2,
			ownerProcess: null,
			lastFailure: { code: "configuration_mismatch" },
		});
		await expect(service.restartStructuredOwner(scope, "task-1", "restart-structured-retry")).resolves.toMatchObject({
			ok: true,
			summary: { taskId: "task-1" },
		});
		await expect(service.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerGeneration: 3,
			ownerProcess: { pid: 557 },
			lastFailure: null,
		});

		await expect(
			service.handoffToNative(scope, {
				operationId: "recover-native",
				taskId: "task-1",
				expectedOwnerGeneration: 3,
			}),
		).resolves.toMatchObject({
			ok: true,
			ownership: { state: "native_tui", ownerGeneration: 4, providerSessionId: "session-1" },
		});
	});

	it("preserves a known unknown-turn outcome across an explicit structured restart", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({ lastFailure: { code: "turn_outcome_unknown", at: 1_234 } }),
		);
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => new ProtocolTransport(558, process.env.CODEX_HOME as string, cwd),
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.restartStructuredOwner(scope, "task-1", "restart-unknown-turn")).resolves.toMatchObject({
			ok: true,
			summary: {
				state: "awaiting_review",
				reviewReason: "error",
				warningMessage: expect.stringContaining("outcome is unknown"),
			},
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerProcess: { pid: 558 },
			activeTurn: null,
			lastFailure: { code: "turn_outcome_unknown", at: 1_234 },
		});
	});

	it("clears a processless pending owner without launching a replacement", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "handoff_to_structured_pending",
				lastFailure: { code: "owner_crashed", at: 1 },
				pendingHandoff: {
					operationId: "abandoned-handoff",
					targetOwner: "structured",
					expectedOwnerGeneration: 3,
					phase: "starting_replacement",
					startedAt: 1,
				},
			}),
		);
		const registry = new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" });
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.stopCurrentOwner(scope, "task-1")).resolves.toMatchObject({
			didExit: true,
			outcome: "not_running",
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "native_tui",
			ownerGeneration: 4,
			ownerProcess: null,
			pendingHandoff: null,
			lastFailure: null,
		});
	});

	it("restores structured state when restart cannot confirm the old owner stopped", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		let transport: ProtocolTransport | null = null;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				transport = new ProtocolTransport(668, process.env.CODEX_HOME as string, cwd, "high", false, true);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-restart",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured", ownerGeneration: 1 } });
		(transport as ProtocolTransport | null)?.setStopConfirmed(false);

		await expect(service.restartStructuredOwner(scope, "task-1", "restart-timeout")).resolves.toMatchObject({
			ok: false,
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerGeneration: 1,
			ownerProcess: { pid: 668 },
			pendingHandoff: null,
			lastFailure: { code: "stop_failed" },
		});
	});

	it("reuses the durable launch operation during recovery and does not replay that restart", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				ownerProcess: {
					processKind: "stdio_app_server",
					pid: 2_147_483_647,
					sessionInstanceId: "structured-3",
					launchOperationId: "restart-applied-before-crash",
				},
			}),
		);
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(670, process.env.CODEX_HOME as string, cwd);
				transports.push(transport);
				return transport;
			},
		});
		const prepareNativeResume = vi.fn(async ({ operationId }: { operationId: string }) =>
			prepared(harness.manager, operationId),
		);
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume,
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([{ taskId: "task-1", outcome: "recovered" }]);
		expect(prepareNativeResume).toHaveBeenCalledWith(
			expect.objectContaining({ operationId: "restart-applied-before-crash" }),
		);
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerGeneration: 4,
			ownerProcess: { launchOperationId: "restart-applied-before-crash" },
		});

		await expect(
			service.restartStructuredOwner(scope, "task-1", "restart-applied-before-crash"),
		).resolves.toMatchObject({ ok: true, summary: { taskId: "task-1" } });
		expect(transports).toHaveLength(1);
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({ ownerGeneration: 4 });
	});

	it("reconstructs a structured owner and classifies an unresolved prior turn without replay", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				activeTurn: { turnId: "lost-turn", clientUserMessageId: "message-lost", startedAt: 1 },
			}),
		);
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(669, process.env.CODEX_HOME as string, cwd);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([
			{ taskId: "task-1", outcome: "turn_outcome_unknown" },
		]);
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerGeneration: 4,
			activeTurn: null,
			ownerProcess: { pid: 669 },
			lastFailure: { code: "turn_outcome_unknown" },
		});
		expect(transports[0]?.requests.map(({ method }) => method)).toEqual(
			expect.arrayContaining(["thread/resume", "thread/read", "thread/turns/list"]),
		);
		expect(transports[0]?.requests.map(({ method }) => method)).not.toContain("thread/list");
	});

	it("stops an unverified native recovery before a later exact handback retry", async () => {
		const harness = createManager("awaiting_review", false);
		let readinessAttempt = 0;
		harness.manager.waitForTaskSessionLaunch = vi.fn(async (_taskId: string, sessionInstanceId: string) => {
			readinessAttempt += 1;
			return readinessAttempt === 1
				? {
						status: "identity_mismatch" as const,
						sessionInstanceId,
						expectedSessionId: "session-1",
						observedSessionId: "wrong-session",
					}
				: { status: "ready" as const, sessionInstanceId, observedSessionId: "session-1" };
		});
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(
			scope,
			persistedStructuredOwnership({
				state: "handoff_to_native_pending",
				pendingHandoff: {
					operationId: "recover-native-pending",
					targetOwner: "native_tui",
					expectedOwnerGeneration: 3,
					phase: "starting_replacement",
					startedAt: 1,
				},
			}),
		);
		await store.beginHandoff(scope, {
			operationId: "recover-native-pending",
			taskId: "task-1",
			targetOwner: "native_tui",
			expectedOwnerGeneration: 3,
		});
		const registry = new CodexStructuredOwnerRegistry({ clientVersion: "0.12.3" });
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([{ taskId: "task-1", outcome: "failed" }]);
		expect(harness.stop).toHaveBeenCalledWith("task-1", 3_000, "native-2");
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "handoff_to_native_pending",
			ownerGeneration: 4,
			ownerProcess: null,
			lastFailure: { code: "identity_mismatch" },
		});
		await expect(store.getHandoff(scope, "recover-native-pending")).resolves.toMatchObject({
			status: "failed",
			outcome: "identity_mismatch",
		});

		await expect(
			service.handoffToNative(scope, {
				operationId: "retry-native-after-recovery",
				taskId: "task-1",
				expectedOwnerGeneration: 4,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "native_tui", ownerGeneration: 5 } });
	});

	it("fails cold recovery before spawning when the persisted protocol schema gate changed", async () => {
		const harness = createManager("awaiting_review", false);
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await store.putOwnership(scope, persistedStructuredOwnership({ protocolSchemaFingerprint: "f".repeat(64) }));
		const spawnTransport = vi.fn();
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport,
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([{ taskId: "task-1", outcome: "failed" }]);
		expect(spawnTransport).not.toHaveBeenCalled();
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			lastFailure: { code: "unsupported_version" },
		});
	});

	it("retains the structured PID when failed startup cannot confirm process exit", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) =>
				new ProtocolTransport(666, `${root}/wrong-codex-home`, cwd, "high", false, true, false),
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };

		await expect(
			service.handoffToStructured(scope, {
				operationId: "failed-start-unconfirmed-stop",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: false, outcome: "stop_failed" });
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "handoff_to_structured_pending",
			ownerGeneration: 1,
			ownerProcess: { processKind: "stdio_app_server", pid: 666 },
			lastFailure: { code: "stop_failed" },
		});
	});

	it("clears durable process ownership when a timed-out planned stop exits later", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		let transport: ProtocolTransport | null = null;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				transport = new ProtocolTransport(667, process.env.CODEX_HOME as string, cwd, "high", false, true);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-timeout",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured", ownerGeneration: 1 } });
		(transport as ProtocolTransport | null)?.setStopConfirmed(false);

		await expect(
			service.handoffToNative(scope, {
				operationId: "timed-out-native-handoff",
				taskId: "task-1",
				expectedOwnerGeneration: 1,
			}),
		).resolves.toMatchObject({ ok: false, outcome: "stop_timed_out", ownership: { state: "structured" } });

		(transport as ProtocolTransport | null)?.releaseExit();
		await vi.waitFor(async () => {
			expect(await store.getOwnership(scope, "task-1")).toMatchObject({
				state: "structured",
				ownerProcess: null,
				lastFailure: { code: "owner_crashed" },
			});
		});
		await expect(
			service.handoffToNative(scope, {
				operationId: "native-after-late-exit",
				taskId: "task-1",
				expectedOwnerGeneration: 1,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "native_tui", ownerGeneration: 2 } });
	});

	it("stops and fences a structured owner when its launch path disappears", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		let launchPathAvailable = true;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => new ProtocolTransport(670, process.env.CODEX_HOME as string, cwd),
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => launchPathAvailable,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-path-removal",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured", ownerGeneration: 1 } });

		launchPathAvailable = false;
		await service.reconcileProjectLaunchPaths(scope);

		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "native_tui",
			ownerGeneration: 2,
			ownerProcess: null,
			lastFailure: { code: "worktree_missing" },
		});
		expect(registry.get(scope.projectId, "task-1")).toBeNull();
		expect(harness.manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
		});
	});

	it("blocks project removal when a structured owner cannot confirm exit", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		let transport: ProtocolTransport | null = null;
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				transport = new ProtocolTransport(671, process.env.CODEX_HOME as string, cwd, "high", false, true);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-project-removal",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured" } });
		(transport as ProtocolTransport | null)?.setStopConfirmed(false);

		await expect(service.prepareProjectRemoval(scope)).resolves.toEqual({
			ok: false,
			error: "A task execution owner could not be stopped safely.",
		});
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerProcess: { pid: 671 },
		});
	});

	it("stops a structured owner for runtime shutdown without recording a crash", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => new ProtocolTransport(672, process.env.CODEX_HOME as string, cwd),
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-shutdown",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured" } });

		await service.shutdownProject(scope);
		await vi.waitFor(async () => {
			expect(await store.getOwnership(scope, "task-1")).toMatchObject({
				state: "structured",
				ownerProcess: null,
				activeTurn: null,
				lastFailure: null,
			});
		});
		expect(registry.get(scope.projectId, "task-1")).toBeNull();
	});

	it("treats an app-server exit during turn/start as unknown and preserves it through cold recovery", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(
					673 + transports.length,
					process.env.CODEX_HOME as string,
					cwd,
					"high",
					false,
					false,
					true,
					transports.length === 0,
				);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-start-crash",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured" } });
		const owner = registry.get(scope.projectId, "task-1");
		if (!owner) throw new Error("Expected a structured owner.");
		const startFailure = owner
			.startMessage("synthetic message", "client-message-start-crash")
			.catch((error) => error);
		await vi.waitFor(() => expect(transports[0]?.requests.map(({ method }) => method)).toContain("turn/start"));
		transports[0]?.crash();
		await expect(startFailure).resolves.toBeInstanceOf(Error);
		await vi.waitFor(async () => {
			expect(await store.getOwnership(scope, "task-1")).toMatchObject({
				state: "structured",
				ownerProcess: null,
				activeTurn: null,
				lastFailure: { code: "turn_outcome_unknown" },
			});
		});
		const unknownAt = (await store.getOwnership(scope, "task-1"))?.lastFailure?.at;

		await expect(service.recoverProject(scope)).resolves.toEqual([
			{ taskId: "task-1", outcome: "turn_outcome_unknown" },
		]);
		expect(transports).toHaveLength(2);
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerProcess: { pid: 674 },
			activeTurn: null,
			lastFailure: { code: "turn_outcome_unknown", at: unknownAt },
		});
		expect(harness.manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			warningMessage: expect.stringContaining("outcome is unknown"),
		});
	});

	it("refuses cold recovery while the persisted previous owner PID is still alive", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		const persisted: TaskExecutionOwnership = {
			projectId: scope.projectId,
			taskId: "task-1",
			provider: "codex",
			providerSessionId: "session-1",
			providerSessionTreeId: "session-1",
			providerProfileFingerprint: "a".repeat(64),
			configurationFingerprint: "b".repeat(64),
			providerVersion: "0.149.1",
			protocolSchemaFingerprint: "c".repeat(64),
			historyMode: "paginated",
			state: "structured",
			ownerGeneration: 3,
			ownerSessionInstanceId: "structured-3",
			ownerProcess: {
				processKind: "stdio_app_server",
				pid: process.pid,
				sessionInstanceId: "structured-3",
				launchOperationId: "handoff-3",
			},
			activeTurn: null,
			pendingHandoff: null,
			lastFailure: null,
			updatedAt: Date.now(),
		};
		await store.putOwnership(scope, persisted);
		const spawnTransport = vi.fn();
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			spawnTransport,
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([{ taskId: "task-1", outcome: "failed" }]);
		expect(spawnTransport).not.toHaveBeenCalled();
	});

	it("fences a delayed exit callback from an older structured owner generation", async () => {
		const harness = createManager("awaiting_review");
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(
					700 + transports.length,
					process.env.CODEX_HOME as string,
					cwd,
					"high",
					false,
					transports.length === 0,
				);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store: new ProjectExecutionOwnershipStore(),
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-1",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { ownerGeneration: 1 } });
		await expect(
			service.handoffToNative(scope, {
				operationId: "native-2",
				taskId: "task-1",
				expectedOwnerGeneration: 1,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { ownerGeneration: 2 } });
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-3",
				taskId: "task-1",
				expectedOwnerGeneration: 2,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { ownerGeneration: 3, ownerProcess: { pid: 701 } } });

		transports[0]?.releaseExit();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await expect(service.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "structured",
			ownerGeneration: 3,
			ownerProcess: { pid: 701 },
		});
	});

	it("preserves an unresolved turn across shutdown when provider interruption fails", async () => {
		const harness = createManager("awaiting_review");
		const store = new ProjectExecutionOwnershipStore();
		const transports: ProtocolTransport[] = [];
		const registry = new CodexStructuredOwnerRegistry({
			clientVersion: "0.12.3",
			resolveProviderVersion: async () => "0.149.1",
			spawnTransport: ({ cwd }) => {
				const transport = new ProtocolTransport(680 + transports.length, process.env.CODEX_HOME as string, cwd);
				transports.push(transport);
				return transport;
			},
		});
		const service = new TaskExecutionOwnershipService({
			store,
			structuredOwners: registry,
			getTerminalManager: async () => harness.manager,
			prepareNativeResume: async ({ operationId }) => prepared(harness.manager, operationId),
			assertDurableHistoryAvailable: async () => true,
			resolveProviderVersion: async () => "0.149.1",
			isLaunchPathAvailable: async () => true,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: `${root}/project` };
		await expect(
			service.handoffToStructured(scope, {
				operationId: "structured-before-ambiguous-shutdown",
				taskId: "task-1",
				expectedOwnerGeneration: 0,
			}),
		).resolves.toMatchObject({ ok: true, ownership: { state: "structured" } });
		const owner = registry.get(scope.projectId, "task-1");
		if (!owner) throw new Error("Expected a structured owner.");
		const started = await owner.startMessage("synthetic message", "client-message-shutdown");
		const completion = started.completion.catch((error: unknown) => error);
		transports[0]?.setInterruptFails(true);

		await service.shutdownProject(scope);
		await completion;
		await vi.waitFor(async () => {
			expect(await store.getOwnership(scope, "task-1")).toMatchObject({
				state: "structured",
				ownerProcess: null,
				activeTurn: { turnId: "turn-structured", clientUserMessageId: "client-message-shutdown" },
				lastFailure: { code: "turn_outcome_unknown" },
			});
		});

		await expect(service.recoverProject(scope)).resolves.toEqual([
			{ taskId: "task-1", outcome: "turn_outcome_unknown" },
		]);
		expect(transports).toHaveLength(2);
	});
});
