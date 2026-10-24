import type {
	RuntimeHookIngestRequest,
	RuntimeTaskLocalForegroundInterrupt,
	RuntimeTaskOutstandingInteraction,
	RuntimeTaskProviderHookOrderObservation,
} from "../core";
import { isLaterSameProducerHookDelivery } from "../hook-delivery-order";
import { isCodexForegroundSessionStart } from "./codex-hook-session-scope";
import {
	commitSubagentHookOrder,
	correlateSubagentPermissionToolUseId,
	createSubagentHookOrderState,
	evaluateSubagentHookOrder,
	getClaudeSubagentHookAgentId,
	getCodexSubagentHookAgentId,
	getSubagentHookAgentId,
	recordSubagentUserSubmission,
	type SubagentHookOrderState,
	subagentPermissionToolUseCandidates,
} from "./subagent-hook-order";

// Provider identities and capture times fence launch-scoped foreground work.
// Transport startup time alone cannot distinguish an unseen old turn from a new one.
const TRACKED_ID_TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED_IDS = 512;

interface PendingPermission {
	turnId: string;
	toolName: string | null;
	toolUseId: string | null;
	occurredAt: number;
}

interface CodexToolUseObservation {
	turnId: string;
	toolName: string | null;
	occurredAt: number;
}

interface ClaudeToolUseObservation {
	promptId: string | null;
	toolName: string | null;
	occurredAt: number;
}

export interface HookEventOrderState {
	sessionInstanceId: string;
	/** Main Codex thread for this launch; /btw forks must not enter its ordering domain. */
	codexSessionId: string | null;
	codexSessionLatestOccurredAt: number | null;
	activePiRunId: string | null;
	activePiRunLatestOccurredAt: number | null;
	activePiRunCompleted: boolean;
	/** End/settlement capture identity, used only to prove an equal-time successor run. */
	activePiRunBoundaryDeliveryId: string | null;
	retiredPiRunIds: Map<string, number>;
	completedPiToolUseIds: Map<string, number>;
	activeTurnId: string | null;
	activeTurnLatestOccurredAt: number | null;
	activeTurnLatestCompactOccurredAt: number | null;
	activeTurnCompleted: boolean;
	latestCodexRootCompletionOccurredAt: number | null;
	pendingPermission: PendingPermission | null;
	latestUserSubmissionAt: number | null;
	retiredTurnIds: Map<string, number>;
	completedToolOccurredAt: Map<string, number>;
	/** PreToolUse identities awaiting a matching Codex completion. */
	codexPendingToolUses: Map<string, CodexToolUseObservation>;
	/** PreToolUse identities awaiting a matching Claude completion or denial. */
	claudePendingToolUses: Map<string, ClaudeToolUseObservation>;
	/** Completed Claude tool identities retained to reject delayed requests. */
	claudeCompletedToolUses: Map<string, ClaudeToolUseObservation>;
	activeClaudePromptId: string | null;
	/** Distinguishes an anonymous active prompt from the absence of foreground work. */
	claudeForegroundPromptActive: boolean;
	activeClaudePromptLatestOccurredAt: number | null;
	latestClaudeRootCompletionOccurredAt: number | null;
	retiredClaudePromptIds: Map<string, number>;
	completedClaudeElicitationIds: Map<string, number>;
	completedClaudeElicitationPromptOccurredAt: Map<string, number>;
	completedClaudeElicitationOccurredAt: number | null;
	/** The latest bare Escape written to Claude and the foreground prompt it targeted. */
	claudeInterruptKey: { promptId: string | null; occurredAt: number } | null;
	/** Claude visibly ended a turn on Escape; identity-free work hooks wait for a new prompt. */
	claudeAwaitingPromptAfterInterrupt: boolean;
	/** Prompts whose completed Stop left unbounded shell or monitor work that may wake them. */
	claudeUnboundedBackgroundPromptIds: Map<string, number>;
	claudeUnboundedBackgroundWorkWithoutPrompt: boolean;
	/** In-memory subagent tool/answer/stop identity; never mixed into foreground ordering. */
	subagents: SubagentHookOrderState;
	processedDeliveryIds: Map<string, number>;
	/** Local negative evidence, separate from a provider's terminal completion receipt. */
	foregroundInterrupt: RuntimeTaskLocalForegroundInterrupt | null;
}

export type HookEventOrderRejectionReason =
	| "duplicate_delivery"
	| "stale_session"
	| "non_foreground_session"
	| "stale_turn"
	| "stale_prompt"
	| "stale_observation"
	| "completed_turn"
	| "completed_prompt"
	| "completed_tool"
	| "completed_interaction"
	| "resolved_by_user_input"
	| "interrupted_prompt"
	| "interrupted_foreground"
	| "unrelated_tool_completion";

export type HookEventOrderDecision = { accepted: true } | { accepted: false; reason: HookEventOrderRejectionReason };

/**
 * Live ingest retains an unrelated tool completion as ordering-only evidence
 * even though it cannot author task state. Replay must apply the same rule so
 * restart reconstruction does not forget that the parallel tool completed.
 */
export function shouldRetainHookEventOrderObservation(decision: HookEventOrderDecision): boolean {
	return decision.accepted || decision.reason === "unrelated_tool_completion";
}

export function createHookEventOrderState(sessionInstanceId: string): HookEventOrderState {
	return {
		sessionInstanceId,
		codexSessionId: null,
		codexSessionLatestOccurredAt: null,
		activePiRunId: null,
		activePiRunLatestOccurredAt: null,
		activePiRunCompleted: false,
		activePiRunBoundaryDeliveryId: null,
		retiredPiRunIds: new Map(),
		completedPiToolUseIds: new Map(),
		activeTurnId: null,
		activeTurnLatestOccurredAt: null,
		activeTurnLatestCompactOccurredAt: null,
		activeTurnCompleted: false,
		latestCodexRootCompletionOccurredAt: null,
		pendingPermission: null,
		latestUserSubmissionAt: null,
		retiredTurnIds: new Map(),
		completedToolOccurredAt: new Map(),
		codexPendingToolUses: new Map(),
		claudePendingToolUses: new Map(),
		claudeCompletedToolUses: new Map(),
		activeClaudePromptId: null,
		claudeForegroundPromptActive: false,
		activeClaudePromptLatestOccurredAt: null,
		latestClaudeRootCompletionOccurredAt: null,
		retiredClaudePromptIds: new Map(),
		completedClaudeElicitationIds: new Map(),
		completedClaudeElicitationPromptOccurredAt: new Map(),
		completedClaudeElicitationOccurredAt: null,
		claudeInterruptKey: null,
		claudeAwaitingPromptAfterInterrupt: false,
		claudeUnboundedBackgroundPromptIds: new Map(),
		claudeUnboundedBackgroundWorkWithoutPrompt: false,
		subagents: createSubagentHookOrderState(),
		processedDeliveryIds: new Map(),
		foregroundInterrupt: null,
	};
}

function optionalIdentity(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

/**
 * Retains only the content-free identity needed by the ordering reducer. Hook
 * text, tool input, transcript paths, and provider output never enter durable
 * ordering history.
 */
export function createProviderHookOrderObservation(
	input: RuntimeHookIngestRequest,
): RuntimeTaskProviderHookOrderObservation | null {
	const source = input.metadata?.source?.trim().toLowerCase();
	const sessionInstanceId = optionalIdentity(input.metadata?.sessionInstanceId);
	if ((source !== "codex" && source !== "claude" && source !== "pi") || !sessionInstanceId || !input.delivery) {
		return null;
	}
	// Subagent identity is launch-scoped and absent from this schema; persisting
	// it would replay subagent hooks into the foreground domain after restart.
	if (getSubagentHookAgentId(input)) return null;
	return {
		event: input.event,
		deliveryId: input.delivery.id,
		occurredAt: input.delivery.occurredAt,
		source,
		sessionInstanceId,
		providerSessionId: optionalIdentity(input.metadata?.sessionId),
		sessionStartHasTranscript: Boolean(
			input.metadata?.transcriptPath?.trim() || input.metadata?.sessionStartHasTranscript,
		),
		...(input.metadata?.sessionStartSource ? { sessionStartSource: input.metadata.sessionStartSource } : undefined),
		hookEventName: optionalIdentity(input.metadata?.hookEventName),
		notificationType: optionalIdentity(input.metadata?.notificationType),
		turnId: optionalIdentity(input.metadata?.turnId),
		promptId: optionalIdentity(input.metadata?.promptId),
		toolUseId: optionalIdentity(input.metadata?.toolUseId),
		elicitationId: optionalIdentity(input.metadata?.elicitationId),
		toolName: optionalIdentity(input.metadata?.toolName),
		...(input.metadata?.unboundedBackgroundWorkPending ? { unboundedBackgroundWorkPending: true } : undefined),
	};
}

function observationAsHookInput(observation: RuntimeTaskProviderHookOrderObservation): RuntimeHookIngestRequest {
	return {
		taskId: "__ordering_restore__",
		projectId: "__ordering_restore__",
		event: observation.event,
		metadata: {
			source: observation.source,
			sessionInstanceId: observation.sessionInstanceId,
			sessionId: observation.providerSessionId,
			sessionStartHasTranscript: observation.sessionStartHasTranscript,
			sessionStartSource: observation.sessionStartSource,
			hookEventName: observation.hookEventName,
			notificationType: observation.notificationType,
			turnId: observation.turnId,
			promptId: observation.promptId,
			toolUseId: observation.toolUseId,
			elicitationId: observation.elicitationId,
			toolName: observation.toolName,
			unboundedBackgroundWorkPending: observation.unboundedBackgroundWorkPending,
		},
		delivery: {
			id: observation.deliveryId,
			occurredAt: observation.occurredAt,
		},
	};
}

const TOOL_ORDER_HOOK_EVENTS: ReadonlySet<string> = new Set([
	"pretooluse",
	"posttooluse",
	"posttoolusefailure",
	"toolexecutionstart",
	"toolexecutionend",
	"toolexecutionfailure",
]);

/**
 * The occurrence time at or before which every later Claude/Codex hook is
 * rejected by the root-completion fence. Claude Stops that leave unbounded
 * background work are skipped so that prompt's tool history stays intact.
 */
function rootCompletionFenceOccurredAt(observation: RuntimeTaskProviderHookOrderObservation): number | null {
	const hookEventName = observation.hookEventName?.toLowerCase() ?? "";
	if (observation.source === "claude") {
		return (hookEventName === "stop" || hookEventName === "stopfailure") &&
			observation.event === "to_review" &&
			!observation.unboundedBackgroundWorkPending
			? observation.occurredAt
			: null;
	}
	if (observation.source === "codex") {
		return isCodexTurnEnd(hookEventName) ? observation.occurredAt : null;
	}
	return null;
}

function isPiRunSettlement(observation: RuntimeTaskProviderHookOrderObservation): boolean {
	const hookEventName = observation.hookEventName?.toLowerCase() ?? "";
	return (
		observation.source === "pi" &&
		(hookEventName === "agentsettled" || hookEventName === "interrupt" || hookEventName === "stopfailure")
	);
}

function observationScopeId(observation: RuntimeTaskProviderHookOrderObservation): string | null {
	return observation.source === "claude" ? observation.promptId : observation.turnId;
}

/**
 * Any root completion ends a prompt/turn activation, including a Claude Stop
 * that leaves background work: a later wake re-activates the same prompt, and
 * replay must see that activation again for the next Stop to retire it.
 */
function endsScopeActivation(observation: RuntimeTaskProviderHookOrderObservation): boolean {
	const hookEventName = observation.hookEventName?.toLowerCase() ?? "";
	if (observation.source === "claude") {
		return (hookEventName === "stop" || hookEventName === "stopfailure") && observation.event === "to_review";
	}
	return observation.source === "codex" ? isCodexTurnEnd(hookEventName) : isPiRunSettlement(observation);
}

/**
 * Bounds durable ordering history while preserving replay's accept/reject
 * decisions. Codex/Pi tool observations behind a completed turn/run are
 * redundant. Claude may omit prompt_id on later hooks, so retain one receipt
 * per tool identity even behind Stop; otherwise a delayed identity-bearing
 * tool start could reopen that tool after hydration. Keep one observation per
 * prompt/turn activation too. Every retained receipt remains content-free and
 * subject to the same maxEntries cap.
 */
export function compactProviderHookOrderObservations(
	observations: readonly RuntimeTaskProviderHookOrderObservation[],
	maxEntries: number,
): RuntimeTaskProviderHookOrderObservation[] {
	let fenceOccurredAt: number | null = null;
	const settledPiRunIds = new Set<string>();
	const retainedScopeKeys = new Set<string>();
	const scopeKeys: Array<string | null> = [];
	const latestClaudeToolIndices = new Map<string, number>();
	let activation = 0;
	for (const [index, observation] of observations.entries()) {
		if (
			observation.source === "claude" &&
			observation.toolUseId &&
			TOOL_ORDER_HOOK_EVENTS.has(observation.hookEventName?.toLowerCase() ?? "")
		) {
			latestClaudeToolIndices.set(observation.toolUseId, index);
		}
		const fence = rootCompletionFenceOccurredAt(observation);
		if (fence !== null) fenceOccurredAt = Math.max(fenceOccurredAt ?? fence, fence);
		if (isPiRunSettlement(observation) && observation.turnId) settledPiRunIds.add(observation.turnId);
		const scopeId = observationScopeId(observation);
		const scopeKey = scopeId ? `${activation}:${scopeId}` : null;
		scopeKeys.push(scopeKey);
		if (scopeKey && !TOOL_ORDER_HOOK_EVENTS.has(observation.hookEventName?.toLowerCase() ?? "")) {
			retainedScopeKeys.add(scopeKey);
		}
		if (endsScopeActivation(observation)) activation += 1;
	}
	for (const index of latestClaudeToolIndices.values()) {
		const scopeKey = scopeKeys[index];
		if (scopeKey) retainedScopeKeys.add(scopeKey);
	}
	const compacted = observations.filter((observation, index) => {
		if (!TOOL_ORDER_HOOK_EVENTS.has(observation.hookEventName?.toLowerCase() ?? "")) return true;
		const fenced =
			observation.source === "pi"
				? observation.turnId !== null && settledPiRunIds.has(observation.turnId)
				: fenceOccurredAt !== null && observation.occurredAt <= fenceOccurredAt;
		if (!fenced) return true;
		if (
			observation.source === "claude" &&
			observation.toolUseId &&
			latestClaudeToolIndices.get(observation.toolUseId) === index
		) {
			return true;
		}
		const scopeKey = scopeKeys[index] ?? null;
		if (!scopeKey || retainedScopeKeys.has(scopeKey)) return false;
		retainedScopeKeys.add(scopeKey);
		return true;
	});
	return compacted.length > maxEntries ? compacted.slice(-maxEntries) : compacted;
}

/**
 * Hooks whose receipts close a tool or interaction. Replay uses them to reject
 * delayed requests (for example an outbox-replayed PermissionRequest), so they
 * must be durable before acknowledgement even when task meaning is unchanged.
 */
const COMPLETION_RECEIPT_HOOK_EVENTS: ReadonlySet<string> = new Set([
	"posttooluse",
	"posttoolusefailure",
	"permissiondenied",
	"permissionresolved",
	"projecttrustresolved",
	"projecttrustdenied",
	"toolexecutionend",
	"toolexecutionfailure",
	"elicitationresult",
]);

export function isDurableCompletionReceipt(input: RuntimeHookIngestRequest): boolean {
	return (
		COMPLETION_RECEIPT_HOOK_EVENTS.has(normalizedHookEventName(input)) &&
		createProviderHookOrderObservation(input) !== null
	);
}

/** Rebuilds the exact provider-specific ordering guard from durable metadata. */
export function restoreHookEventOrderState(input: {
	sessionInstanceId: string;
	observations: readonly RuntimeTaskProviderHookOrderObservation[];
	recentDeliveryIds: readonly string[];
	outstandingInteraction: RuntimeTaskOutstandingInteraction | null;
	providerSessionId?: string | null;
	localForegroundInterrupt?: RuntimeTaskLocalForegroundInterrupt | null;
}): HookEventOrderState {
	const state = createHookEventOrderState(input.sessionInstanceId);
	for (const observation of input.observations) {
		if (observation.sessionInstanceId !== input.sessionInstanceId) continue;
		const hookInput = observationAsHookInput(observation);
		if (!shouldRetainHookEventOrderObservation(evaluateHookEventOrder(state, hookInput))) continue;
		commitHookEventOrder(state, hookInput, { advanceTurn: true });
	}
	state.codexSessionId ??= input.providerSessionId ?? null;
	const interrupt = input.localForegroundInterrupt;
	if (interrupt?.sessionInstanceId === input.sessionInstanceId) {
		state.foregroundInterrupt = { ...interrupt, toolUseIds: [...interrupt.toolUseIds] };
		if (interrupt.provider === "claude") {
			// Apply only the tools captured at Ctrl-C, never newer anonymous tools
			// admitted by a later native prompt. Prior receipts remain native truth.
			for (const toolUseId of interrupt.toolUseIds) {
				const pending = state.claudePendingToolUses.get(toolUseId);
				state.claudePendingToolUses.delete(toolUseId);
				if (!state.claudeCompletedToolUses.has(toolUseId)) {
					state.claudeCompletedToolUses.set(toolUseId, {
						promptId: pending ? pending.promptId : interrupt.scopeId,
						toolName: pending?.toolName ?? null,
						occurredAt: Math.max(pending?.occurredAt ?? interrupt.occurredAt, interrupt.occurredAt),
					});
				}
			}
		}
	}
	const restoredAt = Date.now();
	for (const deliveryId of input.recentDeliveryIds) {
		state.processedDeliveryIds.set(deliveryId, restoredAt);
	}
	pruneTrackedIds(state.processedDeliveryIds, restoredAt);
	const interaction = input.outstandingInteraction;
	if (
		interaction?.sessionInstanceId === input.sessionInstanceId &&
		interaction.status !== "waiting" &&
		interaction.responseSubmittedAt !== null
	) {
		recordHookUserSubmission(state, interaction.responseSubmittedAt, interaction);
	}
	return state;
}

function pruneTrackedIds(entries: Map<string, number>, now: number): void {
	for (const [id, recordedAt] of entries) {
		if (now - recordedAt > TRACKED_ID_TTL_MS) {
			entries.delete(id);
		}
	}
	while (entries.size > MAX_TRACKED_IDS) {
		const oldest = entries.keys().next().value;
		if (typeof oldest !== "string") {
			break;
		}
		entries.delete(oldest);
	}
}

function capTrackedIds(entries: Map<string, number>): void {
	while (entries.size > MAX_TRACKED_IDS) {
		const oldest = entries.keys().next().value;
		if (typeof oldest !== "string") {
			break;
		}
		entries.delete(oldest);
	}
}

function pruneClaudeToolObservations(entries: Map<string, ClaudeToolUseObservation>, now: number): void {
	for (const [id, observation] of entries) {
		if (now - observation.occurredAt > TRACKED_ID_TTL_MS) entries.delete(id);
	}
	while (entries.size > MAX_TRACKED_IDS) {
		const oldest = entries.keys().next().value;
		if (typeof oldest !== "string") break;
		entries.delete(oldest);
	}
}

function pruneCodexToolObservations(entries: Map<string, CodexToolUseObservation>, now: number): void {
	for (const [id, observation] of entries) {
		if (now - observation.occurredAt > TRACKED_ID_TTL_MS) entries.delete(id);
	}
	while (entries.size > MAX_TRACKED_IDS) {
		const oldest = entries.keys().next().value;
		if (typeof oldest !== "string") break;
		entries.delete(oldest);
	}
}

function normalizedHookEventName(input: RuntimeHookIngestRequest): string {
	return input.metadata?.hookEventName?.trim().toLowerCase() ?? "";
}

function normalizedToolName(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.toolName?.trim().toLowerCase() || null;
}

/** Codex hooks that a thread-spawned subagent can emit with its own identity. */
const CODEX_SUBAGENT_LANE_HOOK_EVENTS: ReadonlySet<string> = new Set([
	"pretooluse",
	"permissionrequest",
	"posttooluse",
	"userpromptsubmit",
	"subagentstop",
]);

function isCodexInput(input: RuntimeHookIngestRequest): boolean {
	return input.metadata?.source?.trim().toLowerCase() === "codex";
}

function isCodexTurnEnd(hookEventName: string): boolean {
	return hookEventName === "stop" || hookEventName === "stopfailure" || hookEventName === "interrupt";
}

function isClaudeInput(input: RuntimeHookIngestRequest): boolean {
	return input.metadata?.source?.trim().toLowerCase() === "claude";
}

function isPiInput(input: RuntimeHookIngestRequest): boolean {
	return input.metadata?.source?.trim().toLowerCase() === "pi";
}

function evaluatePiHookEventOrder(state: HookEventOrderState, input: RuntimeHookIngestRequest): HookEventOrderDecision {
	const runId = input.metadata?.turnId?.trim() || null;
	const toolUseId = normalizedToolUseId(input);
	const hookEventName = normalizedHookEventName(input);
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	if (runId && state.retiredPiRunIds.has(runId)) {
		return { accepted: false, reason: "stale_turn" };
	}
	if (
		runId &&
		state.activePiRunId &&
		runId !== state.activePiRunId &&
		state.activePiRunLatestOccurredAt !== null &&
		occurredAt <= state.activePiRunLatestOccurredAt
	) {
		// Pi may immediately dequeue another run in the same millisecond as
		// agent_end or settlement. Only its captured producer ordinal proves
		// that succession; a timestamp tie or a tool event alone does not.
		const provenSuccessor =
			occurredAt === state.activePiRunLatestOccurredAt &&
			hookEventName === "agentstart" &&
			input.event === "to_in_progress" &&
			state.activePiRunBoundaryDeliveryId !== null &&
			input.delivery !== undefined &&
			isLaterSameProducerHookDelivery(input.delivery.id, state.activePiRunBoundaryDeliveryId);
		if (!provenSuccessor) return { accepted: false, reason: "stale_turn" };
	}
	if (runId && runId === state.activePiRunId && state.activePiRunCompleted) {
		return { accepted: false, reason: "completed_turn" };
	}
	if (toolUseId && state.completedPiToolUseIds.has(toolUseId)) {
		return { accepted: false, reason: "completed_tool" };
	}
	if (
		(hookEventName === "permissionrequest" || hookEventName === "projecttrustrequest") &&
		state.latestUserSubmissionAt !== null &&
		occurredAt < state.latestUserSubmissionAt
	) {
		return { accepted: false, reason: "resolved_by_user_input" };
	}
	return { accepted: true };
}

function normalizedPromptId(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.promptId?.trim() || null;
}

function normalizedToolUseId(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.toolUseId?.trim() || null;
}

function normalizedNotificationType(input: RuntimeHookIngestRequest): string {
	return input.metadata?.notificationType?.trim().toLowerCase() ?? "";
}

function normalizedElicitationId(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.elicitationId?.trim() || null;
}

function matchesClaudeToolObservation(observation: ClaudeToolUseObservation, input: RuntimeHookIngestRequest): boolean {
	const promptId = normalizedPromptId(input);
	const toolName = normalizedToolName(input);
	return (
		(!promptId || !observation.promptId || promptId === observation.promptId) &&
		(!toolName || !observation.toolName || toolName === observation.toolName)
	);
}

/**
 * PermissionRequest omits Claude's tool_use_id. Correlate it only when one
 * preceding, still-open PreToolUse has the same prompt and tool identity.
 * Ambiguity deliberately returns null so the reducer fails closed.
 */
export function correlateClaudePermissionToolUseId(
	state: HookEventOrderState | null,
	input: RuntimeHookIngestRequest,
): string | null {
	if (!state || !isClaudeInput(input) || normalizedHookEventName(input) !== "permissionrequest") {
		return null;
	}
	const subagentAgentId = getClaudeSubagentHookAgentId(input);
	if (subagentAgentId) {
		return correlateSubagentPermissionToolUseId(state.subagents, input, subagentAgentId);
	}
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	const candidates: string[] = [];
	for (const [toolUseId, observation] of state.claudePendingToolUses) {
		if (observation.occurredAt <= occurredAt && matchesClaudeToolObservation(observation, input)) {
			candidates.push(toolUseId);
		}
	}
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Open same-agent tools an uncorrelated subagent PermissionRequest may belong
 * to. Returns null for foreground hooks, other events, and other providers.
 */
export function getSubagentPermissionToolUseCandidates(
	state: HookEventOrderState | null,
	input: RuntimeHookIngestRequest,
): string[] | null {
	const agentId = getSubagentHookAgentId(input);
	if (!state || !agentId || normalizedHookEventName(input) !== "permissionrequest") return null;
	return subagentPermissionToolUseCandidates(state.subagents, input, agentId);
}

/**
 * Codex PermissionRequest omits the tool-use id even though the immediately
 * preceding PreToolUse and later PostToolUse carry it. Correlate only one
 * still-open candidate from the same turn and compatible tool name. Parallel
 * same-name tools are deliberately ambiguous and remain uncorrelated.
 */
export function correlateCodexPermissionToolUseId(
	state: HookEventOrderState | null,
	input: RuntimeHookIngestRequest,
): string | null {
	if (!state || !isCodexInput(input) || normalizedHookEventName(input) !== "permissionrequest") {
		return null;
	}
	const subagentAgentId = getCodexSubagentHookAgentId(input);
	if (subagentAgentId) {
		return correlateSubagentPermissionToolUseId(state.subagents, input, subagentAgentId);
	}
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) return null;
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	const toolName = normalizedToolName(input);
	const candidates: string[] = [];
	for (const [toolUseId, observation] of state.codexPendingToolUses) {
		if (
			observation.turnId === turnId &&
			observation.occurredAt <= occurredAt &&
			(!toolName || !observation.toolName || toolName === observation.toolName)
		) {
			candidates.push(toolUseId);
		}
	}
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function toolKey(turnId: string, toolName: string | null): string | null {
	return toolName ? JSON.stringify([turnId, toolName]) : null;
}

/**
 * Records a prompt submission observed directly at the task PTY. This is not
 * an agent-working heuristic: it only gives ordering a causal boundary for
 * hook events that occurred before the user's response but arrived later.
 */
export function recordHookUserSubmission(
	state: HookEventOrderState | null,
	occurredAt = Date.now(),
	interaction: RuntimeTaskOutstandingInteraction | null = null,
): void {
	if (!state) {
		return;
	}
	if ((interaction?.provider === "claude" || interaction?.provider === "codex") && interaction.providerAgentId) {
		recordSubagentUserSubmission(state.subagents, interaction.providerAgentId, occurredAt, interaction.toolUseId);
		return;
	}
	state.latestUserSubmissionAt = Math.max(state.latestUserSubmissionAt ?? occurredAt, occurredAt);
	// This only retires the ordering guard. Semantic state remains response-
	// pending until a current native provider hook confirms resumed work or a
	// completed turn. A delayed request older than this boundary is rejected.
	state.pendingPermission = null;
	if (interaction?.toolUseId) {
		// PermissionRequest omits tool_use_id for both providers. Once the user
		// answers the current permission, its preceding PreToolUse must no longer
		// be eligible to lend that identity to a later request in the same prompt
		// or turn—even when rejection/cancellation emits no completion hook.
		if (interaction.provider === "claude") {
			state.claudePendingToolUses.delete(interaction.toolUseId);
		} else if (interaction.provider === "codex") {
			state.codexPendingToolUses.delete(interaction.toolUseId);
		}
	}
}

type ForegroundHook = Pick<RuntimeHookIngestRequest, "event" | "metadata">;

function foregroundScopeId(input: ForegroundHook): string | null {
	return optionalIdentity(
		input.metadata?.source?.trim().toLowerCase() === "claude" ? input.metadata.promptId : input.metadata?.turnId,
	);
}

function isForegroundStart(input: ForegroundHook): boolean {
	const name = input.metadata?.hookEventName?.trim().toLowerCase();
	return input.metadata?.source?.trim().toLowerCase() === "pi" ? name === "agentstart" : name === "userpromptsubmit";
}

function isForegroundSettlement(input: ForegroundHook): boolean {
	if (input.event !== "to_review") return false;
	const name = input.metadata?.hookEventName?.trim().toLowerCase() ?? "";
	return name === "agentsettled" || isCodexTurnEnd(name);
}

function claudeBackgroundWakeExpected(state: HookEventOrderState, promptId: string | null): boolean {
	return promptId
		? state.claudeUnboundedBackgroundPromptIds.has(promptId)
		: state.claudeUnboundedBackgroundWorkWithoutPrompt;
}

function closeClaudePendingTools(state: HookEventOrderState, promptId: string | null, occurredAt: number): void {
	for (const [toolUseId, pending] of state.claudePendingToolUses) {
		if (pending.promptId && pending.promptId !== promptId) continue;
		state.claudePendingToolUses.delete(toolUseId);
		state.claudeCompletedToolUses.set(toolUseId, {
			...pending,
			occurredAt: Math.max(pending.occurredAt, occurredAt),
		});
	}
	pruneClaudeToolObservations(state.claudeCompletedToolUses, occurredAt);
}

/**
 * Ctrl-C closes the known foreground generation, not the provider session.
 * Keep native terminal settlement admissible and leave subagent lanes alone.
 * An unseen identity with a later capture time remains intrinsically ambiguous.
 */
export function recordForegroundInterrupt(
	state: HookEventOrderState | null,
	provider: string | null,
	occurredAt = Date.now(),
): void {
	if (!state || (provider !== "claude" && provider !== "codex" && provider !== "pi")) return;
	const scopeId = activeForegroundScopeId(state, provider);
	state.foregroundInterrupt = {
		sessionInstanceId: state.sessionInstanceId,
		provider,
		scopeId,
		occurredAt,
		toolUseIds:
			provider === "claude"
				? [...state.claudePendingToolUses]
						.filter(([, tool]) => !tool.promptId || tool.promptId === scopeId)
						.map(([toolUseId]) => toolUseId)
				: provider === "codex"
					? [...state.codexPendingToolUses.keys()]
					: [],
		awaitingNativeStart: true,
	};
	if (provider === "claude") closeClaudePendingTools(state, scopeId, occurredAt);
}

/** Also used by the controller so direct callers cannot bypass a local interrupt. */
export function evaluateForegroundInterruptOrder(
	state: HookEventOrderState | null,
	input: ForegroundHook & { occurredAt?: number },
): HookEventOrderDecision {
	const fence = state?.foregroundInterrupt;
	if (
		!state ||
		!fence ||
		(fence.provider !== "pi" && input.metadata?.providerAgentId?.trim()) ||
		input.metadata?.source?.trim().toLowerCase() !== fence.provider
	) {
		return { accepted: true };
	}
	const occurredAt = input.occurredAt;
	if (occurredAt === undefined || occurredAt <= fence.occurredAt) {
		return { accepted: false, reason: "stale_observation" };
	}
	const scopeId = foregroundScopeId(input);
	const backgroundWake = fence.provider === "claude" && claudeBackgroundWakeExpected(state, scopeId);
	// Local cancellation is not a synthetic Stop: the provider still owns its
	// first completion, error, or abort. Once newer native work superseded that
	// generation, its old completion cannot overwrite the newer owner either.
	if (isForegroundSettlement(input)) {
		if (
			!fence.awaitingNativeStart &&
			scopeId &&
			scopeId === fence.scopeId &&
			activeForegroundScopeId(state, fence.provider) !== scopeId &&
			!backgroundWake
		) {
			return { accepted: false, reason: "interrupted_foreground" };
		}
		return { accepted: true };
	}
	if (isForegroundNavigation(input, state.codexSessionId)) return { accepted: true };
	const toolUseId = optionalIdentity(input.metadata?.toolUseId);
	if (toolUseId && fence.toolUseIds.includes(toolUseId)) return { accepted: false, reason: "completed_tool" };
	if (!backgroundWake && scopeId && scopeId === fence.scopeId) {
		return { accepted: false, reason: "interrupted_foreground" };
	}
	if (!backgroundWake && !scopeId && fence.awaitingNativeStart && !isForegroundStart(input)) {
		return { accepted: false, reason: "interrupted_foreground" };
	}
	return { accepted: true };
}

function activeForegroundScopeId(
	state: HookEventOrderState,
	provider: RuntimeTaskLocalForegroundInterrupt["provider"],
): string | null {
	return provider === "claude"
		? state.activeClaudePromptId
		: provider === "codex"
			? state.activeTurnId
			: state.activePiRunId;
}

function isForegroundNavigation(input: ForegroundHook, providerSessionId: string | null | undefined): boolean {
	const incomingSessionId = optionalIdentity(input.metadata?.sessionId);
	return Boolean(
		providerSessionId &&
			incomingSessionId &&
			incomingSessionId !== providerSessionId &&
			isCodexForegroundSessionStart(input.metadata),
	);
}

/** Advance negative evidence only after the reducer admitted native evidence. */
export function advanceLocalForegroundInterrupt(
	interrupt: RuntimeTaskLocalForegroundInterrupt | null | undefined,
	input: ForegroundHook,
	providerSessionId: string | null | undefined,
): RuntimeTaskLocalForegroundInterrupt | null | undefined {
	if (
		!interrupt ||
		input.metadata?.providerAgentId?.trim() ||
		input.metadata?.source?.trim().toLowerCase() !== interrupt.provider
	)
		return interrupt;
	if (isForegroundNavigation(input, providerSessionId)) return null;
	const scopeId = foregroundScopeId(input);
	if (
		interrupt.awaitingNativeStart &&
		(isForegroundStart(input) || (scopeId && scopeId !== interrupt.scopeId && !isForegroundSettlement(input)))
	) {
		return { ...interrupt, awaitingNativeStart: false };
	}
	return interrupt;
}

/** Records a bare Escape written to Claude and the foreground prompt it can interrupt. */
export function recordClaudeInterruptKey(state: HookEventOrderState | null, occurredAt = Date.now()): void {
	if (!state) return;
	state.claudeInterruptKey = { promptId: state.activeClaudePromptId, occurredAt };
}

/**
 * True when Claude's rendered interruption still answers the latest Escape:
 * no foreground prompt was submitted or became active since that key.
 */
export function canApplyClaudeRenderedInterruption(state: HookEventOrderState | null): boolean {
	if (!state) return true;
	const key = state.claudeInterruptKey;
	return key !== null && key.promptId === state.activeClaudePromptId;
}

/**
 * Closes the interrupted Claude turn after Claude visibly reported it. Claude
 * emits no Stop for interrupts but may still deliver hooks for interrupted
 * tools (for example PostToolUseFailure); those tool identities become
 * completed, the prompt is retired, and identity-free work hooks are refused
 * until a new foreground prompt. A prompt that may be woken by unbounded
 * background work stays admissible and relies on the timestamp and tool fences.
 */
export function retireInterruptedClaudePrompt(state: HookEventOrderState | null, now = Date.now()): void {
	if (!state) return;
	const promptId = state.claudeInterruptKey?.promptId ?? state.activeClaudePromptId;
	state.claudeInterruptKey = null;
	closeClaudePendingTools(state, promptId, now);
	const backgroundWakeExpected = claudeBackgroundWakeExpected(state, promptId);
	if (backgroundWakeExpected) return;
	if (promptId) state.retiredClaudePromptIds.set(promptId, now);
	if (!promptId || state.activeClaudePromptId === promptId) {
		state.activeClaudePromptId = null;
		state.activeClaudePromptLatestOccurredAt = null;
		state.claudeForegroundPromptActive = false;
	}
	state.claudeAwaitingPromptAfterInterrupt = true;
}

function isClaudeInterruptedWorkHook(input: RuntimeHookIngestRequest, hookEventName: string): boolean {
	if (hookEventName === "userpromptsubmit" || input.metadata?.providerAgentId?.trim()) return false;
	return (
		input.event === "to_in_progress" ||
		hookEventName === "pretooluse" ||
		hookEventName === "posttooluse" ||
		hookEventName === "posttoolusefailure" ||
		hookEventName === "permissionrequest" ||
		hookEventName === "permissiondenied" ||
		hookEventName === "elicitation" ||
		hookEventName === "elicitationresult"
	);
}

export function evaluateHookEventOrder(
	state: HookEventOrderState | null,
	input: RuntimeHookIngestRequest,
): HookEventOrderDecision {
	const deliveryId = input.delivery?.id;
	if (deliveryId && state?.processedDeliveryIds.has(deliveryId)) {
		return { accepted: false, reason: "duplicate_delivery" };
	}

	const incomingSessionInstanceId = input.metadata?.sessionInstanceId?.trim() || null;
	if (incomingSessionInstanceId && (!state || incomingSessionInstanceId !== state.sessionInstanceId)) {
		return { accepted: false, reason: "stale_session" };
	}

	if (!state) {
		return { accepted: true };
	}
	const interruptOrder = evaluateForegroundInterruptOrder(state, { ...input, occurredAt: input.delivery?.occurredAt });
	if (!interruptOrder.accepted) return interruptOrder;
	if (isPiInput(input)) {
		return evaluatePiHookEventOrder(state, input);
	}
	if (!isCodexInput(input)) {
		if (!isClaudeInput(input)) {
			return { accepted: true };
		}
		const hookEventName = normalizedHookEventName(input);
		const promptId = normalizedPromptId(input);
		const toolUseId = normalizedToolUseId(input);
		const occurredAt = input.delivery?.occurredAt ?? Date.now();
		const toolName = normalizedToolName(input);
		const subagentAgentId = getClaudeSubagentHookAgentId(input);
		if (
			state.latestClaudeRootCompletionOccurredAt !== null &&
			occurredAt <= state.latestClaudeRootCompletionOccurredAt
		) {
			return { accepted: false, reason: "stale_observation" };
		}
		// Subagents share only the root-completion fence. A subagent may keep
		// working, and keep a wait open, after a new foreground prompt retires the
		// prompt that launched it; prompt retirement and interrupted-prompt fences
		// would otherwise reject the hooks that resolve that wait. Whether a wait may
		// open at all is decided by the reducer from the foreground lifecycle.
		if (subagentAgentId) return evaluateSubagentHookOrder(state.subagents, input, subagentAgentId);
		if (
			promptId &&
			state.claudeUnboundedBackgroundPromptIds.has(promptId) &&
			state.claudeForegroundPromptActive &&
			promptId !== state.activeClaudePromptId
		) {
			// A wake from an older background prompt cannot take ownership from a
			// newer foreground prompt, including one whose id Claude omitted.
			return { accepted: false, reason: "stale_prompt" };
		}
		if (
			(hookEventName === "stop" || hookEventName === "stopfailure") &&
			!promptId &&
			state.activeClaudePromptLatestOccurredAt !== null &&
			occurredAt <= state.activeClaudePromptLatestOccurredAt
		) {
			return { accepted: false, reason: "stale_prompt" };
		}
		const opensInteraction =
			hookEventName === "permissionrequest" ||
			hookEventName === "elicitation" ||
			(hookEventName === "pretooluse" && (toolName === "askuserquestion" || toolName === "exitplanmode"));
		if (opensInteraction && state.latestUserSubmissionAt !== null && occurredAt < state.latestUserSubmissionAt) {
			return { accepted: false, reason: "resolved_by_user_input" };
		}
		if (promptId && state.retiredClaudePromptIds.has(promptId)) {
			return { accepted: false, reason: "completed_prompt" };
		}
		if (state.claudeAwaitingPromptAfterInterrupt && !promptId && isClaudeInterruptedWorkHook(input, hookEventName)) {
			return { accepted: false, reason: "interrupted_prompt" };
		}
		if (
			promptId &&
			state.activeClaudePromptId &&
			promptId !== state.activeClaudePromptId &&
			state.activeClaudePromptLatestOccurredAt !== null &&
			occurredAt <= state.activeClaudePromptLatestOccurredAt
		) {
			return { accepted: false, reason: "stale_prompt" };
		}
		if (toolUseId) {
			const completed = state.claudeCompletedToolUses.get(toolUseId);
			if (completed) {
				return { accepted: false, reason: "completed_tool" };
			}
		}
		if (
			!promptId &&
			state.latestClaudeRootCompletionOccurredAt !== null &&
			!state.claudeUnboundedBackgroundWorkWithoutPrompt &&
			(hookEventName === "posttooluse" || hookEventName === "posttoolusefailure") &&
			(!toolUseId || !state.claudePendingToolUses.has(toolUseId))
		) {
			// A prompt-less completion cannot prove a new activation after Stop.
			// Require its native tool predecessor even if an older receipt was
			// evicted from the bounded history.
			return { accepted: false, reason: "completed_tool" };
		}
		if (hookEventName === "permissionrequest") {
			for (const completed of state.claudeCompletedToolUses.values()) {
				if (completed.occurredAt >= occurredAt && matchesClaudeToolObservation(completed, input)) {
					return { accepted: false, reason: "completed_tool" };
				}
			}
		}
		const notificationType = normalizedNotificationType(input);
		const elicitationId = normalizedElicitationId(input);
		if (
			hookEventName === "elicitation" ||
			notificationType === "elicitation_dialog" ||
			notificationType === "elicitation_url_dialog"
		) {
			if (elicitationId && state.completedClaudeElicitationIds.has(elicitationId)) {
				return { accepted: false, reason: "completed_interaction" };
			}
			const completedAt = promptId ? state.completedClaudeElicitationPromptOccurredAt.get(promptId) : undefined;
			if (
				(completedAt !== undefined && occurredAt <= completedAt) ||
				(state.completedClaudeElicitationOccurredAt !== null &&
					occurredAt <= state.completedClaudeElicitationOccurredAt)
			) {
				return { accepted: false, reason: "completed_interaction" };
			}
		}
		return { accepted: true };
	}
	const hookEventName = normalizedHookEventName(input);
	const occurredAt = input.delivery?.occurredAt ?? Date.now();
	const providerSessionId = optionalIdentity(input.metadata?.sessionId);
	const subagentAgentId = getCodexSubagentHookAgentId(input);
	if (subagentAgentId) {
		// Thread-spawned subagents report the root session id. Admit their tool,
		// approval, and turn hooks only into their per-agent lane, and only for the
		// known foreground session: /btw forks, their children, unverifiable scope,
		// and root-only events (Interrupt, Stop, SessionStart, compaction) stay
		// non-foreground. Root completion and turn fences do not apply because a
		// child keeps running, and may keep waiting on the person, after the root
		// turn ends.
		if (
			!CODEX_SUBAGENT_LANE_HOOK_EVENTS.has(hookEventName) ||
			!providerSessionId ||
			!state.codexSessionId ||
			providerSessionId !== state.codexSessionId
		) {
			return { accepted: false, reason: "non_foreground_session" };
		}
		return evaluateSubagentHookOrder(state.subagents, input, subagentAgentId);
	}
	if (providerSessionId && state.codexSessionId && providerSessionId !== state.codexSessionId) {
		// Native main-chat navigation can precede transcript materialization.
		// Ephemeral /btw forks lack both navigation source and transcript evidence.
		if (!isCodexForegroundSessionStart(input.metadata)) {
			return { accepted: false, reason: "non_foreground_session" };
		}
		return state.codexSessionLatestOccurredAt !== null && occurredAt <= state.codexSessionLatestOccurredAt
			? { accepted: false, reason: "stale_observation" }
			: { accepted: true };
	}
	if (state.latestCodexRootCompletionOccurredAt !== null && occurredAt <= state.latestCodexRootCompletionOccurredAt) {
		return { accepted: false, reason: "stale_observation" };
	}
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		if (
			hookEventName === "posttooluse" &&
			state.latestCodexRootCompletionOccurredAt !== null &&
			!state.codexPendingToolUses.has(normalizedToolUseId(input) ?? "")
		) {
			return { accepted: false, reason: "completed_tool" };
		}
		if (
			isCodexTurnEnd(hookEventName) &&
			state.activeTurnLatestOccurredAt !== null &&
			occurredAt <= state.activeTurnLatestOccurredAt
		) {
			return { accepted: false, reason: "stale_observation" };
		}
		return { accepted: true };
	}
	if (state.retiredTurnIds.has(turnId)) {
		return { accepted: false, reason: "stale_turn" };
	}

	const isActiveTurn = state.activeTurnId === turnId;
	if (
		state.activeTurnId &&
		!isActiveTurn &&
		state.activeTurnLatestOccurredAt !== null &&
		occurredAt <= state.activeTurnLatestOccurredAt
	) {
		return { accepted: false, reason: "stale_turn" };
	}
	if (isActiveTurn && state.activeTurnCompleted) {
		return { accepted: false, reason: "completed_turn" };
	}

	const toolName = normalizedToolName(input);
	if (
		(hookEventName === "precompact" || hookEventName === "postcompact") &&
		state.activeTurnLatestCompactOccurredAt !== null &&
		occurredAt < state.activeTurnLatestCompactOccurredAt
	) {
		return { accepted: false, reason: "stale_observation" };
	}
	// PermissionRequest does not expose tool_use_id. Canonical tool_name is the
	// strongest documented correlation it shares with PostToolUse.
	const currentToolKey = toolKey(turnId, toolName);
	const completedToolOccurredAt = currentToolKey ? state.completedToolOccurredAt.get(currentToolKey) : undefined;
	if (hookEventName === "permissionrequest") {
		if (state.latestUserSubmissionAt !== null && occurredAt < state.latestUserSubmissionAt) {
			return { accepted: false, reason: "resolved_by_user_input" };
		}
		if (completedToolOccurredAt !== undefined && occurredAt <= completedToolOccurredAt) {
			return { accepted: false, reason: "completed_tool" };
		}
		if (state.pendingPermission?.turnId === turnId && occurredAt < state.pendingPermission.occurredAt) {
			return { accepted: false, reason: "stale_observation" };
		}
	}

	const pendingPermission = state.pendingPermission?.turnId === turnId ? state.pendingPermission : null;
	if (hookEventName === "posttooluse") {
		if (completedToolOccurredAt !== undefined && occurredAt <= completedToolOccurredAt) {
			return { accepted: false, reason: "completed_tool" };
		}
		if (pendingPermission?.toolName && toolName && toolName !== pendingPermission.toolName) {
			return { accepted: false, reason: "unrelated_tool_completion" };
		}
		const toolUseId = normalizedToolUseId(input);
		if (pendingPermission?.toolUseId && toolUseId !== pendingPermission.toolUseId) {
			return { accepted: false, reason: "unrelated_tool_completion" };
		}
		if (pendingPermission && occurredAt < pendingPermission.occurredAt) {
			return { accepted: false, reason: "stale_observation" };
		}
	}
	if (
		pendingPermission &&
		(hookEventName === "userpromptsubmit" || isCodexTurnEnd(hookEventName)) &&
		occurredAt < pendingPermission.occurredAt
	) {
		return { accepted: false, reason: "stale_observation" };
	}

	return { accepted: true };
}

export function commitHookEventOrder(
	state: HookEventOrderState | null,
	input: RuntimeHookIngestRequest,
	options: { advanceTurn: boolean },
): void {
	if (!state) {
		return;
	}
	const now = Date.now();
	const deliveryId = input.delivery?.id;
	if (deliveryId) {
		state.processedDeliveryIds.set(deliveryId, now);
		pruneTrackedIds(state.processedDeliveryIds, now);
	}
	if (!options.advanceTurn) {
		return;
	}
	state.foregroundInterrupt =
		advanceLocalForegroundInterrupt(state.foregroundInterrupt, input, state.codexSessionId) ?? null;
	if (isPiInput(input)) {
		const occurredAt = input.delivery?.occurredAt ?? now;
		const runId = input.metadata?.turnId?.trim() || null;
		if (runId && state.activePiRunId !== runId) {
			if (state.activePiRunId) state.retiredPiRunIds.set(state.activePiRunId, now);
			state.activePiRunId = runId;
			state.activePiRunLatestOccurredAt = occurredAt;
			state.activePiRunCompleted = false;
			state.activePiRunBoundaryDeliveryId = null;
		} else if (runId) {
			state.activePiRunLatestOccurredAt = Math.max(state.activePiRunLatestOccurredAt ?? occurredAt, occurredAt);
		}
		const hookEventName = normalizedHookEventName(input);
		const toolUseId = normalizedToolUseId(input);
		if (
			toolUseId &&
			(hookEventName === "permissionresolved" ||
				hookEventName === "permissiondenied" ||
				hookEventName === "projecttrustresolved" ||
				hookEventName === "projecttrustdenied" ||
				hookEventName === "toolexecutionend" ||
				hookEventName === "toolexecutionfailure")
		) {
			state.completedPiToolUseIds.set(toolUseId, occurredAt);
		}
		if (
			(hookEventName === "agentsettled" || hookEventName === "interrupt" || hookEventName === "stopfailure") &&
			runId === state.activePiRunId
		) {
			state.activePiRunCompleted = true;
		}
		if (
			runId === state.activePiRunId &&
			(state.activePiRunCompleted ||
				hookEventName === "agentend" ||
				hookEventName === "agentsettledbackgroundpending")
		) {
			state.activePiRunBoundaryDeliveryId = input.delivery?.id ?? null;
		}
		pruneTrackedIds(state.retiredPiRunIds, now);
		pruneTrackedIds(state.completedPiToolUseIds, occurredAt);
		return;
	}
	if (isClaudeInput(input)) {
		const subagentAgentId = getClaudeSubagentHookAgentId(input);
		if (subagentAgentId) {
			commitSubagentHookOrder(state.subagents, input, subagentAgentId, now);
			return;
		}
		const occurredAt = input.delivery?.occurredAt ?? now;
		const hookEventName = normalizedHookEventName(input);
		const promptId = normalizedPromptId(input);
		if (hookEventName === "userpromptsubmit" && !input.metadata?.providerAgentId?.trim()) {
			// A new foreground prompt supersedes any pending Escape and interrupted turn.
			state.claudeInterruptKey = null;
			state.claudeAwaitingPromptAfterInterrupt = false;
			state.claudeUnboundedBackgroundWorkWithoutPrompt = false;
			state.claudeForegroundPromptActive = true;
			if (!promptId) {
				const previousPromptId = state.activeClaudePromptId;
				if (previousPromptId && !state.claudeUnboundedBackgroundPromptIds.has(previousPromptId)) {
					state.retiredClaudePromptIds.set(previousPromptId, now);
				}
				state.activeClaudePromptId = null;
				state.activeClaudePromptLatestOccurredAt = occurredAt;
			}
		}
		if (promptId) {
			if (
				state.activeClaudePromptId !== promptId &&
				(state.activeClaudePromptLatestOccurredAt === null || occurredAt > state.activeClaudePromptLatestOccurredAt)
			) {
				if (
					state.activeClaudePromptId &&
					!state.claudeUnboundedBackgroundPromptIds.has(state.activeClaudePromptId)
				) {
					state.retiredClaudePromptIds.set(state.activeClaudePromptId, now);
				}
				state.activeClaudePromptId = promptId;
				state.claudeForegroundPromptActive = true;
				state.activeClaudePromptLatestOccurredAt = occurredAt;
				state.claudeAwaitingPromptAfterInterrupt = false;
			} else if (state.activeClaudePromptId === promptId) {
				state.activeClaudePromptLatestOccurredAt = Math.max(
					state.activeClaudePromptLatestOccurredAt ?? occurredAt,
					occurredAt,
				);
			}
		}
		const toolUseId = normalizedToolUseId(input);
		if (hookEventName === "pretooluse" && toolUseId) {
			// Anonymous tool activity may be a wake of the previous background
			// prompt. Only UserPromptSubmit establishes a new anonymous owner.
			state.claudePendingToolUses.set(toolUseId, {
				promptId,
				toolName: normalizedToolName(input),
				occurredAt,
			});
		} else if (
			(hookEventName === "posttooluse" ||
				hookEventName === "posttoolusefailure" ||
				hookEventName === "permissiondenied") &&
			toolUseId
		) {
			const pending = state.claudePendingToolUses.get(toolUseId);
			state.claudePendingToolUses.delete(toolUseId);
			state.claudeCompletedToolUses.set(toolUseId, {
				promptId: pending?.promptId ?? promptId,
				toolName: pending?.toolName ?? normalizedToolName(input),
				occurredAt,
			});
		} else if ((hookEventName === "stop" || hookEventName === "stopfailure") && input.event === "to_review") {
			state.latestClaudeRootCompletionOccurredAt = Math.max(
				state.latestClaudeRootCompletionOccurredAt ?? occurredAt,
				occurredAt,
			);
			const completedPromptId = promptId ?? state.activeClaudePromptId;
			// A shell or monitor may wake this prompt again, so keep its later hooks admissible.
			if (input.metadata?.unboundedBackgroundWorkPending) {
				if (completedPromptId) state.claudeUnboundedBackgroundPromptIds.set(completedPromptId, now);
				else state.claudeUnboundedBackgroundWorkWithoutPrompt = true;
			} else if (completedPromptId) {
				state.retiredClaudePromptIds.set(completedPromptId, now);
			}
			if (!promptId || state.activeClaudePromptId === promptId) {
				state.activeClaudePromptId = null;
				state.activeClaudePromptLatestOccurredAt = null;
				state.claudeForegroundPromptActive = false;
			}
			if (!input.metadata?.unboundedBackgroundWorkPending) {
				closeClaudePendingTools(state, completedPromptId, occurredAt);
				state.claudeUnboundedBackgroundWorkWithoutPrompt = false;
				if (completedPromptId) state.claudeUnboundedBackgroundPromptIds.delete(completedPromptId);
			}
		}
		if (hookEventName === "elicitationresult") {
			const elicitationId = normalizedElicitationId(input);
			if (elicitationId) state.completedClaudeElicitationIds.set(elicitationId, now);
			if (promptId) state.completedClaudeElicitationPromptOccurredAt.set(promptId, occurredAt);
			state.completedClaudeElicitationOccurredAt = Math.max(
				state.completedClaudeElicitationOccurredAt ?? occurredAt,
				occurredAt,
			);
		}
		pruneTrackedIds(state.retiredClaudePromptIds, now);
		pruneTrackedIds(state.claudeUnboundedBackgroundPromptIds, now);
		pruneTrackedIds(state.completedClaudeElicitationIds, now);
		pruneTrackedIds(state.completedClaudeElicitationPromptOccurredAt, occurredAt);
		pruneClaudeToolObservations(state.claudePendingToolUses, occurredAt);
		pruneClaudeToolObservations(state.claudeCompletedToolUses, occurredAt);
		return;
	}
	if (!isCodexInput(input)) {
		return;
	}
	const codexSubagentAgentId = getCodexSubagentHookAgentId(input);
	if (codexSubagentAgentId) {
		commitSubagentHookOrder(state.subagents, input, codexSubagentAgentId, now);
		return;
	}
	const occurredAt = input.delivery?.occurredAt ?? now;
	const providerSessionId = optionalIdentity(input.metadata?.sessionId);
	if (providerSessionId && state.codexSessionId && providerSessionId !== state.codexSessionId) {
		// Accepted native navigation begins a new thread's turn/tool domain.
		Object.assign(state, createHookEventOrderState(state.sessionInstanceId), {
			processedDeliveryIds: state.processedDeliveryIds,
		});
	}
	state.codexSessionId ??= providerSessionId;
	state.codexSessionLatestOccurredAt = Math.max(state.codexSessionLatestOccurredAt ?? occurredAt, occurredAt);
	const hookEventName = normalizedHookEventName(input);
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		if (isCodexTurnEnd(hookEventName)) {
			state.latestCodexRootCompletionOccurredAt = Math.max(
				state.latestCodexRootCompletionOccurredAt ?? occurredAt,
				occurredAt,
			);
			state.activeTurnLatestOccurredAt = Math.max(state.activeTurnLatestOccurredAt ?? occurredAt, occurredAt);
			state.pendingPermission = null;
			state.codexPendingToolUses.clear();
			state.activeTurnCompleted = true;
		}
		return;
	}

	if (state.activeTurnId !== turnId) {
		if (state.activeTurnId) {
			state.retiredTurnIds.set(state.activeTurnId, now);
			pruneTrackedIds(state.retiredTurnIds, now);
		}
		state.activeTurnId = turnId;
		state.activeTurnLatestOccurredAt = occurredAt;
		state.activeTurnLatestCompactOccurredAt = null;
		state.activeTurnCompleted = false;
		state.pendingPermission = null;
		state.completedToolOccurredAt.clear();
		state.codexPendingToolUses.clear();
	} else {
		state.activeTurnLatestOccurredAt = Math.max(state.activeTurnLatestOccurredAt ?? occurredAt, occurredAt);
	}

	const toolName = normalizedToolName(input);
	if (hookEventName === "precompact" || hookEventName === "postcompact") {
		state.activeTurnLatestCompactOccurredAt = Math.max(
			state.activeTurnLatestCompactOccurredAt ?? occurredAt,
			occurredAt,
		);
	}
	const toolUseId = normalizedToolUseId(input);
	if (hookEventName === "pretooluse" && toolUseId) {
		state.codexPendingToolUses.set(toolUseId, { turnId, toolName, occurredAt });
		pruneCodexToolObservations(state.codexPendingToolUses, occurredAt);
	} else if (hookEventName === "permissionrequest") {
		state.pendingPermission = {
			turnId,
			toolName,
			toolUseId: toolUseId ?? correlateCodexPermissionToolUseId(state, input),
			occurredAt,
		};
	} else if (hookEventName === "posttooluse") {
		const currentToolKey = toolKey(turnId, toolName);
		if (currentToolKey) {
			state.completedToolOccurredAt.set(currentToolKey, occurredAt);
			capTrackedIds(state.completedToolOccurredAt);
		}
		if (toolUseId) state.codexPendingToolUses.delete(toolUseId);
		const pendingPermission = state.pendingPermission?.turnId === turnId ? state.pendingPermission : null;
		if (
			!pendingPermission ||
			(pendingPermission.toolUseId
				? toolUseId === pendingPermission.toolUseId
				: !pendingPermission.toolName || !toolName || pendingPermission.toolName === toolName)
		) {
			state.pendingPermission = null;
		}
	} else if (hookEventName === "userpromptsubmit") {
		state.pendingPermission = null;
	} else if (isCodexTurnEnd(hookEventName)) {
		state.latestCodexRootCompletionOccurredAt = Math.max(
			state.latestCodexRootCompletionOccurredAt ?? occurredAt,
			occurredAt,
		);
		state.pendingPermission = null;
		state.codexPendingToolUses.clear();
		state.activeTurnCompleted = true;
	}
}
