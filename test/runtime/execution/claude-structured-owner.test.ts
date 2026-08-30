import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type {
	Options as ClaudeAgentSdkOptions,
	Query,
	SDKMessage,
	SDKUserMessage,
	SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { StartStructuredOwnerInput } from "../../../src/execution";
import {
	CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
	CLAUDE_STRUCTURED_CLI_VERSION,
	ClaudeStructuredOwnerRegistry,
	StructuredOwnerCompatibilityError,
} from "../../../src/execution";

class MessageStream implements AsyncIterable<SDKMessage> {
	private readonly queued: SDKMessage[] = [];
	private readonly waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
	private closed = false;

	push(message: SDKMessage): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: message, done: false });
		else this.queued.push(message);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return {
			next: async () => {
				const message = this.queued.shift();
				if (message) return { value: message, done: false };
				if (this.closed) return { value: undefined, done: true };
				return await new Promise<IteratorResult<SDKMessage>>((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

function createHarness(
	options: {
		initializationError?: Error;
		closeEmitsExit?: boolean;
		processPid?: number;
		initOverrides?: Record<string, unknown>;
	} = {},
) {
	const messages = new MessageStream();
	const processEvents = new EventEmitter();
	let capturedOptions: ClaudeAgentSdkOptions | undefined;
	let capturedPrompt: string | AsyncIterable<SDKUserMessage> | undefined;
	const process = {
		pid: options.processPid === undefined ? 43210 : options.processPid,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		killed: false,
		exitCode: null,
		kill: vi.fn(() => true),
		on: processEvents.on.bind(processEvents),
		once: processEvents.once.bind(processEvents),
		off: processEvents.off.bind(processEvents),
	} as unknown as SpawnedProcess & { pid: number };
	const query = {
		initializationResult: vi.fn(async () => {
			if (options.initializationError) {
				processEvents.emit("error", options.initializationError);
				throw options.initializationError;
			}
			return { commands: [], output_style: "default" };
		}),
		interrupt: vi.fn(async () => undefined),
		close: vi.fn(() => {
			messages.close();
			if (options.closeEmitsExit !== false) processEvents.emit("exit", 0, null);
		}),
		[Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
	} as unknown as Query;
	const createQuery = vi.fn(
		(input: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeAgentSdkOptions }) => {
			capturedOptions = input.options;
			capturedPrompt = input.prompt;
			input.options?.spawnClaudeCodeProcess?.({
				command: "/usr/local/bin/claude",
				args: [],
				cwd: "/synthetic/worktree",
				env: {},
				signal: new AbortController().signal,
			});
			queueMicrotask(() => messages.push(initMessage(options.initOverrides)));
			return query;
		},
	);
	const registry = new ClaudeStructuredOwnerRegistry({
		createQuery: createQuery as never,
		resolveProviderVersion: async () => CLAUDE_STRUCTURED_CLI_VERSION,
		resolveExecutablePath: async () => "/usr/local/bin/claude",
		spawnProcess: () => process,
	});
	return {
		registry,
		messages,
		query,
		process,
		emitProcessExit: () => processEvents.emit("exit", 0, null),
		get options() {
			return capturedOptions;
		},
		get prompt() {
			return capturedPrompt;
		},
	};
}

function startInput(overrides: Partial<StartStructuredOwnerInput> = {}): StartStructuredOwnerInput {
	return {
		provider: "claude",
		projectId: "project-1",
		projectPath: "/synthetic/project",
		taskId: "task-1",
		binary: "claude",
		nativeArgs: ["--resume", "session-1", "--permission-mode", "dontAsk"],
		cwd: "/synthetic/worktree",
		providerSessionId: "session-1",
		expectedProviderVersion: CLAUDE_STRUCTURED_CLI_VERSION,
		expectedProtocolSchemaFingerprint: CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
		ownerGeneration: 2,
		ownerSessionInstanceId: "owner-1",
		launchOperationId: "handoff-1",
		claudeLaunchPermissionMode: "dontAsk",
		...overrides,
	};
}

function initMessage(overrides: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		session_id: "session-1",
		cwd: "/synthetic/worktree",
		claude_code_version: CLAUDE_STRUCTURED_CLI_VERSION,
		permissionMode: "dontAsk",
		apiKeySource: "none",
		tools: ["Read", "Bash"],
		mcp_servers: [],
		model: "claude-haiku-4-5",
		slash_commands: [],
		output_style: "default",
		skills: [],
		plugins: [],
		uuid: "54d78cbc-fb60-40e1-9694-6f615155f106",
		...overrides,
	} as SDKMessage;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: "session-1",
		...overrides,
	} as SDKMessage;
}

describe("ClaudeStructuredOwnerRegistry", () => {
	it("pins the external CLI, resumes the exact session, and completes only on the SDK result signal", async () => {
		const harness = createHarness();
		const processStarted = vi.fn(async () => undefined);
		const owner = await harness.registry.start(startInput({ onProcessStarted: processStarted }));

		expect(harness.options?.resume).toBe("session-1");
		expect(harness.options?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
		expect(harness.options?.permissionMode).toBe("dontAsk");
		expect(processStarted).toHaveBeenCalledWith({ pid: 43210, ownerSessionInstanceId: "owner-1" });

		const started = await owner.startMessage("Continue", "8a211aa1-f98e-4147-aabb-491385086d75");
		const promptIterator = (harness.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
		await expect(promptIterator.next()).resolves.toMatchObject({
			value: {
				type: "user",
				uuid: "8a211aa1-f98e-4147-aabb-491385086d75",
				session_id: "session-1",
			},
		});
		harness.messages.push(initMessage());
		harness.messages.push(resultMessage());
		await expect(started.completion).resolves.toEqual({ id: null, status: "completed" });
		expect(owner.hasActiveTurn()).toBe(false);
		await expect(harness.registry.stopAll()).resolves.toBe(0);
	});

	it("translates Claude's native manual mode back to the SDK default mode", async () => {
		const harness = createHarness({ initOverrides: { permissionMode: "default" } });
		await harness.registry.start(
			startInput({
				nativeArgs: ["--resume", "session-1", "--permission-mode", "manual"],
				claudeLaunchPermissionMode: "default",
			}),
		);

		expect(harness.options?.permissionMode).toBe("default");
		await expect(harness.registry.stopAll()).resolves.toBe(0);
	});

	it("fails the active turn closed when the SDK init identity does not match", async () => {
		const harness = createHarness({ initOverrides: { cwd: "/synthetic/other" } });
		await expect(harness.registry.start(startInput())).rejects.toBeInstanceOf(StructuredOwnerCompatibilityError);
	});

	it("fails the active turn closed when a correlated result names another user message", async () => {
		const harness = createHarness();
		const onExit = vi.fn();
		harness.registry.setEvents({ onExit });
		const owner = await harness.registry.start(startInput());
		const started = await owner.startMessage("Continue", "8a211aa1-f98e-4147-aabb-491385086d75");
		harness.messages.push(initMessage());
		harness.messages.push(resultMessage({ user_message_uuid: "94275e7b-9931-45b7-b9ae-4d8e209a8e94" }));
		await expect(started.completion).rejects.toBeInstanceOf(StructuredOwnerCompatibilityError);
		await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(expect.anything(), true));
	});

	it("rejects replacement startup when the observed provider configuration changes", async () => {
		const firstHarness = createHarness();
		const firstOwner = await firstHarness.registry.start(startInput());
		const expectedConfigurationFingerprint = firstOwner.identity.configurationFingerprint;
		await expect(firstHarness.registry.stopAll()).resolves.toBe(0);

		const changedHarness = createHarness({ initOverrides: { model: "claude-sonnet-5" } });
		await expect(
			changedHarness.registry.start(startInput({ expectedConfigurationFingerprint })),
		).rejects.toMatchObject({ code: "configuration_mismatch" });
	});

	it("treats a spawn error as confirmed process termination during startup", async () => {
		const initializationError = new Error("synthetic spawn failure");
		const harness = createHarness({ initializationError, closeEmitsExit: false, processPid: 0 });
		await expect(harness.registry.start(startInput())).rejects.toBe(initializationError);
	});

	it("does not reinterpret a prior stop timeout as confirmed process exit", async () => {
		const harness = createHarness({ closeEmitsExit: false });
		await harness.registry.start(startInput());

		await expect(harness.registry.stop("project-1", "task-1", 2, "owner-1", 1)).resolves.toBe("timed_out");
		await expect(harness.registry.stop("project-1", "task-1", 2, "owner-1", 1)).resolves.toBe("timed_out");
		harness.emitProcessExit();
	});

	it("projects and answers a stable foreground question callback", async () => {
		const harness = createHarness();
		const owner = await harness.registry.start(startInput());
		await owner.startMessage("Continue", "8a211aa1-f98e-4147-aabb-491385086d75");
		harness.messages.push(initMessage());
		const permission = harness.options?.canUseTool?.(
			"AskUserQuestion",
			{
				questions: [{ question: "Choose", options: [{ label: "A" }, { label: "B" }] }],
			},
			{
				signal: new AbortController().signal,
				requestId: "request-1",
				toolUseID: "tool-1",
				suggestions: [],
			} as never,
		);
		await vi.waitFor(() => expect(owner.listPendingInteractions()).toHaveLength(1));
		expect(owner.listPendingInteractions()[0]).toMatchObject({
			interactionId: "request-1",
			itemId: "tool-1",
			turnId: null,
			optionLabels: ["A", "B"],
		});
		expect(owner.answerInteraction("request-1", { type: "question", answers: { Choose: ["A"] } })).toBe("completed");
		await expect(permission).resolves.toMatchObject({ behavior: "allow" });
	});

	it("removes a foreground callback when the provider aborts it", async () => {
		const harness = createHarness();
		const onInteractionCancelled = vi.fn();
		const onInteractionResolved = vi.fn();
		harness.registry.setEvents({ onInteractionCancelled, onInteractionResolved });
		const owner = await harness.registry.start(startInput());
		await owner.startMessage("Continue", "8a211aa1-f98e-4147-aabb-491385086d75");
		harness.messages.push(initMessage());
		const controller = new AbortController();
		const permission = harness.options?.canUseTool?.("Bash", { command: "true" }, {
			signal: controller.signal,
			requestId: "request-aborted",
			toolUseID: "tool-aborted",
			suggestions: [],
		} as never);
		await vi.waitFor(() => expect(owner.listPendingInteractions()).toHaveLength(1));
		controller.abort();
		await expect(permission).resolves.toMatchObject({ behavior: "deny" });
		expect(owner.listPendingInteractions()).toEqual([]);
		expect(onInteractionCancelled).toHaveBeenCalledTimes(1);
		expect(onInteractionResolved).not.toHaveBeenCalled();
	});

	it("rejects native arguments that the SDK owner cannot preserve", async () => {
		const harness = createHarness();
		await expect(
			harness.registry.start(startInput({ nativeArgs: ["--resume", "session-1", "--model", "opus"] })),
		).rejects.toMatchObject({ code: "configuration_mismatch" });
	});
});
