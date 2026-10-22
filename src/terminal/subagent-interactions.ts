import {
	canSummaryHoldSubagentInteractions,
	getWaitingSubagentInteraction,
	MAX_RUNTIME_TASK_SUBAGENT_INTERACTIONS,
	MAX_RUNTIME_TASK_SUBAGENT_TOOL_CANDIDATES,
	type RuntimeTaskInteractionResponseKind,
	type RuntimeTaskOutstandingInteraction,
	type RuntimeTaskSessionSummary,
	type RuntimeTaskSubagentInteraction,
} from "../core";
import type { ProviderHookSessionTransitionEvent, SessionTransitionResult } from "./session-state-machine";

// Claude renders a subagent's permission, question, or elicitation prompt in
// the main TUI and blocks on the person, while the foreground turn and other
// subagents keep running. Codex likewise surfaces a thread-spawned subagent's
// approval in the main TUI. Waits live in `subagentInteractions`, keyed by
// `agent_id`; one subagent may queue several prompts from parallel tools. These
// waits make the task Needs Input through the shared classifier but never
// author foreground state, the foreground interaction, native work evidence,
// hook activity, or completion summaries.

type SubagentWait = RuntimeTaskSubagentInteraction;

function normalized(value: string | null | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function identity(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

function conflicts(left: string | null, right: string | null): boolean {
	return left !== null && right !== null && normalized(left) !== normalized(right);
}

/** The subagent identity of a Claude or Codex hook, or null for foreground and other providers. */
export function getSubagentId(event: ProviderHookSessionTransitionEvent): string | null {
	const source = normalized(event.metadata?.source);
	return source === "claude" || source === "codex" ? identity(event.metadata?.providerAgentId) : null;
}

function preserved(): SessionTransitionResult {
	return { changed: false, patch: {}, clearAttentionBuffer: false, hookMetadataMode: "preserve" };
}

/** Accepted subagent hooks advance only the in-memory subagent ordering domain. */
function observed(): SessionTransitionResult {
	return { ...preserved(), hookOrderingMode: "advance" };
}

function withSubagentInteractions(interactions: SubagentWait[]): SessionTransitionResult {
	return {
		changed: true,
		patch: { subagentInteractions: interactions },
		clearAttentionBuffer: false,
		hookMetadataMode: "preserve",
		hookOrderingMode: "advance",
	};
}

/**
 * Sorts waits oldest first and enforces the cap. Answered waits no longer
 * block the person, so they are evicted before any waiting prompt.
 */
function capInteractions(interactions: readonly SubagentWait[]): SubagentWait[] {
	const sorted = [...interactions].sort((left, right) => left.openedAt - right.openedAt);
	while (sorted.length > MAX_RUNTIME_TASK_SUBAGENT_INTERACTIONS) {
		const answered = sorted.findIndex((interaction) => interaction.status !== "waiting");
		sorted.splice(answered >= 0 ? answered : 0, 1);
	}
	return sorted;
}

function replaceInteraction(
	interactions: readonly SubagentWait[],
	previous: SubagentWait,
	next: SubagentWait,
): SubagentWait[] {
	return capInteractions([...interactions.filter((interaction) => interaction !== previous), next]);
}

function candidateIds(wait: SubagentWait): readonly string[] {
	return wait.candidateToolUseIds ?? [];
}

/** Binds a wait to one tool, dropping the candidate list it was narrowed from. */
function bindTool(wait: SubagentWait, toolUseId: string): SubagentWait {
	const { candidateToolUseIds: _candidates, ...bound } = wait;
	return { ...bound, toolUseId };
}

/**
 * Whether an incoming request is a later signal for an existing wait (for
 * example the PermissionRequest that follows Claude's AskUserQuestion
 * PreToolUse). Identity is required: two uncorrelated requests from one
 * subagent are separate queued prompts.
 */
function isSameRequest(current: SubagentWait, incoming: SubagentWait): boolean {
	if (current.kind !== incoming.kind) return false;
	if (current.toolUseId && incoming.toolUseId) return current.toolUseId === incoming.toolUseId;
	if (current.elicitationId && incoming.elicitationId) return current.elicitationId === incoming.elicitationId;
	if (current.toolUseId) return candidateIds(incoming).includes(current.toolUseId);
	if (incoming.toolUseId) return candidateIds(current).includes(incoming.toolUseId);
	return false;
}

function buildWait(
	request: RuntimeTaskOutstandingInteraction,
	agentId: string,
	event: ProviderHookSessionTransitionEvent,
): SubagentWait {
	const candidates = request.toolUseId ? [] : [...(event.subagentToolUseCandidates ?? [])];
	return {
		...request,
		providerAgentId: agentId,
		...(candidates.length > 1
			? { candidateToolUseIds: candidates.slice(-MAX_RUNTIME_TASK_SUBAGENT_TOOL_CANDIDATES) }
			: {}),
	};
}

function openRequest(interactions: readonly SubagentWait[], agentId: string, incoming: SubagentWait): SubagentWait[] {
	// A new prompt from this subagent supersedes the prompts the person already
	// answered before it opened; their own hooks may never arrive.
	const remaining = interactions.filter(
		(interaction) =>
			interaction.providerAgentId !== agentId ||
			interaction.status === "waiting" ||
			(interaction.responseSubmittedAt ?? interaction.updatedAt) > incoming.openedAt,
	);
	const current =
		remaining.find(
			(interaction) => interaction.providerAgentId === agentId && isSameRequest(interaction, incoming),
		) ?? null;
	if (!current) return capInteractions([...remaining, incoming]);
	const merged: SubagentWait = {
		...current,
		updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
		elicitationId: current.elicitationId ?? incoming.elicitationId,
		promptId: current.promptId ?? incoming.promptId,
		turnId: current.turnId ?? incoming.turnId,
		toolName: current.toolName ?? incoming.toolName,
	};
	const toolUseId = current.toolUseId ?? incoming.toolUseId;
	return replaceInteraction(remaining, current, toolUseId ? bindTool(merged, toolUseId) : merged);
}

function isToolCompletion(hookEventName: string, codex: boolean): boolean {
	return codex
		? hookEventName === "posttooluse"
		: hookEventName === "posttooluse" ||
				hookEventName === "posttoolusefailure" ||
				hookEventName === "permissiondenied";
}

/** Each open prompt blocks a distinct open tool; drop prompts that cannot still be open. */
function dropSurplusSharingCandidates(waits: readonly SubagentWait[]): SubagentWait[] {
	const groups = new Map<string, { openTools: number; waits: SubagentWait[] }>();
	for (const wait of waits) {
		const candidates = wait.toolUseId ? [wait.toolUseId] : [...candidateIds(wait)];
		if (candidates.length === 0) continue;
		const key = JSON.stringify(candidates.sort());
		const group = groups.get(key) ?? { openTools: candidates.length, waits: [] };
		group.waits.push(wait);
		groups.set(key, group);
	}
	const surplus = new Set<SubagentWait>();
	for (const group of groups.values()) {
		// Answered prompts resolved first; otherwise the oldest prompt was shown first.
		const ordered = [...group.waits].sort(
			(left, right) =>
				Number(left.status === "waiting") - Number(right.status === "waiting") || left.openedAt - right.openedAt,
		);
		for (const wait of ordered.slice(0, Math.max(0, ordered.length - group.openTools))) surplus.add(wait);
	}
	return waits.filter((wait) => !surplus.has(wait));
}

/**
 * A completed tool resolves the wait bound to it. A wait narrowed only to
 * several open sibling tools stays open until every candidate has completed
 * (so a sibling that needed no approval cannot clear it); when fewer candidates
 * remain open than prompts sharing them, the surplus must have resolved. A wait
 * with no tool identity at all resolves on the first later compatible
 * completion from its subagent.
 */
function applyToolCompletion(
	agentWaits: readonly SubagentWait[],
	event: ProviderHookSessionTransitionEvent,
): SubagentWait[] {
	const toolUseId = identity(event.metadata?.toolUseId);
	let matched = false;
	const next: SubagentWait[] = [];
	for (const wait of agentWaits) {
		if (wait.toolUseId) {
			if (wait.toolUseId === toolUseId) matched = true;
			else next.push(wait);
			continue;
		}
		const candidates = candidateIds(wait);
		if (!toolUseId || !candidates.includes(toolUseId)) {
			next.push(wait);
			continue;
		}
		matched = true;
		const remaining = candidates.filter((candidate) => candidate !== toolUseId);
		const [only] = remaining;
		if (remaining.length === 1 && only) next.push(bindTool(wait, only));
		else if (remaining.length > 1) next.push({ ...wait, candidateToolUseIds: remaining });
	}
	if (matched) return dropSurplusSharingCandidates(next);
	const occurredAt = event.occurredAt;
	const toolName = identity(event.metadata?.toolName);
	const identityFree = next.find(
		(wait) =>
			wait.kind !== "elicitation" &&
			!wait.toolUseId &&
			candidateIds(wait).length === 0 &&
			occurredAt !== undefined &&
			occurredAt > wait.openedAt &&
			!conflicts(wait.toolName, toolName),
	);
	return identityFree ? next.filter((wait) => wait !== identityFree) : next;
}

/** A delayed PreToolUse that preceded an uncorrelated request supplies or widens its tool identity. */
function applyDelayedRequestTool(
	agentWaits: readonly SubagentWait[],
	event: ProviderHookSessionTransitionEvent,
): SubagentWait[] {
	const toolUseId = identity(event.metadata?.toolUseId);
	const occurredAt = event.occurredAt;
	if (!toolUseId || occurredAt === undefined) return [...agentWaits];
	return agentWaits.map((wait) => {
		if (wait.toolUseId || occurredAt > wait.openedAt) return wait;
		if (conflicts(wait.toolName, identity(event.metadata?.toolName))) return wait;
		if (conflicts(wait.turnId, identity(event.metadata?.turnId))) return wait;
		const candidates = candidateIds(wait);
		if (candidates.includes(toolUseId)) return wait;
		if (candidates.length === 0) return { ...wait, toolUseId };
		return {
			...wait,
			candidateToolUseIds: [...candidates, toolUseId].slice(-MAX_RUNTIME_TASK_SUBAGENT_TOOL_CANDIDATES),
		};
	});
}

/**
 * Whether a later hook proves the subagent moved past an earlier prompt: its
 * SubagentStop, a later Codex turn, or the start of a tool that was not open
 * when it asked. Codex emits no hook for a denial, so the next tool also
 * retires an unanswered Codex wait.
 */
function movedPast(wait: SubagentWait, event: ProviderHookSessionTransitionEvent, codex: boolean): boolean {
	const hookEventName = normalized(event.metadata?.hookEventName);
	if (hookEventName === "subagentstop") return true;
	const occurredAt = event.occurredAt;
	if (occurredAt === undefined || occurredAt <= wait.openedAt) return false;
	const turnId = identity(event.metadata?.turnId);
	if (codex && turnId && wait.turnId && turnId !== wait.turnId) return true;
	const toolUseId = identity(event.metadata?.toolUseId);
	return (
		hookEventName === "pretooluse" &&
		toolUseId !== null &&
		toolUseId !== wait.toolUseId &&
		!candidateIds(wait).includes(toolUseId)
	);
}

function applyElicitationResult(
	agentWaits: readonly SubagentWait[],
	event: ProviderHookSessionTransitionEvent,
): SubagentWait[] {
	const elicitationId = identity(event.metadata?.elicitationId);
	const occurredAt = event.occurredAt;
	const target = agentWaits.find(
		(wait) =>
			wait.kind === "elicitation" &&
			(wait.elicitationId && elicitationId
				? wait.elicitationId === elicitationId
				: occurredAt !== undefined && occurredAt > wait.openedAt),
	);
	return target ? agentWaits.filter((wait) => wait !== target) : [...agentWaits];
}

function sameWaits(left: readonly SubagentWait[], right: readonly SubagentWait[]): boolean {
	return left.length === right.length && left.every((wait, index) => wait === right[index]);
}

/**
 * Reduces a Claude or Codex hook carrying `agent_id`. `request` is the
 * interaction the hook would open (built by the shared reducer), or null for
 * other hooks.
 */
export function reduceSubagentHook(
	summary: RuntimeTaskSessionSummary,
	event: ProviderHookSessionTransitionEvent,
	request: RuntimeTaskOutstandingInteraction | null,
): SessionTransitionResult {
	const agentId = getSubagentId(event);
	// Replayed hooks describe a process whose prompts no longer exist.
	if (!agentId || event.sessionEvidence !== "live") return preserved();
	const hookEventName = normalized(event.metadata?.hookEventName);
	// Notifications duplicate native lifecycle events and carry no identity.
	if (hookEventName === "notification") return preserved();
	const codex = normalized(event.metadata?.source) === "codex";
	// A child inherits the launch's reviewer. Only an explicit user reviewer
	// proves a Codex request reached the person; otherwise it is ordering-only
	// and the rendered approval overlay must establish the wait.
	if (codex && request && event.codexPermissionRequiresRenderedPrompt === true) return observed();
	const interactions = summary.subagentInteractions ?? [];
	if (request) {
		if (!canSummaryHoldSubagentInteractions(summary)) return observed();
		return withSubagentInteractions(openRequest(interactions, agentId, buildWait(request, agentId, event)));
	}
	const agentWaits = interactions.filter((interaction) => interaction.providerAgentId === agentId);
	if (agentWaits.length === 0) return observed();
	let next = hookEventName === "pretooluse" ? applyDelayedRequestTool(agentWaits, event) : [...agentWaits];
	next = next.filter((wait) => !movedPast(wait, event, codex));
	if (isToolCompletion(hookEventName, codex)) next = applyToolCompletion(next, event);
	else if (!codex && hookEventName === "elicitationresult") next = applyElicitationResult(next, event);
	if (sameWaits(next, agentWaits)) return observed();
	const others = interactions.filter((interaction) => interaction.providerAgentId !== agentId);
	return withSubagentInteractions(capInteractions([...others, ...next]));
}

/**
 * Claude and Codex answer queued prompts of one kind oldest first. A direct
 * response belongs to the oldest unanswered wait of the foreground's dialog
 * kind; a subagent prompt of a different kind cannot absorb an answer meant for
 * the foreground dialog.
 */
export function resolveInteractionResponseTarget(
	summary: RuntimeTaskSessionSummary,
	foreground: RuntimeTaskOutstandingInteraction | null,
): RuntimeTaskOutstandingInteraction | null {
	const waitingForeground = foreground?.status === "waiting" ? foreground : null;
	const subagent = getWaitingSubagentInteraction(summary);
	if (!subagent) return waitingForeground;
	if (!waitingForeground) return subagent;
	if (subagent.kind !== waitingForeground.kind) return waitingForeground;
	return subagent.openedAt < waitingForeground.openedAt ? subagent : waitingForeground;
}

/**
 * The other unanswered wait, foreground or subagent, that a direct response
 * might have answered instead of the routed target. Callers fence its delayed
 * requests too, conservatively.
 */
export function resolveAlternateInteractionResponseTarget(
	summary: RuntimeTaskSessionSummary,
	foreground: RuntimeTaskOutstandingInteraction | null,
): RuntimeTaskOutstandingInteraction | null {
	const target = resolveInteractionResponseTarget(summary, foreground);
	if (!target) return null;
	const waitingForeground = foreground?.status === "waiting" ? foreground : null;
	return target === waitingForeground ? getWaitingSubagentInteraction(summary) : waitingForeground;
}

/**
 * Marks the subagent wait that a direct response answered, or returns null when
 * the response belongs to the foreground. Like the foreground, this records only
 * that input reached the PTY; the subagent's later hooks retire the wait.
 */
export function reduceSubagentInteractionResponse(
	summary: RuntimeTaskSessionSummary,
	foreground: RuntimeTaskOutstandingInteraction | null,
	responseKind: Exclude<RuntimeTaskInteractionResponseKind, "provider_denied">,
	occurredAt: number,
): SessionTransitionResult | null {
	const target = resolveInteractionResponseTarget(summary, foreground);
	const interactions = summary.subagentInteractions ?? [];
	const current = target && target !== foreground ? interactions.find((wait) => wait === target) : undefined;
	if (!current) return null;
	const answered: SubagentWait = {
		...current,
		status: "response_submitted",
		updatedAt: occurredAt,
		responseSubmittedAt: occurredAt,
		responseKind,
	};
	return {
		changed: true,
		patch: { subagentInteractions: replaceInteraction(interactions, current, answered) },
		clearAttentionBuffer: false,
	};
}
