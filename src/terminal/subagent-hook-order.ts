import type { RuntimeHookIngestRequest } from "../core";

// Hooks carrying agent_id come from subagents (Claude subagents and Codex
// thread-spawned agents) running beside the foreground conversation. Each
// provider applies its own foreground fences first (Claude prompt fences;
// Codex foreground session scope). Everything here is keyed per subagent so a
// subagent can neither borrow nor clear foreground correlation. This state is
// launch-scoped and in-memory: subagent prompts die with their process, so
// restart reconstruction never needs it and durable receipts never carry it.
const TRACKED_TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED_ENTRIES = 512;

interface SubagentToolUseObservation {
	agentId: string;
	/** Claude `prompt_id` or the Codex subagent's own `turn_id`. */
	scopeId: string | null;
	toolName: string | null;
	occurredAt: number;
}

export interface SubagentHookOrderState {
	/** PreToolUse identities awaiting a matching completion, per subagent. */
	pendingToolUses: Map<string, SubagentToolUseObservation>;
	/** Completed tool identities retained to reject delayed requests. */
	completedToolUses: Map<string, SubagentToolUseObservation>;
	/** Latest direct user answer to each subagent's prompt. */
	userSubmissionAt: Map<string, number>;
	/** SubagentStop occurrence time; a stopped subagent cannot reopen a prompt. */
	stoppedAt: Map<string, number>;
	completedElicitationIds: Map<string, number>;
	completedElicitationAt: Map<string, number>;
}

export type SubagentHookOrderRejectionReason =
	| "resolved_by_user_input"
	| "stale_observation"
	| "completed_tool"
	| "completed_interaction";

export function createSubagentHookOrderState(): SubagentHookOrderState {
	return {
		pendingToolUses: new Map(),
		completedToolUses: new Map(),
		userSubmissionAt: new Map(),
		stoppedAt: new Map(),
		completedElicitationIds: new Map(),
		completedElicitationAt: new Map(),
	};
}

function identity(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

function source(input: RuntimeHookIngestRequest): string {
	return input.metadata?.source?.trim().toLowerCase() ?? "";
}

/** The subagent identity of a Claude hook, or null for foreground and other providers. */
export function getClaudeSubagentHookAgentId(input: RuntimeHookIngestRequest): string | null {
	return source(input) === "claude" ? identity(input.metadata?.providerAgentId) : null;
}

/**
 * The thread-spawned subagent identity of a Codex hook, or null for foreground
 * and other providers. Codex reports the child thread id as `agent_id` and the
 * root session id as `session_id`.
 */
export function getCodexSubagentHookAgentId(input: RuntimeHookIngestRequest): string | null {
	return source(input) === "codex" ? identity(input.metadata?.providerAgentId) : null;
}

/** Subagent identity for any provider with subagent hooks. */
export function getSubagentHookAgentId(input: RuntimeHookIngestRequest): string | null {
	return getClaudeSubagentHookAgentId(input) ?? getCodexSubagentHookAgentId(input);
}

function hookName(input: RuntimeHookIngestRequest): string {
	return input.metadata?.hookEventName?.trim().toLowerCase() ?? "";
}

function toolName(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.toolName?.trim().toLowerCase() || null;
}

/** Claude scopes tools by prompt; a Codex subagent scopes them by its own turn. */
function scopeId(input: RuntimeHookIngestRequest): string | null {
	return source(input) === "codex" ? identity(input.metadata?.turnId) : identity(input.metadata?.promptId);
}

function opensInteraction(input: RuntimeHookIngestRequest): boolean {
	const name = hookName(input);
	const tool = toolName(input);
	return (
		name === "permissionrequest" ||
		name === "elicitation" ||
		(source(input) === "claude" && name === "pretooluse" && (tool === "askuserquestion" || tool === "exitplanmode"))
	);
}

function matchesToolObservation(
	observation: SubagentToolUseObservation,
	agentId: string,
	input: RuntimeHookIngestRequest,
): boolean {
	const scope = scopeId(input);
	const tool = toolName(input);
	return (
		observation.agentId === agentId &&
		(!scope || !observation.scopeId || scope === observation.scopeId) &&
		(!tool || !observation.toolName || tool === observation.toolName)
	);
}

function setLatest(entries: Map<string, number>, key: string, occurredAt: number): void {
	entries.set(key, Math.max(entries.get(key) ?? occurredAt, occurredAt));
}

function prune<T>(entries: Map<string, T>, reference: number, occurredAt: (value: T) => number): void {
	for (const [key, value] of entries) {
		if (reference - occurredAt(value) > TRACKED_TTL_MS) entries.delete(key);
	}
	while (entries.size > MAX_TRACKED_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (typeof oldest !== "string") break;
		entries.delete(oldest);
	}
}

/** Subagent-scoped admission after the provider's foreground fences accepted the hook. */
export function evaluateSubagentHookOrder(
	state: SubagentHookOrderState,
	input: RuntimeHookIngestRequest,
	agentId: string,
): { accepted: true } | { accepted: false; reason: SubagentHookOrderRejectionReason } {
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	const name = hookName(input);
	const stoppedAt = state.stoppedAt.get(agentId);
	if (stoppedAt !== undefined && occurredAt <= stoppedAt) {
		return { accepted: false, reason: "stale_observation" };
	}
	const answeredAt = state.userSubmissionAt.get(agentId);
	if (opensInteraction(input) && answeredAt !== undefined && occurredAt < answeredAt) {
		return { accepted: false, reason: "resolved_by_user_input" };
	}
	const toolUseId = identity(input.metadata?.toolUseId);
	if (toolUseId && state.completedToolUses.has(toolUseId)) {
		return { accepted: false, reason: "completed_tool" };
	}
	if (name === "permissionrequest") {
		for (const completed of state.completedToolUses.values()) {
			if (completed.occurredAt >= occurredAt && matchesToolObservation(completed, agentId, input)) {
				return { accepted: false, reason: "completed_tool" };
			}
		}
	}
	if (name === "elicitation") {
		const elicitationId = identity(input.metadata?.elicitationId);
		const completedAt = state.completedElicitationAt.get(agentId);
		if (
			(elicitationId && state.completedElicitationIds.has(elicitationId)) ||
			(completedAt !== undefined && occurredAt <= completedAt)
		) {
			return { accepted: false, reason: "completed_interaction" };
		}
	}
	return { accepted: true };
}

/** Records an accepted subagent hook without touching foreground prompt, turn, or tool ordering. */
export function commitSubagentHookOrder(
	state: SubagentHookOrderState,
	input: RuntimeHookIngestRequest,
	agentId: string,
	now = Date.now(),
): void {
	const occurredAt = input.delivery?.occurredAt ?? now;
	const name = hookName(input);
	const toolUseId = identity(input.metadata?.toolUseId);
	if (name === "pretooluse" && toolUseId) {
		state.pendingToolUses.set(toolUseId, {
			agentId,
			scopeId: scopeId(input),
			toolName: toolName(input),
			occurredAt,
		});
	} else if ((name === "posttooluse" || name === "posttoolusefailure" || name === "permissiondenied") && toolUseId) {
		const pending = state.pendingToolUses.get(toolUseId);
		state.pendingToolUses.delete(toolUseId);
		state.completedToolUses.set(toolUseId, {
			agentId,
			scopeId: pending?.scopeId ?? scopeId(input),
			toolName: pending?.toolName ?? toolName(input),
			occurredAt,
		});
	} else if (name === "subagentstop") {
		setLatest(state.stoppedAt, agentId, occurredAt);
		for (const [pendingToolUseId, pending] of state.pendingToolUses) {
			if (pending.agentId === agentId) state.pendingToolUses.delete(pendingToolUseId);
		}
	} else if (name === "elicitationresult") {
		const elicitationId = identity(input.metadata?.elicitationId);
		if (elicitationId) state.completedElicitationIds.set(elicitationId, occurredAt);
		setLatest(state.completedElicitationAt, agentId, occurredAt);
	}
	// Every retained value is a provider occurrence time; age it on that clock.
	prune(state.pendingToolUses, occurredAt, (observation) => observation.occurredAt);
	prune(state.completedToolUses, occurredAt, (observation) => observation.occurredAt);
	prune(state.userSubmissionAt, occurredAt, (recordedAt) => recordedAt);
	prune(state.stoppedAt, occurredAt, (recordedAt) => recordedAt);
	prune(state.completedElicitationIds, occurredAt, (recordedAt) => recordedAt);
	prune(state.completedElicitationAt, occurredAt, (recordedAt) => recordedAt);
}

/**
 * PermissionRequest omits tool_use_id for both providers. Its candidates are the
 * open PreToolUse identities from the same subagent and prompt or turn with a
 * compatible tool name; foreground tools and other subagents never qualify.
 */
export function subagentPermissionToolUseCandidates(
	state: SubagentHookOrderState,
	input: RuntimeHookIngestRequest,
	agentId: string,
): string[] {
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	const candidates: string[] = [];
	for (const [toolUseId, observation] of state.pendingToolUses) {
		if (observation.occurredAt <= occurredAt && matchesToolObservation(observation, agentId, input)) {
			candidates.push(toolUseId);
		}
	}
	return candidates;
}

/** Exactly one candidate binds the request; parallel same-name tools stay ambiguous. */
export function correlateSubagentPermissionToolUseId(
	state: SubagentHookOrderState,
	input: RuntimeHookIngestRequest,
	agentId: string,
): string | null {
	const candidates = subagentPermissionToolUseCandidates(state, input, agentId);
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * A direct answer to one subagent's prompt fences only that subagent's delayed
 * requests. Other subagents and the foreground may still have prompts queued
 * behind it.
 */
export function recordSubagentUserSubmission(
	state: SubagentHookOrderState,
	agentId: string,
	occurredAt: number,
	toolUseId: string | null,
): void {
	setLatest(state.userSubmissionAt, agentId, occurredAt);
	if (toolUseId) state.pendingToolUses.delete(toolUseId);
}
