import type {
	RuntimeHookIngestRequest,
	RuntimeTaskOutstandingInteraction,
	RuntimeTaskProviderHookOrderObservation,
} from "../core";

// Ordering is additive: only launch-scoped events with documented Codex turn
// identity participate. Older/third-party payloads fall through unchanged.
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
	activePiRunId: string | null;
	activePiRunLatestOccurredAt: number | null;
	activePiRunCompleted: boolean;
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
	activeClaudePromptLatestOccurredAt: number | null;
	latestClaudeRootCompletionOccurredAt: number | null;
	retiredClaudePromptIds: Map<string, number>;
	completedClaudeElicitationIds: Map<string, number>;
	completedClaudeElicitationPromptOccurredAt: Map<string, number>;
	completedClaudeElicitationOccurredAt: number | null;
	processedDeliveryIds: Map<string, number>;
}

export type HookEventOrderRejectionReason =
	| "duplicate_delivery"
	| "stale_session"
	| "stale_turn"
	| "stale_prompt"
	| "stale_observation"
	| "completed_turn"
	| "completed_prompt"
	| "completed_tool"
	| "completed_interaction"
	| "resolved_by_user_input"
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
		activePiRunId: null,
		activePiRunLatestOccurredAt: null,
		activePiRunCompleted: false,
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
		activeClaudePromptLatestOccurredAt: null,
		latestClaudeRootCompletionOccurredAt: null,
		retiredClaudePromptIds: new Map(),
		completedClaudeElicitationIds: new Map(),
		completedClaudeElicitationPromptOccurredAt: new Map(),
		completedClaudeElicitationOccurredAt: null,
		processedDeliveryIds: new Map(),
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
	return {
		event: input.event,
		deliveryId: input.delivery.id,
		occurredAt: input.delivery.occurredAt,
		source,
		sessionInstanceId,
		hookEventName: optionalIdentity(input.metadata?.hookEventName),
		notificationType: optionalIdentity(input.metadata?.notificationType),
		turnId: optionalIdentity(input.metadata?.turnId),
		promptId: optionalIdentity(input.metadata?.promptId),
		toolUseId: optionalIdentity(input.metadata?.toolUseId),
		elicitationId: optionalIdentity(input.metadata?.elicitationId),
		toolName: optionalIdentity(input.metadata?.toolName),
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
			hookEventName: observation.hookEventName,
			notificationType: observation.notificationType,
			turnId: observation.turnId,
			promptId: observation.promptId,
			toolUseId: observation.toolUseId,
			elicitationId: observation.elicitationId,
			toolName: observation.toolName,
		},
		delivery: {
			id: observation.deliveryId,
			occurredAt: observation.occurredAt,
		},
	};
}

/** Rebuilds the exact provider-specific ordering guard from durable metadata. */
export function restoreHookEventOrderState(input: {
	sessionInstanceId: string;
	observations: readonly RuntimeTaskProviderHookOrderObservation[];
	recentDeliveryIds: readonly string[];
	outstandingInteraction: RuntimeTaskOutstandingInteraction | null;
}): HookEventOrderState {
	const state = createHookEventOrderState(input.sessionInstanceId);
	for (const observation of input.observations) {
		if (observation.sessionInstanceId !== input.sessionInstanceId) continue;
		const hookInput = observationAsHookInput(observation);
		if (!shouldRetainHookEventOrderObservation(evaluateHookEventOrder(state, hookInput))) continue;
		commitHookEventOrder(state, hookInput, { advanceTurn: true });
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

function isCodexInput(input: RuntimeHookIngestRequest): boolean {
	return input.metadata?.source?.trim().toLowerCase() === "codex";
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
		return { accepted: false, reason: "stale_turn" };
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
		if (
			state.latestClaudeRootCompletionOccurredAt !== null &&
			occurredAt <= state.latestClaudeRootCompletionOccurredAt
		) {
			return { accepted: false, reason: "stale_observation" };
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
	if (state.latestCodexRootCompletionOccurredAt !== null && occurredAt <= state.latestCodexRootCompletionOccurredAt) {
		return { accepted: false, reason: "stale_observation" };
	}
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		if (
			(hookEventName === "stop" || hookEventName === "stopfailure") &&
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
		(hookEventName === "userpromptsubmit" || hookEventName === "stop") &&
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
	if (isPiInput(input)) {
		const occurredAt = input.delivery?.occurredAt ?? now;
		const runId = input.metadata?.turnId?.trim() || null;
		if (runId && state.activePiRunId !== runId) {
			if (state.activePiRunId) state.retiredPiRunIds.set(state.activePiRunId, now);
			state.activePiRunId = runId;
			state.activePiRunLatestOccurredAt = occurredAt;
			state.activePiRunCompleted = false;
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
		if (hookEventName === "agentsettled" && runId === state.activePiRunId) {
			state.activePiRunCompleted = true;
		}
		pruneTrackedIds(state.retiredPiRunIds, now);
		pruneTrackedIds(state.completedPiToolUseIds, occurredAt);
		return;
	}
	if (isClaudeInput(input)) {
		const occurredAt = input.delivery?.occurredAt ?? now;
		const hookEventName = normalizedHookEventName(input);
		const promptId = normalizedPromptId(input);
		if (promptId) {
			if (
				state.activeClaudePromptId !== promptId &&
				(state.activeClaudePromptLatestOccurredAt === null || occurredAt > state.activeClaudePromptLatestOccurredAt)
			) {
				if (state.activeClaudePromptId) state.retiredClaudePromptIds.set(state.activeClaudePromptId, now);
				state.activeClaudePromptId = promptId;
				state.activeClaudePromptLatestOccurredAt = occurredAt;
			} else if (state.activeClaudePromptId === promptId) {
				state.activeClaudePromptLatestOccurredAt = Math.max(
					state.activeClaudePromptLatestOccurredAt ?? occurredAt,
					occurredAt,
				);
			}
		}
		const toolUseId = normalizedToolUseId(input);
		if (hookEventName === "pretooluse" && toolUseId) {
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
			if (completedPromptId) state.retiredClaudePromptIds.set(completedPromptId, now);
			if (!promptId || state.activeClaudePromptId === promptId) {
				state.activeClaudePromptId = null;
				state.activeClaudePromptLatestOccurredAt = null;
			}
			for (const [pendingToolUseId, pending] of state.claudePendingToolUses) {
				if (!completedPromptId || pending.promptId === completedPromptId) {
					state.claudePendingToolUses.delete(pendingToolUseId);
				}
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
		pruneTrackedIds(state.completedClaudeElicitationIds, now);
		pruneTrackedIds(state.completedClaudeElicitationPromptOccurredAt, occurredAt);
		pruneClaudeToolObservations(state.claudePendingToolUses, occurredAt);
		pruneClaudeToolObservations(state.claudeCompletedToolUses, occurredAt);
		return;
	}
	if (!isCodexInput(input)) {
		return;
	}
	const occurredAt = input.delivery?.occurredAt ?? now;
	const hookEventName = normalizedHookEventName(input);
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		if (hookEventName === "stop" || hookEventName === "stopfailure") {
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
	} else if (hookEventName === "stop" || hookEventName === "stopfailure") {
		state.latestCodexRootCompletionOccurredAt = Math.max(
			state.latestCodexRootCompletionOccurredAt ?? occurredAt,
			occurredAt,
		);
		state.pendingPermission = null;
		state.codexPendingToolUses.clear();
		state.activeTurnCompleted = true;
	}
}
