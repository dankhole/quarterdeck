import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import treeKill from "tree-kill";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import {
	addressableServerRequestMethods,
	type CodexAddressableServerRequestIdentity,
	type CodexConfigReadResponse,
	type CodexJsonRpcMessage,
	type CodexThreadResumeResponse,
	type CodexTurn,
	configReadResponseSchema,
	initializeResponseSchema,
	parseAddressableServerRequestIdentity,
	parseCodexJsonRpcMessage,
	serverRequestResolvedNotificationSchema,
	threadReadResponseSchema,
	threadResumeResponseSchema,
	threadTurnsListResponseSchema,
	turnCompletedNotificationSchema,
	turnInterruptResponseSchema,
	turnStartedNotificationSchema,
	turnStartResponseSchema,
} from "./codex-app-server-protocol";
import { MAX_TASK_INTERACTION_ID_LENGTH } from "./execution-ownership-contracts";

const log = createTaggedLogger("codex-app-server");
export const CODEX_APP_SERVER_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PENDING_CODEX_INTERACTIONS = 128;

function hasDisallowedCallbackIdControl(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
			return true;
		}
	}
	return false;
}

export class CodexAppServerJsonlFramer {
	private pending = Buffer.alloc(0);

	constructor(private readonly maxMessageBytes = CODEX_APP_SERVER_MAX_MESSAGE_BYTES) {}

	push(chunk: Buffer): { lines: Buffer[]; overflow: boolean } {
		const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		const lines: Buffer[] = [];
		let lineStart = 0;
		for (let index = 0; index < data.length; index += 1) {
			if (data[index] !== 10) continue;
			let line = data.subarray(lineStart, index);
			if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
			if (line.length > this.maxMessageBytes) {
				this.pending = Buffer.alloc(0);
				return { lines: [], overflow: true };
			}
			lines.push(line);
			lineStart = index + 1;
		}
		const remainder = data.subarray(lineStart);
		if (remainder.length > this.maxMessageBytes) {
			this.pending = Buffer.alloc(0);
			return { lines: [], overflow: true };
		}
		this.pending = Buffer.from(remainder);
		return { lines, overflow: false };
	}
}

export interface CodexAppServerTransport {
	readonly pid: number;
	write(message: unknown): void;
	onMessage(listener: (message: unknown) => void): () => void;
	onExit(listener: (event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): () => void;
	requestStop(): void;
	waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface SpawnCodexAppServerTransportOptions {
	binary: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export class CodexAppServerProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexAppServerProtocolError";
	}
}

export class CodexAppServerExitedError extends Error {
	constructor() {
		super("Codex app-server exited before the operation completed.");
		this.name = "CodexAppServerExitedError";
	}
}

export function spawnCodexAppServerTransport(options: SpawnCodexAppServerTransportOptions): CodexAppServerTransport {
	const child: ChildProcessWithoutNullStreams = spawn(options.binary, options.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const messageListeners = new Set<(message: unknown) => void>();
	const exitListeners = new Set<(event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void>();
	const childPid = child.pid;
	let exitEvent: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
	const framer = new CodexAppServerJsonlFramer();
	const requestStop = (): void => {
		if (exitEvent) return;
		if (!childPid) return;
		if (process.platform === "win32") {
			treeKill(childPid, "SIGTERM", () => {
				// waitForExit owns the authoritative confirmation.
			});
			return;
		}
		child.kill("SIGTERM");
		try {
			process.kill(-childPid, "SIGTERM");
		} catch {
			// The process group may already have exited.
		}
	};
	const finishExit = (event: { exitCode: number | null; signal: NodeJS.Signals | null }): void => {
		if (exitEvent) return;
		exitEvent = event;
		for (const listener of exitListeners) listener(event);
	};
	child.stdout.on("data", (chunk: Buffer) => {
		const framed = framer.push(chunk);
		if (framed.overflow) {
			log.warn("codex app-server exceeded the bounded protocol message size", {
				maxMessageBytes: CODEX_APP_SERVER_MAX_MESSAGE_BYTES,
			});
			requestStop();
			return;
		}
		for (const line of framed.lines) {
			if (line.length === 0) continue;
			try {
				const parsed = JSON.parse(line.toString("utf8")) as unknown;
				for (const listener of messageListeners) listener(parsed);
			} catch {
				log.warn("codex app-server emitted a non-JSON stdout line", { lineLength: line.length });
			}
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		log.debug("codex app-server stderr", { byteCount: chunk.byteLength });
	});
	child.stdin.on("error", (error) => {
		log.debug("codex app-server stdin closed", {
			errorClass: normalizeDiagnosticErrorClass(error.name),
		});
	});
	child.once("error", (error) => {
		log.warn("codex app-server process error", {
			errorClass: normalizeDiagnosticErrorClass(error.name),
		});
		finishExit({ exitCode: null, signal: null });
	});
	child.once("exit", (exitCode, signal) => {
		finishExit({ exitCode, signal });
	});
	if (!childPid) throw new Error("Codex app-server did not report a process ID.");

	return {
		pid: childPid,
		write: (message) => {
			if (!child.stdin.writable) throw new CodexAppServerExitedError();
			const serialized = JSON.stringify(message);
			if (Buffer.byteLength(serialized, "utf8") > CODEX_APP_SERVER_MAX_MESSAGE_BYTES) {
				throw new CodexAppServerProtocolError("Codex app-server request exceeded the protocol message limit.");
			}
			child.stdin.write(`${serialized}\n`);
		},
		onMessage: (listener) => {
			messageListeners.add(listener);
			return () => messageListeners.delete(listener);
		},
		onExit: (listener) => {
			exitListeners.add(listener);
			if (exitEvent) queueMicrotask(() => listener(exitEvent as NonNullable<typeof exitEvent>));
			return () => exitListeners.delete(listener);
		},
		requestStop: () => {
			requestStop();
		},
		waitForExit: async (timeoutMs) => {
			if (exitEvent) return true;
			return await new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (didExit: boolean): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					exitListeners.delete(onExit);
					resolve(didExit);
				};
				function onExit(): void {
					finish(true);
				}
				exitListeners.add(onExit);
				const timer = setTimeout(() => finish(false), timeoutMs);
			});
		},
	};
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface TurnWaiter {
	resolve: (turn: CodexTurn) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface CodexPendingInteraction extends CodexAddressableServerRequestIdentity {
	interactionId: string;
	method: string;
	createdAt: number;
}

export interface CodexAppServerClientOptions {
	requestTimeoutMs?: number;
	clientVersion: string;
	clientInstanceId?: string;
}

export class CodexAppServerClient {
	readonly clientInstanceId: string;
	private readonly requestTimeoutMs: number;
	private requestCounter = 1;
	private exited = false;
	private readonly pendingRequests = new Map<string | number, PendingRequest>();
	private readonly pendingInteractions = new Map<string, CodexPendingInteraction & { requestId: string | number }>();
	private readonly turnCompletionWaiters = new Map<string, TurnWaiter[]>();
	private readonly turnStartWaiters = new Map<string, TurnWaiter[]>();
	private readonly startedTurns = new Map<string, CodexTurn>();
	private readonly completedTurns = new Map<string, CodexTurn>();
	private readonly turnStartedListeners = new Set<(turn: CodexTurn) => void>();
	private readonly turnCompletedListeners = new Set<(turn: CodexTurn) => void>();
	private readonly interactionRequestedListeners = new Set<(interaction: CodexPendingInteraction) => void>();
	private readonly interactionResolvedListeners = new Set<(interaction: CodexPendingInteraction) => void>();
	private readonly exitListeners = new Set<() => void>();

	constructor(
		readonly transport: CodexAppServerTransport,
		private readonly options: CodexAppServerClientOptions,
	) {
		this.clientInstanceId = options.clientInstanceId ?? randomUUID();
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
		transport.onMessage((message) => this.handleMessage(message));
		transport.onExit(() => this.handleExit());
	}

	get pid(): number {
		return this.transport.pid;
	}

	get hasWriteAuthority(): boolean {
		return !this.exited;
	}

	async initialize(): Promise<{ codexHome: string; userAgent: string }> {
		const result = await this.request("initialize", {
			clientInfo: { name: "quarterdeck", title: "Quarterdeck", version: this.options.clientVersion },
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
				mcpServerOpenaiFormElicitation: false,
				extensions: null,
			},
		});
		const initialized = initializeResponseSchema.parse(result);
		this.transport.write({ method: "initialized" });
		return { codexHome: initialized.codexHome, userAgent: initialized.userAgent };
	}

	async readConfig(cwd: string): Promise<CodexConfigReadResponse> {
		return configReadResponseSchema.parse(await this.request("config/read", { cwd, includeLayers: true }));
	}

	async resumeThread(threadId: string, cwd: string): Promise<CodexThreadResumeResponse> {
		return threadResumeResponseSchema.parse(
			await this.request("thread/resume", { threadId, cwd, excludeTurns: true }),
		);
	}

	async readThread(threadId: string): Promise<ReturnType<typeof threadReadResponseSchema.parse>> {
		return threadReadResponseSchema.parse(await this.request("thread/read", { threadId, includeTurns: false }));
	}

	async listTurns(threadId: string, limit = 20): Promise<ReturnType<typeof threadTurnsListResponseSchema.parse>> {
		return threadTurnsListResponseSchema.parse(
			await this.request("thread/turns/list", {
				threadId,
				limit,
				sortDirection: "desc",
				itemsView: "summary",
			}),
		);
	}

	async startTurn(input: {
		threadId: string;
		clientUserMessageId: string;
		text: string;
		cwd: string;
		model: string;
		serviceTier: string | null;
		effort: string | null;
		approvalPolicy: unknown;
		approvalsReviewer: string;
		permissions: string | null;
		sandboxPolicy: unknown | null;
		runtimeWorkspaceRoots: string[];
	}): Promise<CodexTurn> {
		const result = await this.request("turn/start", {
			threadId: input.threadId,
			clientUserMessageId: input.clientUserMessageId,
			input: [{ type: "text", text: input.text, text_elements: [] }],
			cwd: input.cwd,
			model: input.model,
			serviceTier: input.serviceTier,
			effort: input.effort,
			approvalPolicy: input.approvalPolicy,
			approvalsReviewer: input.approvalsReviewer,
			runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
			...(input.permissions ? { permissions: input.permissions } : { sandboxPolicy: input.sandboxPolicy }),
		});
		return turnStartResponseSchema.parse(result).turn;
	}

	async interruptTurn(threadId: string, turnId: string, timeoutMs = this.requestTimeoutMs): Promise<CodexTurn | null> {
		const ready = await this.waitForTurnStartOrCompletion(turnId, timeoutMs);
		const completed = this.completedTurns.get(turnId);
		if (completed) return completed;
		if (ready.status !== "inProgress") return ready;
		turnInterruptResponseSchema.parse(await this.request("turn/interrupt", { threadId, turnId }));
		return null;
	}

	waitForTurnCompletion(turnId: string, timeoutMs = 60 * 60 * 1_000): Promise<CodexTurn> {
		if (this.exited) return Promise.reject(new CodexAppServerExitedError());
		const completed = this.completedTurns.get(turnId);
		if (completed) return Promise.resolve(completed);
		return new Promise<CodexTurn>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.removeTurnWaiter(this.turnCompletionWaiters, turnId, waiter);
				reject(new CodexAppServerProtocolError("Timed out waiting for Codex turn completion."));
			}, timeoutMs);
			const waiter = { resolve, reject, timer };
			const existing = this.turnCompletionWaiters.get(turnId) ?? [];
			existing.push(waiter);
			this.turnCompletionWaiters.set(turnId, existing);
		});
	}

	listPendingInteractions(): CodexPendingInteraction[] {
		return Array.from(this.pendingInteractions.values(), ({ requestId: _requestId, ...interaction }) => interaction);
	}

	respondToInteraction(interactionId: string, result: unknown): boolean {
		const interaction = this.pendingInteractions.get(interactionId);
		if (!interaction) return false;
		this.pendingInteractions.delete(interactionId);
		this.transport.write({ id: interaction.requestId, result });
		const { requestId: _requestId, ...publicInteraction } = interaction;
		for (const listener of this.interactionResolvedListeners) listener(publicInteraction);
		return true;
	}

	rejectInteraction(interactionId: string, code: number, message: string): boolean {
		const interaction = this.pendingInteractions.get(interactionId);
		if (!interaction) return false;
		this.pendingInteractions.delete(interactionId);
		this.transport.write({ id: interaction.requestId, error: { code, message } });
		return true;
	}

	onTurnStarted(listener: (turn: CodexTurn) => void): () => void {
		this.turnStartedListeners.add(listener);
		return () => this.turnStartedListeners.delete(listener);
	}

	onTurnCompleted(listener: (turn: CodexTurn) => void): () => void {
		this.turnCompletedListeners.add(listener);
		return () => this.turnCompletedListeners.delete(listener);
	}

	onInteractionRequested(listener: (interaction: CodexPendingInteraction) => void): () => void {
		this.interactionRequestedListeners.add(listener);
		return () => this.interactionRequestedListeners.delete(listener);
	}

	onInteractionResolved(listener: (interaction: CodexPendingInteraction) => void): () => void {
		this.interactionResolvedListeners.add(listener);
		return () => this.interactionResolvedListeners.delete(listener);
	}

	onExit(listener: () => void): () => void {
		this.exitListeners.add(listener);
		if (this.exited) {
			queueMicrotask(() => {
				if (this.exitListeners.has(listener)) listener();
			});
		}
		return () => this.exitListeners.delete(listener);
	}

	async stopAndWait(timeoutMs: number): Promise<boolean> {
		if (this.exited) return true;
		this.transport.requestStop();
		return await this.transport.waitForExit(timeoutMs);
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (this.exited) return Promise.reject(new CodexAppServerExitedError());
		const id = this.requestCounter++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new CodexAppServerProtocolError(`Codex app-server request timed out: ${method}`));
			}, this.requestTimeoutMs);
			this.pendingRequests.set(id, { resolve, reject, timer });
			try {
				this.transport.write({ id, method, params });
			} catch (error) {
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new CodexAppServerProtocolError("Codex request write failed."));
			}
		});
	}

	private handleMessage(input: unknown): void {
		let message: CodexJsonRpcMessage;
		try {
			message = parseCodexJsonRpcMessage(input);
		} catch (error) {
			log.warn("invalid codex app-server protocol message", {
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
			return;
		}
		if (message.kind === "success" || message.kind === "error") {
			const pending = this.pendingRequests.get(message.id);
			if (!pending) return;
			this.pendingRequests.delete(message.id);
			clearTimeout(pending.timer);
			if (message.kind === "success") pending.resolve(message.result);
			else pending.reject(new CodexAppServerProtocolError(`Codex request failed (${message.code}).`));
			return;
		}
		if (message.kind === "request") {
			this.handleServerRequest(message);
			return;
		}
		try {
			if (message.method === "turn/started") {
				const notification = turnStartedNotificationSchema.parse(message.params);
				if (!this.completedTurns.has(notification.turn.id)) {
					this.startedTurns.set(notification.turn.id, notification.turn);
					this.trimTurnCache(this.startedTurns);
				}
				for (const listener of this.turnStartedListeners) listener(notification.turn);
				this.resolveTurnWaiters(this.turnStartWaiters, notification.turn);
				return;
			}
			if (message.method === "turn/completed") {
				const notification = turnCompletedNotificationSchema.parse(message.params);
				this.startedTurns.delete(notification.turn.id);
				this.completedTurns.set(notification.turn.id, notification.turn);
				this.trimTurnCache(this.completedTurns);
				for (const listener of this.turnCompletedListeners) listener(notification.turn);
				this.resolveTurnWaiters(this.turnStartWaiters, notification.turn);
				this.resolveTurnWaiters(this.turnCompletionWaiters, notification.turn);
				return;
			}
			if (message.method === "serverRequest/resolved") {
				const notification = serverRequestResolvedNotificationSchema.parse(message.params);
				const pending = Array.from(this.pendingInteractions.entries()).find(
					([, interaction]) =>
						interaction.requestId === notification.requestId && interaction.threadId === notification.threadId,
				);
				if (!pending) return;
				const [interactionId, interaction] = pending;
				this.pendingInteractions.delete(interactionId);
				const { requestId: _requestId, ...publicInteraction } = interaction;
				for (const listener of this.interactionResolvedListeners) listener(publicInteraction);
			}
		} catch (error) {
			log.warn("invalid codex app-server notification", {
				method: message.method,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
		}
	}

	private handleServerRequest(message: Extract<CodexJsonRpcMessage, { kind: "request" }>): void {
		if (!addressableServerRequestMethods.has(message.method)) {
			this.transport.write({
				id: message.id,
				error: { code: -32601, message: "Quarterdeck does not support this app-server callback." },
			});
			return;
		}
		try {
			const identity = parseAddressableServerRequestIdentity(message.method, message.params);
			const requestIdType = typeof message.id === "number" ? "number" : "string";
			const providerRequestId = String(message.id);
			const interactionId = `${this.clientInstanceId}:${requestIdType}:${providerRequestId}`;
			if (
				providerRequestId.trim() !== providerRequestId ||
				interactionId.length > MAX_TASK_INTERACTION_ID_LENGTH ||
				hasDisallowedCallbackIdControl(providerRequestId)
			) {
				throw new Error("Callback identity is not safely addressable.");
			}
			if (this.pendingInteractions.has(interactionId)) {
				this.transport.write({ id: message.id, error: { code: -32600, message: "Duplicate callback identity." } });
				return;
			}
			if (this.pendingInteractions.size >= MAX_PENDING_CODEX_INTERACTIONS) {
				this.transport.write({
					id: message.id,
					error: { code: -32000, message: "Too many pending app-server callbacks." },
				});
				return;
			}
			const interaction: CodexPendingInteraction & { requestId: string | number } = {
				interactionId,
				method: message.method,
				createdAt: Date.now(),
				...identity,
				requestId: message.id,
			};
			this.pendingInteractions.set(interactionId, interaction);
			const { requestId: _requestId, ...publicInteraction } = interaction;
			for (const listener of this.interactionRequestedListeners) listener(publicInteraction);
		} catch {
			this.transport.write({ id: message.id, error: { code: -32602, message: "Invalid callback identity." } });
		}
	}

	private handleExit(): void {
		if (this.exited) return;
		this.exited = true;
		const error = new CodexAppServerExitedError();
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
		this.rejectTurnWaiters(this.turnStartWaiters, error);
		this.rejectTurnWaiters(this.turnCompletionWaiters, error);
		this.turnStartWaiters.clear();
		this.turnCompletionWaiters.clear();
		for (const listener of this.exitListeners) listener();
	}

	private waitForTurnStartOrCompletion(turnId: string, timeoutMs: number): Promise<CodexTurn> {
		if (this.exited) return Promise.reject(new CodexAppServerExitedError());
		const completed = this.completedTurns.get(turnId);
		if (completed) return Promise.resolve(completed);
		const started = this.startedTurns.get(turnId);
		if (started) return Promise.resolve(started);
		return new Promise<CodexTurn>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.removeTurnWaiter(this.turnStartWaiters, turnId, waiter);
				reject(new CodexAppServerProtocolError("Timed out waiting for Codex turn start."));
			}, timeoutMs);
			const waiter = { resolve, reject, timer };
			const existing = this.turnStartWaiters.get(turnId) ?? [];
			existing.push(waiter);
			this.turnStartWaiters.set(turnId, existing);
		});
	}

	private trimTurnCache(cache: Map<string, CodexTurn>): void {
		while (cache.size > 100) {
			const oldest = cache.keys().next().value;
			if (typeof oldest !== "string") break;
			cache.delete(oldest);
		}
	}

	private resolveTurnWaiters(waitersByTurn: Map<string, TurnWaiter[]>, turn: CodexTurn): void {
		const waiters = waitersByTurn.get(turn.id) ?? [];
		waitersByTurn.delete(turn.id);
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(turn);
		}
	}

	private rejectTurnWaiters(waitersByTurn: Map<string, TurnWaiter[]>, error: Error): void {
		for (const waiters of waitersByTurn.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
	}

	private removeTurnWaiter(waitersByTurn: Map<string, TurnWaiter[]>, turnId: string, waiter: TurnWaiter): void {
		const remaining = (waitersByTurn.get(turnId) ?? []).filter((candidate) => candidate !== waiter);
		if (remaining.length > 0) waitersByTurn.set(turnId, remaining);
		else waitersByTurn.delete(turnId);
	}
}
