import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import {
	type CanUseTool,
	type Options as ClaudeAgentSdkOptions,
	query as claudeQuery,
	type ElicitationRequest,
	type ElicitationResult,
	type PermissionMode,
	type Query,
	type SDKMessage,
	type SDKUserMessage,
	type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import { buildWorktreeContextPrompt } from "../terminal";
import type {
	StartStructuredOwnerInput,
	StructuredInteractionAnswer,
	StructuredOwner,
	StructuredOwnerContext,
	StructuredOwnerEvents,
	StructuredOwnerIdentity,
	StructuredPendingInteraction,
	StructuredTurn,
} from "./structured-owner";
import { StructuredOwnerCompatibilityError, StructuredOwnerStopUnconfirmedError } from "./structured-owner";

const execFileAsync = promisify(execFile);
const log = createTaggedLogger("claude-structured-owner");

export const CLAUDE_AGENT_SDK_VERSION = "0.3.241";
export const CLAUDE_STRUCTURED_CLI_VERSION = "2.1.224";
export const CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT = createHash("sha256")
	.update(
		JSON.stringify({
			sdk: CLAUDE_AGENT_SDK_VERSION,
			cli: CLAUDE_STRUCTURED_CLI_VERSION,
			callbacks: ["canUseTool.requestId", "canUseTool.toolUseID", "onElicitation.requestId"],
			messages: ["system.init", "result"],
		}),
	)
	.digest("hex");

const TURN_INTERRUPT_TIMEOUT_MS = 15_000;
const INITIALIZATION_TIMEOUT_MS = 15_000;

interface PendingClaudeInteraction extends StructuredPendingInteraction {
	answer: (answer: StructuredInteractionAnswer) => "completed" | "unsupported_interaction";
	cancel: () => void;
	signal: AbortSignal;
	dispose?: () => void;
}

interface AsyncMessageQueue extends AsyncIterable<SDKUserMessage> {
	push(message: SDKUserMessage): void;
	close(): void;
}

function createAsyncMessageQueue(): AsyncMessageQueue {
	const values: SDKUserMessage[] = [];
	const waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
	let closed = false;
	return {
		push(message) {
			if (closed) throw new Error("The Claude structured input stream is closed.");
			const waiter = waiters.shift();
			if (waiter) waiter({ value: message, done: false });
			else values.push(message);
		},
		close() {
			if (closed) return;
			closed = true;
			for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					const value = values.shift();
					if (value) return { value, done: false } as const;
					if (closed) return { value: undefined, done: true } as const;
					return await new Promise<IteratorResult<SDKUserMessage>>((resolveNext) => waiters.push(resolveNext));
				},
			};
		},
	};
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type ClaudeInitializationMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

function fingerprintClaudeObservedConfiguration(message: ClaudeInitializationMessage): string {
	return fingerprint({
		model: message.model,
		permissionMode: message.permissionMode,
		outputStyle: message.output_style,
		effort: message.effort ?? null,
		tools: [...message.tools].sort(),
		mcpServers: [...message.mcp_servers]
			.map((server) => ({ name: server.name, status: server.status }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		skills: [...message.skills].sort(),
		plugins: [...message.plugins]
			.map((plugin) => ({ name: plugin.name, path: resolve(plugin.path), version: plugin.version ?? null }))
			.sort((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)),
		agents: [...(message.agents ?? [])].sort(),
	});
}

async function readClaudeStreamInitialization(
	iterator: AsyncIterator<SDKMessage>,
): Promise<{ initialization: ClaudeInitializationMessage; buffered: SDKMessage[] }> {
	const buffered: SDKMessage[] = [];
	for (;;) {
		const next = await iterator.next();
		if (next.done) throw new StructuredOwnerCompatibilityError("identity_mismatch");
		const message = next.value;
		if (message.type === "system" && message.subtype === "init") {
			return { initialization: message, buffered };
		}
		if (message.type === "result") throw new StructuredOwnerCompatibilityError("identity_mismatch");
		buffered.push(message);
	}
}

function parseVersion(value: string): string | null {
	return value.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

export async function resolveClaudeCliVersion(binary: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 3_000 });
	const version = parseVersion(`${stdout}\n${stderr}`);
	if (!version) throw new StructuredOwnerCompatibilityError("unsupported_version");
	return version;
}

export async function resolveClaudeExecutablePath(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
	if (isAbsolute(binary)) return resolve(binary);
	const locator = process.platform === "win32" ? "where" : "/usr/bin/which";
	const { stdout } = await execFileAsync(locator, [binary], { env, timeout: 3_000 });
	const candidate = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!candidate) throw new StructuredOwnerCompatibilityError("identity_mismatch");
	return resolve(candidate);
}

export function resolveClaudeProfileRoot(env: { CLAUDE_CONFIG_DIR?: string; HOME?: string }): string {
	return resolve(env.CLAUDE_CONFIG_DIR?.trim() || resolve(env.HOME?.trim() || homedir(), ".claude"));
}

export function fingerprintClaudeProfileRoot(profileRoot: string): string {
	return fingerprint({ provider: "claude", profileRoot: resolve(profileRoot) });
}

function resolvePermissionMode(
	mode: StartStructuredOwnerInput["claudeLaunchPermissionMode"],
): PermissionMode | undefined {
	return mode && mode !== "inherit" ? mode : undefined;
}

const CLAUDE_PERMISSION_MODES = new Set<PermissionMode>([
	"default",
	"acceptEdits",
	"plan",
	"bypassPermissions",
	"dontAsk",
	"auto",
]);
const CLAUDE_CLI_PERMISSION_MODES = new Set([...CLAUDE_PERMISSION_MODES, "manual"]);

function fromClaudeCliPermissionMode(value: string): PermissionMode {
	if (!CLAUDE_CLI_PERMISSION_MODES.has(value as PermissionMode | "manual")) {
		throw new StructuredOwnerCompatibilityError("configuration_mismatch");
	}
	return value === "manual" ? "default" : (value as PermissionMode);
}

function validateClaudeNativeArgs(input: {
	args: readonly string[];
	providerSessionId: string;
	configuredPermissionMode: StartStructuredOwnerInput["claudeLaunchPermissionMode"];
	worktreeContext: string;
}): { permissionMode: PermissionMode | undefined; settingsPath: string | null; rendererMode: "alternate" | "inline" } {
	let permissionMode = resolvePermissionMode(input.configuredPermissionMode);
	let settingsPath: string | null = null;
	let rendererMode: "alternate" | "inline" = "alternate";
	const consumeValue = (index: number, option: string): { value: string; nextIndex: number } => {
		const argument = input.args[index] ?? "";
		if (argument.startsWith(`${option}=`)) return { value: argument.slice(option.length + 1), nextIndex: index };
		const value = input.args[index + 1];
		if (!value || value === "--" || value.startsWith("-")) {
			throw new StructuredOwnerCompatibilityError("configuration_mismatch");
		}
		return { value, nextIndex: index + 1 };
	};
	for (let index = 0; index < input.args.length; index += 1) {
		const argument = input.args[index] ?? "";
		if (argument === "--") throw new StructuredOwnerCompatibilityError("configuration_mismatch");
		if (argument === "--no-alt-screen") {
			rendererMode = "inline";
			continue;
		}
		if (argument === "--dangerously-skip-permissions" || argument === "--allow-dangerously-skip-permissions") {
			if (permissionMode && permissionMode !== "bypassPermissions") {
				throw new StructuredOwnerCompatibilityError("configuration_mismatch");
			}
			permissionMode = "bypassPermissions";
			continue;
		}
		if (argument === "--resume" || argument.startsWith("--resume=")) {
			const consumed = consumeValue(index, "--resume");
			if (consumed.value !== input.providerSessionId) {
				throw new StructuredOwnerCompatibilityError("identity_mismatch");
			}
			index = consumed.nextIndex;
			continue;
		}
		if (argument === "--permission-mode" || argument.startsWith("--permission-mode=")) {
			const consumed = consumeValue(index, "--permission-mode");
			const parsed = fromClaudeCliPermissionMode(consumed.value);
			if (permissionMode && permissionMode !== parsed) {
				throw new StructuredOwnerCompatibilityError("configuration_mismatch");
			}
			permissionMode = parsed;
			index = consumed.nextIndex;
			continue;
		}
		if (argument === "--settings" || argument.startsWith("--settings=")) {
			const consumed = consumeValue(index, "--settings");
			settingsPath = resolve(consumed.value);
			index = consumed.nextIndex;
			continue;
		}
		if (argument === "--append-system-prompt" || argument.startsWith("--append-system-prompt=")) {
			const consumed = consumeValue(index, "--append-system-prompt");
			if (consumed.value !== input.worktreeContext) {
				throw new StructuredOwnerCompatibilityError("configuration_mismatch");
			}
			index = consumed.nextIndex;
			continue;
		}
		throw new StructuredOwnerCompatibilityError("configuration_mismatch");
	}
	return { permissionMode, settingsPath, rendererMode };
}

function spawnClaudeProcess(options: Parameters<NonNullable<ClaudeAgentSdkOptions["spawnClaudeCodeProcess"]>>[0]) {
	return spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		signal: options.signal,
	}) as SpawnedProcess;
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolveValue, rejectValue) => {
		const timer = setTimeout(() => rejectValue(new Error(message)), timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolveValue(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				rejectValue(error);
			},
		);
	});
}

export interface ClaudeStructuredOwnerDependencies {
	createQuery?: typeof claudeQuery;
	resolveProviderVersion?: (binary: string) => Promise<string>;
	resolveExecutablePath?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string>;
	spawnProcess?: typeof spawnClaudeProcess;
	events?: StructuredOwnerEvents;
}

export class ClaudeStructuredOwner implements StructuredOwner {
	readonly context: StructuredOwnerContext;
	readonly identity: StructuredOwnerIdentity;
	private activeTurn: { turnId: null; clientUserMessageId: string; completion: Promise<StructuredTurn> } | null = null;
	private resolveActiveTurn: ((turn: StructuredTurn) => void) | null = null;
	private rejectActiveTurn: ((error: Error) => void) | null = null;
	private readonly pendingInteractions = new Map<string, PendingClaudeInteraction>();
	private stopRequested = false;
	private protocolEnded = false;
	private processExitConfirmed = false;
	private turnOutcomeUnknownOnExit = false;
	private interruptRequested = false;
	private verifiedProviderSession = false;

	constructor(
		context: StructuredOwnerContext,
		identity: StructuredOwnerIdentity,
		private readonly sdkQuery: Query,
		private readonly inputQueue: AsyncMessageQueue,
		private readonly exitPromise: Promise<void>,
		private readonly events: StructuredOwnerEvents,
		private readonly expectedCwd: string,
		private readonly expectedProviderVersion: string,
		private readonly expectedPermissionMode: PermissionMode | undefined,
		private readonly expectedObservedConfigurationFingerprint: string,
	) {
		this.context = context;
		this.identity = identity;
		this.verifiedProviderSession = true;
		void exitPromise.then(() => {
			this.processExitConfirmed = true;
			this.markExited();
		});
	}

	hasActiveTurn(): boolean {
		return this.activeTurn !== null;
	}

	getActiveTurnId(): string | null {
		return null;
	}

	getActiveTurn(): { turnId: null; clientUserMessageId: string } | null {
		return this.activeTurn ? { turnId: null, clientUserMessageId: this.activeTurn.clientUserMessageId } : null;
	}

	hasPendingInteractions(): boolean {
		return this.pendingInteractions.size > 0;
	}

	listPendingInteractions(): readonly StructuredPendingInteraction[] {
		return Array.from(this.pendingInteractions.values(), ({ answer: _answer, cancel: _cancel, ...interaction }) => ({
			...interaction,
		}));
	}

	hasWriteAuthority(): boolean {
		return !this.stopRequested && !this.protocolEnded;
	}

	async startMessage(
		text: string,
		clientUserMessageId: string,
	): Promise<{ turn: StructuredTurn; completion: Promise<StructuredTurn> }> {
		if (this.stopRequested || this.protocolEnded) throw new Error("The Claude structured owner is stopped.");
		if (this.activeTurn) throw new Error("A Claude turn is already in progress.");
		let resolveTurn!: (turn: StructuredTurn) => void;
		let rejectTurn!: (error: Error) => void;
		const completion = new Promise<StructuredTurn>((resolveCompletion, rejectCompletion) => {
			resolveTurn = resolveCompletion;
			rejectTurn = rejectCompletion;
		});
		this.activeTurn = { turnId: null, clientUserMessageId, completion };
		this.resolveActiveTurn = resolveTurn;
		this.rejectActiveTurn = rejectTurn;
		this.interruptRequested = false;
		const turn: StructuredTurn = { id: null, status: "inProgress" };
		this.inputQueue.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			origin: { kind: "human" },
			uuid: clientUserMessageId as SDKUserMessage["uuid"],
			session_id: this.identity.providerSessionId,
		});
		this.events.onTurnStarted?.(this.context, turn, clientUserMessageId);
		return { turn, completion };
	}

	async interruptActiveTurn(timeoutMs = TURN_INTERRUPT_TIMEOUT_MS): Promise<StructuredTurn | null> {
		const active = this.activeTurn;
		if (!active) return null;
		this.interruptRequested = true;
		try {
			await this.sdkQuery.interrupt();
		} catch {
			// The iterator/result remains the authoritative terminal signal.
		}
		return await waitWithTimeout(active.completion, timeoutMs, "Claude structured turn interruption timed out.");
	}

	async readRecentTurns(): Promise<StructuredTurn[]> {
		// Claude does not expose a first-class turn identifier through Agent SDK.
		// Persisted in-flight recovery therefore remains outcome-unknown rather than
		// attempting to synthesize a turn or infer completion from message order.
		return [];
	}

	answerInteraction(
		interactionId: string,
		answer: StructuredInteractionAnswer,
	): "completed" | "question_not_found" | "approval_not_found" | "unsupported_interaction" {
		const pending = this.pendingInteractions.get(interactionId);
		if (!pending) return answer.type === "approval" ? "approval_not_found" : "question_not_found";
		const outcome = pending.answer(answer);
		if (outcome === "completed") {
			this.pendingInteractions.delete(interactionId);
			pending.dispose?.();
			this.events.onInteractionResolved?.(this.context, pending);
		}
		return outcome;
	}

	async stopAndWait(timeoutMs: number): Promise<boolean> {
		if (this.processExitConfirmed) return true;
		if (!this.stopRequested) {
			this.stopRequested = true;
			for (const pending of this.pendingInteractions.values()) {
				pending.dispose?.();
				pending.cancel();
			}
			this.pendingInteractions.clear();
			this.inputQueue.close();
			this.sdkQuery.close();
		}
		try {
			await waitWithTimeout(this.exitPromise, timeoutMs, "Claude structured owner exit timed out.");
			return true;
		} catch {
			return false;
		}
	}

	handleMessage(message: SDKMessage): void {
		if (message.type === "system" && message.subtype === "init") {
			if (
				message.session_id !== this.identity.providerSessionId ||
				resolve(message.cwd) !== this.expectedCwd ||
				message.claude_code_version !== this.expectedProviderVersion ||
				(this.expectedPermissionMode !== undefined && message.permissionMode !== this.expectedPermissionMode) ||
				fingerprintClaudeObservedConfiguration(message) !== this.expectedObservedConfigurationFingerprint
			) {
				this.failActiveTurn(new StructuredOwnerCompatibilityError("identity_mismatch"));
				this.sdkQuery.close();
				return;
			}
			this.verifiedProviderSession = true;
			return;
		}
		if (message.type !== "result" || !this.activeTurn) return;
		if (message.session_id !== this.identity.providerSessionId || !this.verifiedProviderSession) {
			this.failActiveTurn(new StructuredOwnerCompatibilityError("identity_mismatch"));
			this.sdkQuery.close();
			return;
		}
		if (
			message.subtype === "success" &&
			message.user_message_uuid !== undefined &&
			message.user_message_uuid !== this.activeTurn.clientUserMessageId
		) {
			this.failActiveTurn(new StructuredOwnerCompatibilityError("identity_mismatch"));
			this.sdkQuery.close();
			return;
		}
		const status: StructuredTurn["status"] =
			this.interruptRequested ||
			message.terminal_reason === "aborted_streaming" ||
			message.terminal_reason === "aborted_tools"
				? "interrupted"
				: message.subtype === "success" && !message.is_error
					? "completed"
					: "failed";
		this.completeActiveTurn({ id: null, status });
	}

	handleIteratorError(error: unknown): void {
		if (!this.activeTurn) return;
		if (this.interruptRequested) this.completeActiveTurn({ id: null, status: "interrupted" });
		else this.failActiveTurn(error instanceof Error ? error : new Error(String(error)));
	}

	addPendingInteraction(interaction: PendingClaudeInteraction): boolean {
		if (
			!this.activeTurn ||
			this.pendingInteractions.size > 0 ||
			!interaction.interactionId ||
			!interaction.itemId ||
			interaction.signal.aborted
		) {
			return false;
		}
		const onAbort = (): void => {
			if (this.pendingInteractions.get(interaction.interactionId) !== interaction) return;
			this.pendingInteractions.delete(interaction.interactionId);
			interaction.dispose?.();
			interaction.cancel();
			this.events.onInteractionCancelled?.(this.context, interaction);
		};
		interaction.dispose = () => interaction.signal.removeEventListener("abort", onAbort);
		interaction.signal.addEventListener("abort", onAbort, { once: true });
		this.pendingInteractions.set(interaction.interactionId, interaction);
		this.events.onInteractionRequested?.(this.context, interaction);
		return true;
	}

	markExited(): void {
		if (this.protocolEnded) return;
		this.protocolEnded = true;
		for (const pending of this.pendingInteractions.values()) {
			pending.dispose?.();
			pending.cancel();
		}
		this.pendingInteractions.clear();
		const outcomeUnknown = this.turnOutcomeUnknownOnExit || this.activeTurn !== null;
		if (this.activeTurn) this.failActiveTurn(new Error("Claude structured owner exited during a turn."));
		this.events.onExit?.(this.context, outcomeUnknown);
	}

	private completeActiveTurn(turn: StructuredTurn): void {
		const resolveTurn = this.resolveActiveTurn;
		this.activeTurn = null;
		this.resolveActiveTurn = null;
		this.rejectActiveTurn = null;
		this.interruptRequested = false;
		resolveTurn?.(turn);
		this.events.onTurnCompleted?.(this.context, turn);
	}

	private failActiveTurn(error: Error): void {
		this.turnOutcomeUnknownOnExit = true;
		const rejectTurn = this.rejectActiveTurn;
		this.activeTurn = null;
		this.resolveActiveTurn = null;
		this.rejectActiveTurn = null;
		rejectTurn?.(error);
	}
}

export class ClaudeStructuredOwnerRegistry {
	private readonly owners = new Map<string, ClaudeStructuredOwner>();
	private events: StructuredOwnerEvents;

	constructor(private readonly dependencies: ClaudeStructuredOwnerDependencies = {}) {
		this.events = dependencies.events ?? {};
	}

	setEvents(events: StructuredOwnerEvents): void {
		this.events = events;
	}

	get(projectId: string, taskId: string): ClaudeStructuredOwner | null {
		return this.owners.get(JSON.stringify([projectId, taskId])) ?? null;
	}

	async start(input: StartStructuredOwnerInput): Promise<ClaudeStructuredOwner> {
		if (input.provider !== "claude") throw new StructuredOwnerCompatibilityError("identity_mismatch");
		const key = JSON.stringify([input.projectId, input.taskId]);
		if (this.owners.has(key)) throw new Error("A structured owner is already active for this task.");
		const env: NodeJS.ProcessEnv = { ...process.env, ...input.env };
		const version = await (this.dependencies.resolveProviderVersion ?? resolveClaudeCliVersion)(input.binary);
		if (
			version !== CLAUDE_STRUCTURED_CLI_VERSION ||
			(input.expectedProviderVersion && input.expectedProviderVersion !== version)
		) {
			throw new StructuredOwnerCompatibilityError("unsupported_version");
		}
		if (
			input.expectedProtocolSchemaFingerprint &&
			input.expectedProtocolSchemaFingerprint !== CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT
		) {
			throw new StructuredOwnerCompatibilityError("unsupported_version");
		}
		if (input.expectedHistoryMode) throw new StructuredOwnerCompatibilityError("history_mode");
		const executablePath = await (this.dependencies.resolveExecutablePath ?? resolveClaudeExecutablePath)(
			input.binary,
			env,
		);
		const profileRoot = resolveClaudeProfileRoot(env);
		const profileFingerprint = fingerprintClaudeProfileRoot(profileRoot);
		if (input.expectedProviderProfileFingerprint && input.expectedProviderProfileFingerprint !== profileFingerprint) {
			throw new StructuredOwnerCompatibilityError("profile_mismatch");
		}
		const worktreeContext = await buildWorktreeContextPrompt({
			cwd: input.cwd,
			projectPath: input.projectPath,
			template: input.worktreeSystemPromptTemplate,
		});
		const nativeConfiguration = validateClaudeNativeArgs({
			args: input.nativeArgs,
			providerSessionId: input.providerSessionId,
			configuredPermissionMode: input.claudeLaunchPermissionMode,
			worktreeContext,
		});
		const permissionMode = nativeConfiguration.permissionMode;
		const explicitConfiguration = {
			provider: "claude",
			sdkVersion: CLAUDE_AGENT_SDK_VERSION,
			cliVersion: version,
			executablePath,
			cwd: resolve(input.cwd),
			profileRoot,
			permissionMode: permissionMode ?? "settings",
			settingSources: ["user", "project", "local"],
			settingsPath: nativeConfiguration.settingsPath,
			rendererMode: nativeConfiguration.rendererMode,
			worktreeContext,
			flagSettingsMode: nativeConfiguration.settingsPath ? "quarterdeck_hooks_replaced_by_structured_owner" : "none",
		};

		const inputQueue = createAsyncMessageQueue();
		let spawnedProcess: SpawnedProcess | null = null;
		let resolveExit!: () => void;
		const exitPromise = new Promise<void>((resolveProcessExit) => {
			resolveExit = resolveProcessExit;
		});
		let owner: ClaudeStructuredOwner | null = null;
		const pendingBeforeOwner: PendingClaudeInteraction[] = [];
		const registerInteraction = (interaction: PendingClaudeInteraction): boolean => {
			if (!owner) {
				pendingBeforeOwner.push(interaction);
				return true;
			}
			return owner.addPendingInteraction(interaction);
		};
		const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
			if (options.agentID || !options.requestId || !options.toolUseID) {
				return { behavior: "deny", message: "Quarterdeck supports only keyed foreground interactions." };
			}
			const kind =
				toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "approval" : "approval";
			return await new Promise((resolvePermission) => {
				const interaction: PendingClaudeInteraction = {
					interactionId: options.requestId,
					kind,
					providerSessionId: input.providerSessionId,
					turnId: null,
					itemId: options.toolUseID,
					createdAt: Date.now(),
					promptText: options.title ?? options.description ?? `${toolName} requires approval.`,
					optionLabels:
						kind === "question"
							? collectClaudeQuestionOptions(toolInput)
							: ["Allow once", "Always allow", "Decline"],
					signal: options.signal,
					answer: (answer) => {
						if (kind === "question" && answer.type === "question") {
							resolvePermission({
								behavior: "allow",
								updatedInput: { ...toolInput, answers: flattenClaudeQuestionAnswers(answer.answers) },
								toolUseID: options.toolUseID,
							});
							return "completed";
						}
						if (kind === "approval" && answer.type === "approval") {
							if (answer.decision === "accept" || answer.decision === "acceptForSession") {
								resolvePermission({
									behavior: "allow",
									updatedPermissions: answer.decision === "acceptForSession" ? options.suggestions : undefined,
									toolUseID: options.toolUseID,
								});
							} else {
								resolvePermission({
									behavior: "deny",
									message: "The user declined this action.",
									toolUseID: options.toolUseID,
								});
							}
							return "completed";
						}
						return "unsupported_interaction";
					},
					cancel: () => resolvePermission({ behavior: "deny", message: "The interaction was cancelled." }),
				};
				if (!registerInteraction(interaction)) {
					resolvePermission({ behavior: "deny", message: "Another foreground interaction is already pending." });
				}
			});
		};
		const onElicitation = async (
			request: ElicitationRequest,
			options: { signal: AbortSignal; requestId: string },
		): Promise<ElicitationResult | null> =>
			await new Promise((resolveElicitation) => {
				const interaction: PendingClaudeInteraction = {
					interactionId: options.requestId,
					kind: "elicitation",
					providerSessionId: input.providerSessionId,
					turnId: null,
					itemId: request.elicitationId ?? options.requestId,
					createdAt: Date.now(),
					promptText: request.title ?? request.message,
					optionLabels: ["Accept", "Decline", "Cancel"],
					signal: options.signal,
					answer: (answer) => {
						if (answer.type !== "elicitation") return "unsupported_interaction";
						resolveElicitation({
							action: answer.action,
							...(answer.action === "accept" && isElicitationContent(answer.content)
								? { content: answer.content }
								: {}),
						});
						return "completed";
					},
					cancel: () => resolveElicitation({ action: "cancel" }),
				};
				if (!registerInteraction(interaction)) resolveElicitation({ action: "decline" });
			});

		const createQuery = this.dependencies.createQuery ?? claudeQuery;
		const sdkQuery = createQuery({
			prompt: inputQueue,
			options: {
				cwd: input.cwd,
				env,
				resume: input.providerSessionId,
				pathToClaudeCodeExecutable: executablePath,
				permissionMode,
				allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
				settingSources: ["user", "project", "local"],
				...(worktreeContext
					? { systemPrompt: { type: "preset", preset: "claude_code", append: worktreeContext } as const }
					: {}),
				canUseTool,
				onElicitation,
				spawnClaudeCodeProcess: (options) => {
					const child = (this.dependencies.spawnProcess ?? spawnClaudeProcess)(options);
					spawnedProcess = child;
					child.once("exit", () => resolveExit());
					child.once("error", () => {
						if (!(child as SpawnedProcess & { pid?: number }).pid) resolveExit();
					});
					return child;
				},
			},
		});
		try {
			const iterator = sdkQuery[Symbol.asyncIterator]();
			const [, initialStream] = await waitWithTimeout(
				Promise.all([sdkQuery.initializationResult(), readClaudeStreamInitialization(iterator)]),
				INITIALIZATION_TIMEOUT_MS,
				"Claude Agent SDK initialization timed out.",
			);
			const initialMessage = initialStream.initialization;
			if (
				initialMessage.session_id !== input.providerSessionId ||
				resolve(initialMessage.cwd) !== resolve(input.cwd) ||
				initialMessage.claude_code_version !== version ||
				(permissionMode !== undefined && initialMessage.permissionMode !== permissionMode)
			) {
				throw new StructuredOwnerCompatibilityError("identity_mismatch");
			}
			const observedConfigurationFingerprint = fingerprintClaudeObservedConfiguration(initialMessage);
			const configurationFingerprint = fingerprint({
				...explicitConfiguration,
				observedConfigurationFingerprint,
			});
			if (
				input.expectedConfigurationFingerprint &&
				input.expectedConfigurationFingerprint !== configurationFingerprint
			) {
				throw new StructuredOwnerCompatibilityError("configuration_mismatch");
			}
			const pid = (spawnedProcess as (SpawnedProcess & { pid?: number }) | null)?.pid;
			if (!pid) throw new StructuredOwnerCompatibilityError("identity_mismatch");
			await input.onProcessStarted?.({ pid, ownerSessionInstanceId: input.ownerSessionInstanceId });
			const context: StructuredOwnerContext = {
				provider: "claude",
				projectId: input.projectId,
				projectPath: input.projectPath,
				taskId: input.taskId,
				ownerGeneration: input.ownerGeneration,
				ownerSessionInstanceId: input.ownerSessionInstanceId,
			};
			owner = new ClaudeStructuredOwner(
				context,
				{
					providerSessionId: input.providerSessionId,
					providerSessionTreeId: null,
					providerProfileFingerprint: profileFingerprint,
					configurationFingerprint,
					providerVersion: version,
					protocolSchemaFingerprint: CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
					historyMode: null,
					ownerSessionInstanceId: input.ownerSessionInstanceId,
					pid,
					processKind: "stdio_agent_sdk",
				},
				sdkQuery,
				inputQueue,
				exitPromise,
				{
					...this.events,
					onExit: (eventContext, turnOutcomeUnknown) => {
						this.events.onExit?.(eventContext, turnOutcomeUnknown);
					},
				},
				resolve(input.cwd),
				version,
				permissionMode,
				observedConfigurationFingerprint,
			);
			for (const pending of pendingBeforeOwner.splice(0)) {
				if (!owner.addPendingInteraction(pending)) pending.cancel();
			}
			this.owners.set(key, owner);
			void exitPromise.then(() => {
				if (this.owners.get(key) === owner) this.owners.delete(key);
			});
			void (async () => {
				try {
					for (const message of initialStream.buffered) owner?.handleMessage(message);
					for (;;) {
						const next = await iterator.next();
						if (next.done) break;
						owner?.handleMessage(next.value);
					}
				} catch (error) {
					owner?.handleIteratorError(error);
				} finally {
					owner?.markExited();
				}
			})();
			return owner;
		} catch (error) {
			sdkQuery.close();
			if (spawnedProcess) {
				const stopped = await waitWithTimeout(
					exitPromise.then(() => true),
					3_000,
					"Claude structured owner startup exit timed out.",
				).catch(() => false);
				if (!stopped) throw new StructuredOwnerStopUnconfirmedError(error);
			}
			log.warn("claude structured owner failed to start", {
				projectId: input.projectId,
				taskId: input.taskId,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			throw error;
		}
	}

	async stop(
		projectId: string,
		taskId: string,
		ownerGeneration: number,
		ownerSessionInstanceId: string,
		timeoutMs: number,
	): Promise<"exited" | "not_running" | "superseded" | "timed_out"> {
		const key = JSON.stringify([projectId, taskId]);
		const owner = this.owners.get(key);
		if (!owner) return "not_running";
		if (
			owner.context.ownerGeneration !== ownerGeneration ||
			owner.context.ownerSessionInstanceId !== ownerSessionInstanceId
		) {
			return "superseded";
		}
		const stopped = await owner.stopAndWait(timeoutMs);
		if (!stopped) return "timed_out";
		if (this.owners.get(key) === owner) this.owners.delete(key);
		return "exited";
	}

	async stopAll(timeoutMs = 3_000): Promise<number> {
		let unconfirmed = 0;
		for (const [key, owner] of this.owners) {
			if (!(await owner.stopAndWait(timeoutMs))) unconfirmed += 1;
			else if (this.owners.get(key) === owner) this.owners.delete(key);
		}
		return unconfirmed;
	}
}

function collectClaudeQuestionOptions(input: Record<string, unknown>): string[] {
	const questions = Array.isArray(input.questions) ? input.questions : [];
	const labels = new Set<string>();
	for (const question of questions) {
		if (!isRecord(question) || !Array.isArray(question.options)) continue;
		for (const option of question.options) {
			if (!isRecord(option) || typeof option.label !== "string") continue;
			const label = option.label.trim();
			if (label) labels.add(label);
		}
	}
	return [...labels];
}

function flattenClaudeQuestionAnswers(answers: Record<string, string[]>): Record<string, string> {
	return Object.fromEntries(Object.entries(answers).map(([question, values]) => [question, values.join(", ")]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isElicitationContent(value: unknown): value is Record<string, string | number | boolean | string[]> {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(item) =>
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean" ||
				(Array.isArray(item) && item.every((entry) => typeof entry === "string")),
		)
	);
}
