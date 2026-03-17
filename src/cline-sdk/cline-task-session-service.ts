import type { RuntimeTaskSessionSummary, RuntimeTaskTurnCheckpoint } from "../core/api-contract.js";
import { createSessionHost, type SessionHost } from "../../third_party/cline-sdk/packages/core/dist/server/index.js";

const CLINE_USER_ATTENTION_TOOL_NAMES = new Set(["ask_followup_question", "plan_mode_respond"]);

interface ClineTaskSessionEntry {
	summary: RuntimeTaskSessionSummary;
	messages: ClineTaskMessage[];
	activeAssistantMessageId: string | null;
	activeReasoningMessageId: string | null;
	toolMessageIdByToolCallId: Map<string, string>;
	toolInputByToolCallId: Map<string, unknown>;
}

export interface ClineTaskMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool" | "reasoning" | "status";
	content: string;
	createdAt: number;
	meta?: {
		toolName?: string | null;
		hookEventName?: string | null;
		toolCallId?: string | null;
		streamType?: string | null;
	} | null;
}

export interface StartClineTaskSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	resumeFromTrash?: boolean;
	providerId?: string | null;
	modelId?: string | null;
	apiKey?: string | null;
	baseUrl?: string | null;
}

export interface ClineTaskSessionService {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(taskId: string, text: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): Promise<void>;
}

function now(): number {
	return Date.now();
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		latestHookActivity: summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
		latestTurnCheckpoint: summary.latestTurnCheckpoint ? { ...summary.latestTurnCheckpoint } : null,
		previousTurnCheckpoint: summary.previousTurnCheckpoint ? { ...summary.previousTurnCheckpoint } : null,
	};
}

function cloneMessage(message: ClineTaskMessage): ClineTaskMessage {
	return {
		...message,
		meta: message.meta ? { ...message.meta } : message.meta,
	};
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function updateSummary(entry: ClineTaskSessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return cloneSummary(entry.summary);
}

function createMessage(taskId: string, role: ClineTaskMessage["role"], content: string): ClineTaskMessage {
	return {
		id: `${taskId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		createdAt: now(),
	};
}

function createSessionId(taskId: string): string {
	return `${taskId}-${now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isClineUserAttentionTool(toolName: string | null): boolean {
	if (!toolName) {
		return false;
	}
	return CLINE_USER_ATTENTION_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

function canReturnToRunning(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): boolean {
	return reviewReason === "attention" || reviewReason === "hook";
}

function createMessageWithMeta(
	taskId: string,
	role: ClineTaskMessage["role"],
	content: string,
	meta: ClineTaskMessage["meta"],
): ClineTaskMessage {
	return {
		...createMessage(taskId, role, content),
		meta,
	};
}

function stringifyPayload(payload: unknown): string {
	if (payload === undefined || payload === null) {
		return "";
	}
	if (typeof payload === "string") {
		return payload;
	}
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

function buildToolCallContent(input: {
	toolName: string | null;
	input: unknown;
	output?: unknown;
	error?: string | null;
	durationMs?: number | null;
}): string {
	const lines: string[] = [];
	lines.push(`Tool: ${input.toolName ?? "unknown"}`);
	const inputText = stringifyPayload(input.input);
	if (inputText) {
		lines.push("Input:");
		lines.push(inputText);
	}
	if (input.error) {
		lines.push("Error:");
		lines.push(input.error);
	} else if (input.output !== undefined) {
		const outputText = stringifyPayload(input.output);
		if (outputText) {
			lines.push("Output:");
			lines.push(outputText);
		}
	}
	if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
		lines.push(`Duration: ${Math.max(0, Math.round(input.durationMs))}ms`);
	}
	return lines.join("\n");
}

function updateMessageInEntry(
	entry: ClineTaskSessionEntry,
	messageId: string,
	updater: (currentMessage: ClineTaskMessage) => ClineTaskMessage,
): ClineTaskMessage | null {
	const messageIndex = entry.messages.findIndex((message) => message.id === messageId);
	if (messageIndex < 0) {
		return null;
	}
	const currentMessage = entry.messages[messageIndex];
	if (!currentMessage) {
		return null;
	}
	const nextMessage = updater(currentMessage);
	entry.messages[messageIndex] = nextMessage;
	return nextMessage;
}

function getLatestAssistantMessage(entry: ClineTaskSessionEntry): ClineTaskMessage | null {
	for (let index = entry.messages.length - 1; index >= 0; index -= 1) {
		const message = entry.messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return null;
}

function latestAssistantMessageMatches(entry: ClineTaskSessionEntry, content: string): boolean {
	const latestAssistant = getLatestAssistantMessage(entry);
	if (!latestAssistant) {
		return false;
	}
	return latestAssistant.content.trim() === content.trim();
}

function readAgentResultText(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	if (!("text" in result)) {
		return null;
	}
	const text = result.text;
	if (typeof text !== "string") {
		return null;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? normalized : null;
}

function isLikelySerializedAgentEventChunk(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) {
		return false;
	}
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return false;
	}
	try {
		const parsed = JSON.parse(trimmed);
		return Boolean(parsed && typeof parsed === "object" && "type" in parsed);
	} catch {
		return false;
	}
}

function extractSessionId(event: unknown): string | null {
	if (!event || typeof event !== "object" || !("payload" in event)) {
		return null;
	}
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || !("sessionId" in payload)) {
		return null;
	}
	return typeof payload.sessionId === "string" ? payload.sessionId : null;
}

export class InMemoryClineTaskSessionService implements ClineTaskSessionService {
	private readonly entries = new Map<string, ClineTaskSessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly messageListeners = new Set<(taskId: string, message: ClineTaskMessage) => void>();
	private readonly sessionIdByTaskId = new Map<string, string>();
	private readonly taskIdBySessionId = new Map<string, string>();
	private readonly pendingTurnCancelTaskIds = new Set<string>();
	private sessionHostPromise: Promise<SessionHost> | null = null;

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	async startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const existing = this.entries.get(request.taskId);
		if (existing && (existing.summary.state === "running" || existing.summary.state === "awaiting_review")) {
			return cloneSummary(existing.summary);
		}

		const providerId = request.providerId?.trim() || "anthropic";
		const modelId = request.modelId?.trim() || "claude-sonnet-4-6";
		const requestedSessionId = createSessionId(request.taskId);

		const summary: RuntimeTaskSessionSummary = {
			...createDefaultSummary(request.taskId),
			state: "running",
			workspacePath: request.cwd,
			startedAt: now(),
			lastOutputAt: now(),
		};
		const entry: ClineTaskSessionEntry = {
			summary,
			messages: [],
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map<string, string>(),
			toolInputByToolCallId: new Map<string, unknown>(),
		};
		this.entries.set(request.taskId, entry);
		this.sessionIdByTaskId.set(request.taskId, requestedSessionId);
		this.taskIdBySessionId.set(requestedSessionId, request.taskId);
		this.pendingTurnCancelTaskIds.delete(request.taskId);

		if (!request.resumeFromTrash && request.prompt.trim().length > 0) {
			const message = createMessage(request.taskId, "user", request.prompt.trim());
			entry.messages.push(message);
			this.emitMessage(request.taskId, message);
			const runningSummary = updateSummary(entry, {
				state: "running",
				reviewReason: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(runningSummary);
		}
		this.emitSummary(summary);

		void (async () => {
			const assistantCountBeforeStart = entry.messages.filter((message) => message.role === "assistant").length;
			const sessionHost = await this.ensureSessionHost().catch(() => null);
			if (!sessionHost) {
				const failedMessage = createMessage(request.taskId, "system", "Cline SDK host is unavailable.");
				entry.messages.push(failedMessage);
				this.emitMessage(request.taskId, failedMessage);
				const failedSummary = updateSummary(entry, {
					state: "failed",
					reviewReason: "exit",
					lastOutputAt: now(),
				});
				this.emitSummary(failedSummary);
				return;
			}

			try {
				const startResult = await sessionHost.start({
					config: {
						sessionId: requestedSessionId,
						providerId,
						modelId,
						apiKey: request.apiKey?.trim() || undefined,
						baseUrl: request.baseUrl?.trim() || undefined,
						cwd: request.cwd,
						enableTools: true,
						enableSpawnAgent: false,
						enableAgentTeams: false,
						systemPrompt: "You are a helpful coding assistant.",
					},
					prompt: request.prompt,
					interactive: true,
				});

				if (startResult.sessionId !== requestedSessionId) {
					this.taskIdBySessionId.delete(requestedSessionId);
					this.sessionIdByTaskId.set(request.taskId, startResult.sessionId);
					this.taskIdBySessionId.set(startResult.sessionId, request.taskId);
				}

				const initialAgentText = readAgentResultText(startResult.result);
				if (initialAgentText) {
					const assistantCountAfterStart = entry.messages.filter((message) => message.role === "assistant").length;
					if (assistantCountAfterStart > assistantCountBeforeStart) {
						return;
					}
					if (!this.setOrCreateAssistantMessage(entry, request.taskId, initialAgentText)) {
						const agentMessage = createMessage(request.taskId, "assistant", initialAgentText);
						entry.messages.push(agentMessage);
						entry.activeAssistantMessageId = agentMessage.id;
						this.emitMessage(request.taskId, agentMessage);
					}
				}
			} catch {
				const failedMessage = createMessage(request.taskId, "system", "Cline SDK start failed.");
				entry.messages.push(failedMessage);
				this.emitMessage(request.taskId, failedMessage);
				const failedSummary = updateSummary(entry, {
					state: "failed",
					reviewReason: "exit",
					lastOutputAt: now(),
				});
				this.emitSummary(failedSummary);
			}
		})();

		return cloneSummary(summary);
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const sessionHost = await this.ensureSessionHost().catch(() => null);
		const sessionId = this.sessionIdByTaskId.get(taskId);
		this.pendingTurnCancelTaskIds.delete(taskId);
		if (sessionHost && sessionId) {
			try {
				await sessionHost.stop(sessionId);
			} catch {
				// Best effort stop only.
			}
		}
		if (entry.summary.state === "idle") {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const sessionHost = await this.ensureSessionHost().catch(() => null);
		const sessionId = this.sessionIdByTaskId.get(taskId);
		this.pendingTurnCancelTaskIds.delete(taskId);
		if (sessionHost && sessionId) {
			try {
				await sessionHost.abort(sessionId);
			} catch {
				// Best effort abort only.
			}
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.summary.state !== "running") {
			return null;
		}
		this.pendingTurnCancelTaskIds.add(taskId);
		const sessionHost = await this.ensureSessionHost().catch(() => null);
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (sessionHost && sessionId) {
			try {
				await sessionHost.abort(sessionId);
			} catch {
				// Best effort cancel only.
			}
		}
		entry.activeAssistantMessageId = null;
		entry.activeReasoningMessageId = null;
		entry.toolMessageIdByToolCallId.clear();
		entry.toolInputByToolCallId.clear();
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			exitCode: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(summary);
		return summary;
	}

	async sendTaskSessionInput(taskId: string, text: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.summary.state !== "running" && entry.summary.state !== "awaiting_review" && entry.summary.state !== "idle") {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		const normalized = text.trim();
		if (normalized.length > 0) {
			const message = createMessage(taskId, "user", normalized);
			entry.messages.push(message);
			this.emitMessage(taskId, message);
			entry.activeAssistantMessageId = null;
			entry.activeReasoningMessageId = null;
			entry.toolMessageIdByToolCallId.clear();
			entry.toolInputByToolCallId.clear();
			const waitingSummary = updateSummary(entry, {
				state: "running",
				reviewReason: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(waitingSummary);
			const assistantCountBeforeSend = entry.messages.filter((message) => message.role === "assistant").length;

			const sessionHost = await this.ensureSessionHost().catch(() => null);
			const sessionId = this.sessionIdByTaskId.get(taskId);
			if (sessionHost && sessionId) {
				void sessionHost
					.send({
						sessionId,
						prompt: normalized,
					})
					.then((result: unknown) => {
						const agentText = readAgentResultText(result);
						if (agentText) {
							const assistantCountAfterSend = entry.messages.filter((message) => message.role === "assistant").length;
							if (assistantCountAfterSend > assistantCountBeforeSend) {
								return;
							}
							if (!this.setOrCreateAssistantMessage(entry, taskId, agentText)) {
								const agentMessage = createMessage(taskId, "assistant", agentText);
								entry.messages.push(agentMessage);
								entry.activeAssistantMessageId = agentMessage.id;
								this.emitMessage(taskId, agentMessage);
							}
						}
					})
					.catch(() => {
						const systemMessage = createMessage(taskId, "system", "Cline SDK send failed.");
						entry.messages.push(systemMessage);
						this.emitMessage(taskId, systemMessage);
					});
			}
		}
		const summary = updateSummary(entry, {
			state: "running",
			reviewReason: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return [];
		}
		return entry.messages.map((message) => cloneMessage(message));
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const summary = updateSummary(entry, {
			latestTurnCheckpoint: checkpoint,
			previousTurnCheckpoint: entry.summary.latestTurnCheckpoint ?? null,
		});
		this.emitSummary(summary);
		return summary;
	}

	async dispose(): Promise<void> {
		const hostPromise = this.sessionHostPromise;
		this.sessionHostPromise = null;
		if (hostPromise) {
			try {
				const host = await hostPromise;
				await host.dispose("kanban-runtime-dispose");
			} catch {
				// Ignore host disposal errors.
			}
		}
		this.entries.clear();
		this.sessionIdByTaskId.clear();
		this.taskIdBySessionId.clear();
		this.pendingTurnCancelTaskIds.clear();
		this.summaryListeners.clear();
		this.messageListeners.clear();
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}

	private emitMessage(taskId: string, message: ClineTaskMessage): void {
		const snapshot = cloneMessage(message);
		for (const listener of this.messageListeners) {
			listener(taskId, snapshot);
		}
	}

	private async ensureSessionHost(): Promise<SessionHost> {
		if (!this.sessionHostPromise) {
			this.sessionHostPromise = createSessionHost({ backendMode: "local" }).then((sessionHost: SessionHost) => {
				sessionHost.subscribe((event: unknown) => {
					this.handleSessionEvent(event);
				});
				return sessionHost;
			});
		}
		return await this.sessionHostPromise;
	}

	private handleSessionEvent(event: unknown): void {
		const sessionId = extractSessionId(event);
		if (!sessionId) {
			return;
		}
		const taskId = this.taskIdBySessionId.get(sessionId);
		if (!taskId) {
			return;
		}
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_start" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "text"
		) {
			const accumulated =
				"accumulated" in event.payload.event && typeof event.payload.event.accumulated === "string"
					? event.payload.event.accumulated
					: null;
			const text =
				"text" in event.payload.event && typeof event.payload.event.text === "string"
					? event.payload.event.text
					: null;
			if (typeof accumulated === "string") {
				if (!this.setOrCreateAssistantMessage(entry, taskId, accumulated)) {
					const agentMessage = createMessage(taskId, "assistant", accumulated);
					entry.messages.push(agentMessage);
					entry.activeAssistantMessageId = agentMessage.id;
					this.emitMessage(taskId, agentMessage);
				}
			} else if (typeof text === "string" && text.length > 0) {
				this.appendAssistantChunk(entry, taskId, text);
			}
			const summary = updateSummary(entry, {
				state: "running",
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					finalMessage: null,
					hookEventName: "assistant_delta",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "done"
		) {
			const finalText =
				"text" in event.payload.event && typeof event.payload.event.text === "string"
					? event.payload.event.text.trim()
					: "";
			if (finalText) {
				if (!this.setOrCreateAssistantMessage(entry, taskId, finalText) && !latestAssistantMessageMatches(entry, finalText)) {
					const assistantMessage = createMessage(taskId, "assistant", finalText);
					entry.messages.push(assistantMessage);
					this.emitMessage(taskId, assistantMessage);
				}
			}

			const doneReason =
				"reason" in event.payload.event && typeof event.payload.event.reason === "string"
					? event.payload.event.reason
					: "completed";
			if (doneReason === "aborted" && this.pendingTurnCancelTaskIds.has(taskId)) {
				this.pendingTurnCancelTaskIds.delete(taskId);
				entry.activeAssistantMessageId = null;
				entry.activeReasoningMessageId = null;
				entry.toolMessageIdByToolCallId.clear();
				entry.toolInputByToolCallId.clear();
				const canceledSummary = updateSummary(entry, {
					state: "idle",
					reviewReason: null,
					lastOutputAt: now(),
					lastHookAt: now(),
					latestHookActivity: {
						activityText: "Turn canceled",
						toolName: null,
						finalMessage: null,
						hookEventName: "turn_canceled",
						notificationType: null,
						source: "cline-sdk",
					},
				});
				this.emitSummary(canceledSummary);
				return;
			}
			const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: finalText ? `Final: ${finalText}` : "Waiting for review",
					toolName: null,
					finalMessage: finalText || null,
					hookEventName: "agent_end",
					notificationType: null,
					source: "cline-sdk",
				},
			};
			if (doneReason === "aborted") {
				summaryPatch.state = "interrupted";
				summaryPatch.reviewReason = "interrupted";
			} else if (doneReason === "error") {
				summaryPatch.state = "failed";
				summaryPatch.reviewReason = "error";
			} else {
				summaryPatch.state = "awaiting_review";
				summaryPatch.reviewReason = "hook";
			}

			entry.activeAssistantMessageId = null;
			entry.activeReasoningMessageId = null;
			entry.toolMessageIdByToolCallId.clear();
			entry.toolInputByToolCallId.clear();

			const summary = updateSummary(entry, summaryPatch);
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_start" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "reasoning"
		) {
			const reasoning =
				"reasoning" in event.payload.event && typeof event.payload.event.reasoning === "string"
					? event.payload.event.reasoning
					: null;
			if (reasoning && reasoning.length > 0) {
				this.appendReasoningChunk(entry, taskId, reasoning);
				const summary = updateSummary(entry, {
					state: "running",
					lastOutputAt: now(),
				});
				this.emitSummary(summary);
			}
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_end" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "reasoning"
		) {
			const reasoning =
				"reasoning" in event.payload.event && typeof event.payload.event.reasoning === "string"
					? event.payload.event.reasoning
					: null;
			if (reasoning && !this.setOrCreateReasoningMessage(entry, taskId, reasoning)) {
				const reasoningMessage = createMessageWithMeta(taskId, "reasoning", reasoning, {
					streamType: "reasoning",
				});
				entry.messages.push(reasoningMessage);
				this.emitMessage(taskId, reasoningMessage);
			}
			entry.activeReasoningMessageId = null;
			const summary = updateSummary(entry, {
				lastOutputAt: now(),
			});
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_start" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "tool"
		) {
			const toolName =
				"toolName" in event.payload.event && typeof event.payload.event.toolName === "string"
					? event.payload.event.toolName
					: null;
			const toolCallId =
				"toolCallId" in event.payload.event && typeof event.payload.event.toolCallId === "string"
					? event.payload.event.toolCallId
					: null;
			const toolInput = "input" in event.payload.event ? event.payload.event.input : undefined;
			const isUserAttentionTool = isClineUserAttentionTool(toolName);
			this.startToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				input: toolInput,
			});
			const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: toolName ? `Using ${toolName}` : "Using tool",
					toolName,
					finalMessage: null,
					hookEventName: "tool_call",
					notificationType: isUserAttentionTool ? "user_attention" : null,
					source: "cline-sdk",
				},
			};
			if (isUserAttentionTool && entry.summary.state === "running") {
				summaryPatch.state = "awaiting_review";
				summaryPatch.reviewReason = "hook";
			} else if (!isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
				summaryPatch.state = "running";
				summaryPatch.reviewReason = null;
			}
			const summary = updateSummary(entry, summaryPatch);
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_end" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "tool"
		) {
			const toolName =
				"toolName" in event.payload.event && typeof event.payload.event.toolName === "string"
					? event.payload.event.toolName
					: null;
			const toolCallId =
				"toolCallId" in event.payload.event && typeof event.payload.event.toolCallId === "string"
					? event.payload.event.toolCallId
					: null;
			const toolOutput = "output" in event.payload.event ? event.payload.event.output : undefined;
			const toolError =
				"error" in event.payload.event && typeof event.payload.event.error === "string"
					? event.payload.event.error
					: null;
			const durationMs =
				"durationMs" in event.payload.event && typeof event.payload.event.durationMs === "number"
					? event.payload.event.durationMs
					: null;
			const isUserAttentionTool = isClineUserAttentionTool(toolName);
			this.finishToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				output: toolOutput,
				error: toolError,
				durationMs,
			});
			const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: toolError
						? toolName
							? `Failed ${toolName}`
							: "Failed tool"
						: toolName
							? `Completed ${toolName}`
							: "Completed tool",
					toolName,
					finalMessage: null,
					hookEventName: "tool_result",
					notificationType: null,
					source: "cline-sdk",
				},
			};
			if (isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
				summaryPatch.state = "running";
				summaryPatch.reviewReason = null;
			}
			const summary = updateSummary(entry, summaryPatch);
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "agent_event" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"event" in event.payload &&
			event.payload.event &&
			typeof event.payload.event === "object" &&
			"type" in event.payload.event &&
			event.payload.event.type === "content_end" &&
			"contentType" in event.payload.event &&
			event.payload.event.contentType === "text"
		) {
			const text =
				"text" in event.payload.event && typeof event.payload.event.text === "string"
					? event.payload.event.text
					: null;
			if (text && !this.setOrCreateAssistantMessage(entry, taskId, text)) {
				const agentMessage = createMessage(taskId, "assistant", text);
				entry.messages.push(agentMessage);
				this.emitMessage(taskId, agentMessage);
			}
			entry.activeAssistantMessageId = null;
			const summary = updateSummary(entry, {
				lastOutputAt: now(),
			});
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "chunk" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"stream" in event.payload &&
			event.payload.stream === "agent" &&
			"chunk" in event.payload &&
			typeof event.payload.chunk === "string"
		) {
			const chunk = event.payload.chunk;
			if (chunk.length === 0) {
				return;
			}
			if (isLikelySerializedAgentEventChunk(chunk)) {
				return;
			}
			this.appendAssistantChunk(entry, taskId, chunk);
			const summary = updateSummary(entry, {
				state: "running",
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					finalMessage: null,
					hookEventName: "assistant_delta",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "hook" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object"
		) {
			const hookEventName =
				"hookEventName" in event.payload && typeof event.payload.hookEventName === "string"
					? event.payload.hookEventName
					: null;
			const toolName =
				"toolName" in event.payload && typeof event.payload.toolName === "string"
					? event.payload.toolName
					: null;
			const activityText = hookEventName && toolName ? `${hookEventName}: ${toolName}` : hookEventName;
			const summary = updateSummary(entry, {
				lastHookAt: now(),
				latestHookActivity: {
					activityText,
					toolName,
					finalMessage: null,
					hookEventName,
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "ended" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"reason" in event.payload &&
			typeof event.payload.reason === "string"
		) {
			const interrupted =
				event.payload.reason.includes("abort") || event.payload.reason.includes("interrupt");
			if (interrupted && this.pendingTurnCancelTaskIds.has(taskId)) {
				this.pendingTurnCancelTaskIds.delete(taskId);
				entry.activeAssistantMessageId = null;
				entry.activeReasoningMessageId = null;
				entry.toolMessageIdByToolCallId.clear();
				entry.toolInputByToolCallId.clear();
				const canceledSummary = updateSummary(entry, {
					state: "idle",
					reviewReason: null,
					lastOutputAt: now(),
					lastHookAt: now(),
					latestHookActivity: {
						activityText: "Turn canceled",
						toolName: null,
						finalMessage: null,
						hookEventName: "turn_canceled",
						notificationType: null,
						source: "cline-sdk",
					},
				});
				this.emitSummary(canceledSummary);
				return;
			}
			const summary = updateSummary(entry, {
				state: interrupted ? "interrupted" : "awaiting_review",
				reviewReason: interrupted ? "interrupted" : "exit",
				lastOutputAt: now(),
			});
			entry.activeAssistantMessageId = null;
			entry.activeReasoningMessageId = null;
			entry.toolMessageIdByToolCallId.clear();
			entry.toolInputByToolCallId.clear();
			this.emitSummary(summary);
			return;
		}
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			event.type === "status" &&
			"payload" in event &&
			event.payload &&
			typeof event.payload === "object" &&
			"status" in event.payload &&
			typeof event.payload.status === "string"
		) {
			const summary = updateSummary(entry, {
				state: event.payload.status === "running" ? "running" : entry.summary.state,
				lastOutputAt: now(),
			});
			if (event.payload.status !== "running") {
				entry.activeAssistantMessageId = null;
				entry.activeReasoningMessageId = null;
				entry.toolMessageIdByToolCallId.clear();
				entry.toolInputByToolCallId.clear();
			}
			this.emitSummary(summary);
		}
	}

	private appendAssistantChunk(entry: ClineTaskSessionEntry, taskId: string, chunk: string): void {
		const existingMessageId = entry.activeAssistantMessageId;
		if (existingMessageId) {
			const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
				...currentMessage,
				content: `${currentMessage.content}${chunk}`,
			}));
			if (updatedMessage) {
				this.emitMessage(taskId, updatedMessage);
				return;
			}
		}
		const assistantMessage = createMessage(taskId, "assistant", chunk);
		entry.activeAssistantMessageId = assistantMessage.id;
		entry.messages.push(assistantMessage);
		this.emitMessage(taskId, assistantMessage);
	}

	private setOrCreateAssistantMessage(entry: ClineTaskSessionEntry, taskId: string, content: string): boolean {
		if (!entry.activeAssistantMessageId) {
			return false;
		}
		const updatedMessage = updateMessageInEntry(entry, entry.activeAssistantMessageId, (currentMessage) => ({
			...currentMessage,
			content,
		}));
		if (!updatedMessage) {
			return false;
		}
		this.emitMessage(taskId, updatedMessage);
		return true;
	}

	private appendReasoningChunk(entry: ClineTaskSessionEntry, taskId: string, chunk: string): void {
		const existingMessageId = entry.activeReasoningMessageId;
		if (existingMessageId) {
			const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
				...currentMessage,
				content: `${currentMessage.content}${chunk}`,
			}));
			if (updatedMessage) {
				this.emitMessage(taskId, updatedMessage);
				return;
			}
		}
		const reasoningMessage = createMessageWithMeta(taskId, "reasoning", chunk, {
			streamType: "reasoning",
		});
		entry.activeReasoningMessageId = reasoningMessage.id;
		entry.messages.push(reasoningMessage);
		this.emitMessage(taskId, reasoningMessage);
	}

	private setOrCreateReasoningMessage(entry: ClineTaskSessionEntry, taskId: string, content: string): boolean {
		if (!entry.activeReasoningMessageId) {
			return false;
		}
		const updatedMessage = updateMessageInEntry(entry, entry.activeReasoningMessageId, (currentMessage) => ({
			...currentMessage,
			content,
		}));
		if (!updatedMessage) {
			return false;
		}
		this.emitMessage(taskId, updatedMessage);
		return true;
	}

	private startToolCallMessage(
		entry: ClineTaskSessionEntry,
		taskId: string,
		input: {
			toolName: string | null;
			toolCallId: string | null;
			input: unknown;
		},
	): void {
		const toolContent = buildToolCallContent({
			toolName: input.toolName,
			input: input.input,
		});
		const message = createMessageWithMeta(taskId, "tool", toolContent, {
			toolName: input.toolName,
			hookEventName: "tool_call_start",
			toolCallId: input.toolCallId,
			streamType: "tool",
		});
		entry.messages.push(message);
		if (input.toolCallId) {
			entry.toolMessageIdByToolCallId.set(input.toolCallId, message.id);
			entry.toolInputByToolCallId.set(input.toolCallId, input.input);
		}
		this.emitMessage(taskId, message);
	}

	private finishToolCallMessage(
		entry: ClineTaskSessionEntry,
		taskId: string,
		input: {
			toolName: string | null;
			toolCallId: string | null;
			output: unknown;
			error: string | null;
			durationMs: number | null;
		},
	): void {
		const existingMessageId = input.toolCallId
			? entry.toolMessageIdByToolCallId.get(input.toolCallId) ?? null
			: null;
		const toolInput = input.toolCallId ? entry.toolInputByToolCallId.get(input.toolCallId) : undefined;
		const content = buildToolCallContent({
			toolName: input.toolName,
			input: toolInput,
			output: input.output,
			error: input.error,
			durationMs: input.durationMs,
		});
		if (existingMessageId) {
			const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
				...currentMessage,
				content,
				meta: {
					...(currentMessage.meta ?? {}),
					toolName: input.toolName,
					hookEventName: "tool_call_end",
					toolCallId: input.toolCallId,
					streamType: "tool",
				},
			}));
			if (updatedMessage) {
				if (input.toolCallId) {
					entry.toolMessageIdByToolCallId.delete(input.toolCallId);
					entry.toolInputByToolCallId.delete(input.toolCallId);
				}
				this.emitMessage(taskId, updatedMessage);
				return;
			}
		}
		const message = createMessageWithMeta(taskId, "tool", content, {
			toolName: input.toolName,
			hookEventName: "tool_call_end",
			toolCallId: input.toolCallId,
			streamType: "tool",
		});
		if (input.toolCallId) {
			entry.toolMessageIdByToolCallId.delete(input.toolCallId);
			entry.toolInputByToolCallId.delete(input.toolCallId);
		}
		entry.messages.push(message);
		this.emitMessage(taskId, message);
	}
}

export function createInMemoryClineTaskSessionService(): ClineTaskSessionService {
	return new InMemoryClineTaskSessionService();
}
