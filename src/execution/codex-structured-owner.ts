import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import { prepareCodexLaunchConfiguration } from "../terminal/agent-session-adapters";
import {
	CodexAppServerClient,
	type CodexAppServerTransport,
	type CodexPendingInteraction,
	type SpawnCodexAppServerTransportOptions,
	spawnCodexAppServerTransport,
} from "./codex-app-server-client";
import {
	CODEX_APP_SERVER_SCHEMA_FINGERPRINT,
	CODEX_APP_SERVER_VERSION,
	type CodexApprovalPolicy,
	type CodexSandboxPolicy,
	type CodexThread,
	type CodexTurn,
} from "./codex-app-server-protocol";
import type {
	StartStructuredOwnerInput,
	StructuredInteractionAnswer,
	StructuredOwnerContext,
	StructuredOwnerEvents,
	StructuredOwnerIdentity,
	StructuredPendingInteraction,
} from "./structured-owner";

const execFileAsync = promisify(execFile);
const log = createTaggedLogger("codex-structured-owner");
const MINIMUM_SUPPORTED_CODEX_HISTORY_VERSION = [0, 142, 5] as const;
const MAXIMUM_SUPPORTED_CODEX_HISTORY_VERSION = [0, 149, 1] as const;
const TURN_INTERRUPT_TIMEOUT_MS = 15_000;

export interface CodexStructuredConfigurationManifest {
	cwd: string;
	model: string;
	modelProvider: string;
	serviceTier: string | null;
	reasoningEffort: string | null;
	approvalPolicy: CodexApprovalPolicy;
	approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
	sandbox: CodexSandboxPolicy;
	activePermissionProfileId: string | null;
	multiAgentMode: unknown;
	runtimeWorkspaceRoots: string[];
	instructionSourceCount: number;
	effectiveConfigFingerprint: string;
	instructionConfigurationFingerprint: string;
	hookConfigurationFingerprint: string;
	toolConfigurationFingerprint: string;
	mcpConfigurationFingerprint: string;
	skillsPluginConfigurationFingerprint: string;
	environmentPolicyFingerprint: string;
}

export interface CodexStructuredOwnerIdentity extends StructuredOwnerIdentity {
	providerSessionId: string;
	providerSessionTreeId: string;
	providerProfileFingerprint: string;
	configurationFingerprint: string;
	providerVersion: string;
	protocolSchemaFingerprint: string;
	historyMode: "legacy" | "paginated";
	ownerSessionInstanceId: string;
	pid: number;
	processKind: "stdio_app_server";
}

export interface StartCodexStructuredOwnerInput extends Omit<StartStructuredOwnerInput, "provider"> {
	provider: "codex";
	projectId: string;
	projectPath: string;
	taskId: string;
	binary: string;
	nativeArgs: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	providerSessionId: string;
	expectedProviderSessionTreeId?: string | null;
	expectedProviderProfileFingerprint?: string | null;
	expectedConfigurationFingerprint?: string | null;
	expectedProviderVersion?: string | null;
	expectedProtocolSchemaFingerprint?: string | null;
	expectedHistoryMode?: "legacy" | "paginated" | null;
	ownerGeneration: number;
	ownerSessionInstanceId: string;
	launchOperationId: string;
	statuslineEnabled?: boolean;
	worktreeSystemPromptTemplate?: string;
	onProcessStarted?: (identity: { pid: number; ownerSessionInstanceId: string }) => Promise<void>;
}

export interface CodexStructuredOwnerEventContext extends StructuredOwnerContext {
	provider: "codex";
	projectId: string;
	projectPath: string;
	taskId: string;
	ownerGeneration: number;
	ownerSessionInstanceId: string;
}

export type CodexStructuredOwnerEvents = StructuredOwnerEvents;

export interface CodexStructuredOwnerDependencies {
	resolveProviderVersion?: (binary: string) => Promise<string>;
	spawnTransport?: (input: SpawnCodexAppServerTransportOptions) => CodexAppServerTransport;
	clientVersion: string;
	events?: CodexStructuredOwnerEvents;
}

export class CodexStructuredOwnerCompatibilityError extends Error {
	constructor(
		readonly code:
			| "unsupported_version"
			| "profile_mismatch"
			| "configuration_mismatch"
			| "identity_mismatch"
			| "history_mode",
	) {
		super(`Codex structured ownership compatibility check failed: ${code}.`);
		this.name = "CodexStructuredOwnerCompatibilityError";
	}
}

export class CodexStructuredOwnerStopUnconfirmedError extends Error {
	constructor(readonly startError: unknown) {
		super("Codex structured owner startup failed and process exit could not be confirmed.");
		this.name = "CodexStructuredOwnerStopUnconfirmedError";
	}
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function resolveCodexProfileRoot(env: { CODEX_HOME?: string; HOME?: string } = process.env): string {
	return resolve(env.CODEX_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".codex"));
}

export function fingerprintCodexProfileRoot(profileRoot: string): string {
	return createHash("sha256").update(resolve(profileRoot)).digest("hex");
}

export async function resolveCodexCliVersion(binary: string): Promise<string> {
	const result = await execFileAsync(binary, ["--version"], { timeout: 5_000 });
	const match = /codex-cli\s+([^\s]+)/u.exec(result.stdout.trim());
	if (!match?.[1]) throw new Error("Could not determine the Codex CLI version.");
	return match[1];
}

function validateResumedThread(input: {
	thread: CodexThread;
	expectedSessionId: string;
	expectedTreeId?: string | null;
	expectedCwd: string;
}): void {
	if (
		input.thread.id !== input.expectedSessionId ||
		(input.expectedTreeId && input.thread.sessionId !== input.expectedTreeId) ||
		input.thread.forkedFromId !== null ||
		input.thread.parentThreadId !== null ||
		input.thread.ephemeral ||
		resolve(input.thread.cwd) !== resolve(input.expectedCwd)
	) {
		throw new CodexStructuredOwnerCompatibilityError("identity_mismatch");
	}
	if (input.thread.status.type === "active" || input.thread.status.type === "systemError") {
		throw new CodexStructuredOwnerCompatibilityError("identity_mismatch");
	}
	if (input.thread.historyMode !== "legacy" && input.thread.historyMode !== "paginated") {
		throw new CodexStructuredOwnerCompatibilityError("history_mode");
	}
	const versionParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(input.thread.cliVersion)?.slice(1).map(Number) ?? null;
	if (
		!versionParts ||
		compareVersionTuple(versionParts, MINIMUM_SUPPORTED_CODEX_HISTORY_VERSION) < 0 ||
		compareVersionTuple(versionParts, MAXIMUM_SUPPORTED_CODEX_HISTORY_VERSION) > 0
	) {
		throw new CodexStructuredOwnerCompatibilityError("unsupported_version");
	}
}

function compareVersionTuple(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < 3; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function resolveHistoryMode(value: string): "legacy" | "paginated" {
	if (value === "legacy" || value === "paginated") return value;
	throw new CodexStructuredOwnerCompatibilityError("history_mode");
}

function validateRequestedApprovalMode(
	requested: StartStructuredOwnerInput["codexApprovalsReviewer"],
	resumed: { approvalsReviewer: string; approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxPolicy },
): void {
	if (!requested || requested === "inherit") return;
	const matches =
		requested === "dangerously_bypass"
			? resumed.approvalPolicy === "never" && resumed.sandbox.type === "dangerFullAccess"
			: resumed.approvalsReviewer === requested;
	if (!matches) throw new CodexStructuredOwnerCompatibilityError("configuration_mismatch");
}

function toStructuredInteraction(interaction: CodexPendingInteraction): StructuredPendingInteraction {
	return {
		interactionId: interaction.interactionId,
		kind: interaction.kind,
		providerSessionId: interaction.threadId,
		turnId: interaction.turnId,
		itemId: interaction.itemId,
		createdAt: interaction.createdAt,
		promptText: interaction.promptText,
		optionLabels: interaction.optionLabels,
	};
}

export class CodexStructuredOwner {
	readonly identity: CodexStructuredOwnerIdentity;
	readonly manifest: CodexStructuredConfigurationManifest;
	private activeTurn: { turnId: string; clientUserMessageId: string } | null = null;
	private turnStartPending = false;
	private readonly deferredInteractionRequests: CodexPendingInteraction[] = [];

	constructor(
		readonly client: CodexAppServerClient,
		readonly context: CodexStructuredOwnerEventContext,
		identity: CodexStructuredOwnerIdentity,
		manifest: CodexStructuredConfigurationManifest,
		private readonly events: CodexStructuredOwnerEvents,
	) {
		this.identity = identity;
		this.manifest = manifest;
		client.onTurnCompleted((turn) => {
			if (this.activeTurn?.turnId !== turn.id) return;
			this.activeTurn = null;
			this.events.onTurnCompleted?.(this.context, turn);
		});
		client.onInteractionRequested((interaction) => {
			if (interaction.threadId !== this.identity.providerSessionId) {
				client.rejectInteraction(
					interaction.interactionId,
					-32602,
					"Callback identity does not match the active owner.",
				);
				return;
			}
			if (this.turnStartPending && !this.activeTurn) {
				this.deferredInteractionRequests.push(interaction);
				return;
			}
			if (!this.activeTurn || (interaction.turnId !== null && interaction.turnId !== this.activeTurn.turnId)) {
				client.rejectInteraction(
					interaction.interactionId,
					-32602,
					"Callback identity does not match the active turn.",
				);
				return;
			}
			this.events.onInteractionRequested?.(this.context, toStructuredInteraction(interaction));
		});
		client.onInteractionResolved((interaction) => {
			if (client.listPendingInteractions().length === 0) {
				this.events.onInteractionResolved?.(this.context, toStructuredInteraction(interaction));
			}
		});
		client.onExit(() => this.events.onExit?.(this.context, this.activeTurn !== null || this.turnStartPending));
	}

	getActiveTurnId(): string | null {
		return this.activeTurn?.turnId ?? null;
	}

	hasActiveTurn(): boolean {
		return this.activeTurn !== null;
	}

	getActiveTurn(): { turnId: string; clientUserMessageId: string } | null {
		return this.activeTurn ? { ...this.activeTurn } : null;
	}

	hasPendingInteractions(): boolean {
		return this.client.listPendingInteractions().length > 0;
	}

	listPendingInteractions(): readonly StructuredPendingInteraction[] {
		return this.client.listPendingInteractions().map(toStructuredInteraction);
	}

	answerInteraction(
		interactionId: string,
		answer: StructuredInteractionAnswer,
	): "completed" | "question_not_found" | "approval_not_found" | "unsupported_interaction" {
		const interaction = this.client.listPendingInteractions().find((item) => item.interactionId === interactionId);
		if (!interaction) return answer.type === "approval" ? "approval_not_found" : "question_not_found";
		let result: unknown;
		if (interaction.method === "item/tool/requestUserInput" && answer.type === "question") {
			const expectedIds = new Set(interaction.questionIds);
			const answerIds = Object.keys(answer.answers);
			if (answerIds.length !== expectedIds.size || answerIds.some((id) => !expectedIds.has(id))) {
				return "question_not_found";
			}
			result = {
				answers: Object.fromEntries(
					Object.entries(answer.answers).map(([questionId, answers]) => [questionId, { answers }]),
				),
			};
		} else if (
			(interaction.method === "item/commandExecution/requestApproval" ||
				interaction.method === "item/fileChange/requestApproval") &&
			answer.type === "approval"
		) {
			if (
				interaction.allowedApprovalDecisions !== null &&
				!interaction.allowedApprovalDecisions.includes(answer.decision)
			) {
				return "unsupported_interaction";
			}
			result = { decision: answer.decision };
		} else if (interaction.method === "mcpServer/elicitation/request" && answer.type === "elicitation") {
			result = { action: answer.action, content: answer.content, _meta: null };
		} else {
			return interaction.method.includes("Approval") ? "approval_not_found" : "question_not_found";
		}
		return this.client.respondToInteraction(interactionId, result)
			? "completed"
			: answer.type === "approval"
				? "approval_not_found"
				: "question_not_found";
	}

	hasWriteAuthority(): boolean {
		return this.client.hasWriteAuthority;
	}

	async sendMessage(text: string, clientUserMessageId: string): Promise<CodexTurn> {
		const started = await this.startMessage(text, clientUserMessageId);
		return await started.completion;
	}

	async startMessage(
		text: string,
		clientUserMessageId: string,
	): Promise<{ turn: CodexTurn; completion: Promise<CodexTurn> }> {
		if (this.activeTurn) throw new Error("A Codex turn is already in progress.");
		this.turnStartPending = true;
		let turn: CodexTurn;
		try {
			turn = await this.client.startTurn({
				threadId: this.identity.providerSessionId,
				clientUserMessageId,
				text,
				cwd: this.manifest.cwd,
				model: this.manifest.model,
				serviceTier: this.manifest.serviceTier,
				effort: this.manifest.reasoningEffort,
				approvalPolicy: this.manifest.approvalPolicy,
				approvalsReviewer: this.manifest.approvalsReviewer,
				permissions: this.manifest.activePermissionProfileId,
				sandboxPolicy: this.manifest.activePermissionProfileId ? null : this.manifest.sandbox,
				runtimeWorkspaceRoots: this.manifest.runtimeWorkspaceRoots,
			});
		} catch (error) {
			for (const interaction of this.deferredInteractionRequests.splice(0)) {
				this.client.rejectInteraction(
					interaction.interactionId,
					-32603,
					"Turn start failed before the callback could be addressed.",
				);
			}
			throw error;
		} finally {
			this.turnStartPending = false;
		}
		if (turn.status === "inProgress") {
			this.activeTurn = { turnId: turn.id, clientUserMessageId };
			this.events.onTurnStarted?.(this.context, turn, clientUserMessageId);
		}
		for (const interaction of this.deferredInteractionRequests.splice(0)) {
			if (this.activeTurn && (interaction.turnId === null || interaction.turnId === this.activeTurn.turnId)) {
				this.events.onInteractionRequested?.(this.context, toStructuredInteraction(interaction));
			} else {
				this.client.rejectInteraction(
					interaction.interactionId,
					-32602,
					"Callback identity does not match the active turn.",
				);
			}
		}
		if (turn.status !== "inProgress") {
			this.events.onTurnCompleted?.(this.context, turn);
			return { turn, completion: Promise.resolve(turn) };
		}
		const completion = this.client.waitForTurnCompletion(turn.id).then((completed) => {
			if (this.activeTurn?.turnId === turn.id) {
				this.activeTurn = null;
				this.events.onTurnCompleted?.(this.context, completed);
			}
			return completed;
		});
		return { turn, completion };
	}

	async interruptActiveTurn(timeoutMs = TURN_INTERRUPT_TIMEOUT_MS): Promise<CodexTurn | null> {
		const activeTurn = this.activeTurn;
		if (!activeTurn) return null;
		const terminalTurn = await this.client.interruptTurn(
			this.identity.providerSessionId,
			activeTurn.turnId,
			timeoutMs,
		);
		if (terminalTurn) return terminalTurn;
		return await this.client.waitForTurnCompletion(activeTurn.turnId, timeoutMs);
	}

	async readRecentTurns(limit = 20): Promise<CodexTurn[]> {
		return (await this.client.listTurns(this.identity.providerSessionId, limit)).data;
	}

	async stopAndWait(timeoutMs: number): Promise<boolean> {
		return await this.client.stopAndWait(timeoutMs);
	}
}

export class CodexStructuredOwnerRegistry {
	private readonly owners = new Map<string, CodexStructuredOwner>();
	private events: CodexStructuredOwnerEvents;

	constructor(private readonly dependencies: CodexStructuredOwnerDependencies) {
		this.events = dependencies.events ?? {};
	}

	setEvents(events: CodexStructuredOwnerEvents): void {
		this.events = events;
	}

	get(projectId: string, taskId: string): CodexStructuredOwner | null {
		return this.owners.get(JSON.stringify([projectId, taskId])) ?? null;
	}

	async start(input: StartStructuredOwnerInput): Promise<CodexStructuredOwner> {
		if (input.provider !== "codex") {
			throw new CodexStructuredOwnerCompatibilityError("identity_mismatch");
		}
		const key = JSON.stringify([input.projectId, input.taskId]);
		if (this.owners.has(key)) throw new Error("A structured owner is already active for this task.");
		if (input.nativeArgs.length > 0) {
			throw new CodexStructuredOwnerCompatibilityError("configuration_mismatch");
		}
		const version = await (this.dependencies.resolveProviderVersion ?? resolveCodexCliVersion)(input.binary);
		if (
			version !== CODEX_APP_SERVER_VERSION ||
			(input.expectedProviderVersion && input.expectedProviderVersion !== version) ||
			(input.expectedProtocolSchemaFingerprint &&
				input.expectedProtocolSchemaFingerprint !== CODEX_APP_SERVER_SCHEMA_FINGERPRINT)
		) {
			throw new CodexStructuredOwnerCompatibilityError("unsupported_version");
		}
		const structuredLaunch = await prepareCodexLaunchConfiguration({
			taskId: input.taskId,
			agentId: "codex",
			binary: input.binary,
			args: input.nativeArgs,
			cwd: input.cwd,
			prompt: "",
			resumeConversation: false,
			env: input.env,
			projectId: input.projectId,
			projectPath: input.projectPath,
			hookSessionInstanceId: input.ownerSessionInstanceId,
			codexApprovalsReviewer: input.codexApprovalsReviewer,
			statuslineEnabled: input.statuslineEnabled,
			worktreeSystemPromptTemplate: input.worktreeSystemPromptTemplate,
		});
		const env: NodeJS.ProcessEnv = { ...process.env, ...input.env, ...structuredLaunch.env };
		const expectedProfileRoot = resolveCodexProfileRoot(env);
		const expectedProfileFingerprint = fingerprintCodexProfileRoot(expectedProfileRoot);
		if (
			input.expectedProviderProfileFingerprint &&
			input.expectedProviderProfileFingerprint !== expectedProfileFingerprint
		) {
			throw new CodexStructuredOwnerCompatibilityError("profile_mismatch");
		}
		const transport = (this.dependencies.spawnTransport ?? spawnCodexAppServerTransport)({
			binary: input.binary,
			args: ["app-server", ...structuredLaunch.args, "--stdio"],
			cwd: input.cwd,
			env,
		});
		const client = new CodexAppServerClient(transport, {
			clientVersion: this.dependencies.clientVersion,
		});
		try {
			await input.onProcessStarted?.({
				pid: transport.pid,
				ownerSessionInstanceId: input.ownerSessionInstanceId,
			});
			const initialized = await client.initialize();
			if (resolve(initialized.codexHome) !== expectedProfileRoot) {
				throw new CodexStructuredOwnerCompatibilityError("profile_mismatch");
			}
			const config = await client.readConfig(input.cwd);
			const resumed = await client.resumeThread(input.providerSessionId, input.cwd);
			validateResumedThread({
				thread: resumed.thread,
				expectedSessionId: input.providerSessionId,
				expectedTreeId: input.expectedProviderSessionTreeId,
				expectedCwd: input.cwd,
			});
			validateRequestedApprovalMode(input.codexApprovalsReviewer, resumed);
			const historyMode = resolveHistoryMode(resumed.thread.historyMode);
			if (input.expectedHistoryMode && input.expectedHistoryMode !== historyMode) {
				throw new CodexStructuredOwnerCompatibilityError("history_mode");
			}
			const reread = await client.readThread(input.providerSessionId);
			validateResumedThread({
				thread: reread.thread,
				expectedSessionId: input.providerSessionId,
				expectedTreeId: resumed.thread.sessionId,
				expectedCwd: input.cwd,
			});
			if (!client.hasWriteAuthority) throw new Error("Codex app-server exited during ownership verification.");
			const manifest: CodexStructuredConfigurationManifest = {
				cwd: resolve(resumed.cwd),
				model: resumed.model,
				modelProvider: resumed.modelProvider,
				serviceTier: resumed.serviceTier,
				reasoningEffort:
					resumed.reasoningEffort ??
					(typeof config.config.model_reasoning_effort === "string" ? config.config.model_reasoning_effort : null),
				approvalPolicy: resumed.approvalPolicy,
				approvalsReviewer: resumed.approvalsReviewer,
				sandbox: resumed.sandbox,
				activePermissionProfileId: resumed.activePermissionProfile?.id ?? null,
				multiAgentMode: resumed.multiAgentMode,
				runtimeWorkspaceRoots: resumed.runtimeWorkspaceRoots.map((root) => resolve(root)),
				instructionSourceCount: resumed.instructionSources.length,
				effectiveConfigFingerprint: fingerprint(config.config),
				instructionConfigurationFingerprint: fingerprint({
					instructions: config.config.instructions ?? null,
					developerInstructions: config.config.developer_instructions ?? null,
					instructionSources: resumed.instructionSources,
				}),
				hookConfigurationFingerprint: fingerprint(config.config.hooks ?? null),
				toolConfigurationFingerprint: fingerprint(config.config.tools ?? null),
				mcpConfigurationFingerprint: fingerprint(config.config.mcp_servers ?? config.config.mcpServers ?? null),
				skillsPluginConfigurationFingerprint: fingerprint({
					skills: config.config.skills ?? null,
					plugins: config.config.plugins ?? null,
				}),
				environmentPolicyFingerprint: fingerprint(config.config.shell_environment_policy ?? null),
			};
			const configurationFingerprint = fingerprint(manifest);
			if (
				input.expectedConfigurationFingerprint &&
				input.expectedConfigurationFingerprint !== configurationFingerprint
			) {
				throw new CodexStructuredOwnerCompatibilityError("configuration_mismatch");
			}
			const context: CodexStructuredOwnerEventContext = {
				provider: "codex",
				projectId: input.projectId,
				projectPath: input.projectPath,
				taskId: input.taskId,
				ownerGeneration: input.ownerGeneration,
				ownerSessionInstanceId: input.ownerSessionInstanceId,
			};
			const owner = new CodexStructuredOwner(
				client,
				context,
				{
					providerSessionId: resumed.thread.id,
					providerSessionTreeId: resumed.thread.sessionId,
					providerProfileFingerprint: expectedProfileFingerprint,
					configurationFingerprint,
					providerVersion: version,
					protocolSchemaFingerprint: CODEX_APP_SERVER_SCHEMA_FINGERPRINT,
					historyMode,
					ownerSessionInstanceId: input.ownerSessionInstanceId,
					pid: client.pid,
					processKind: "stdio_app_server",
				},
				manifest,
				{
					...this.events,
					onExit: (eventContext, turnOutcomeUnknown) => {
						if (this.owners.get(key) === owner) this.owners.delete(key);
						this.events.onExit?.(eventContext, turnOutcomeUnknown);
					},
				},
			);
			this.owners.set(key, owner);
			return owner;
		} catch (error) {
			log.warn("codex structured owner failed to start", {
				projectId: input.projectId,
				taskId: input.taskId,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			transport.requestStop();
			const stopped = await transport.waitForExit(3_000).catch(() => false);
			if (!stopped) throw new CodexStructuredOwnerStopUnconfirmedError(error);
			throw error;
		}
	}

	async stop(
		projectId: string,
		taskId: string,
		ownerGeneration: number,
		ownerSessionInstanceId: string,
		timeoutMs = 3_000,
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
		const exited = await owner.stopAndWait(timeoutMs);
		if (!exited) return "timed_out";
		if (this.owners.get(key) === owner) this.owners.delete(key);
		return "exited";
	}

	async stopAll(timeoutMs = 3_000): Promise<number> {
		let unconfirmed = 0;
		for (const [key, owner] of Array.from(this.owners.entries())) {
			if (owner.getActiveTurnId()) {
				await owner.interruptActiveTurn(timeoutMs).catch(() => null);
			}
			const exited = await owner.stopAndWait(timeoutMs).catch(() => false);
			if (!exited) {
				unconfirmed += 1;
				continue;
			}
			if (this.owners.get(key) === owner) this.owners.delete(key);
		}
		return unconfirmed;
	}
}
