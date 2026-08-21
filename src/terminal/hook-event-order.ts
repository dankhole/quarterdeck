import type { RuntimeHookIngestRequest } from "../core";

// Ordering is additive: only launch-scoped events with documented Codex turn
// identity participate. Older/third-party payloads fall through unchanged.
const TRACKED_ID_TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED_IDS = 512;

interface PendingPermission {
	turnId: string;
	toolName: string | null;
	occurredAt: number;
}

export interface HookEventOrderState {
	sessionInstanceId: string;
	activeTurnId: string | null;
	activeTurnLatestOccurredAt: number | null;
	activeTurnLatestCompactOccurredAt: number | null;
	activeTurnCompleted: boolean;
	pendingPermission: PendingPermission | null;
	latestUserSubmissionAt: number | null;
	retiredTurnIds: Map<string, number>;
	completedToolOccurredAt: Map<string, number>;
	processedDeliveryIds: Map<string, number>;
}

export type HookEventOrderRejectionReason =
	| "duplicate_delivery"
	| "stale_session"
	| "stale_turn"
	| "stale_observation"
	| "completed_turn"
	| "completed_tool"
	| "resolved_by_user_input"
	| "unrelated_tool_completion";

export type HookEventOrderDecision = { accepted: true } | { accepted: false; reason: HookEventOrderRejectionReason };

export function createHookEventOrderState(sessionInstanceId: string): HookEventOrderState {
	return {
		sessionInstanceId,
		activeTurnId: null,
		activeTurnLatestOccurredAt: null,
		activeTurnLatestCompactOccurredAt: null,
		activeTurnCompleted: false,
		pendingPermission: null,
		latestUserSubmissionAt: null,
		retiredTurnIds: new Map(),
		completedToolOccurredAt: new Map(),
		processedDeliveryIds: new Map(),
	};
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

function normalizedHookEventName(input: RuntimeHookIngestRequest): string {
	return input.metadata?.hookEventName?.trim().toLowerCase() ?? "";
}

function normalizedToolName(input: RuntimeHookIngestRequest): string | null {
	return input.metadata?.toolName?.trim().toLowerCase() || null;
}

function isCodexInput(input: RuntimeHookIngestRequest): boolean {
	return input.metadata?.source?.trim().toLowerCase() === "codex";
}

function toolKey(turnId: string, toolName: string | null): string | null {
	return toolName ? JSON.stringify([turnId, toolName]) : null;
}

/**
 * Records a prompt submission observed directly at the task PTY. This is not
 * an agent-working heuristic: it only gives ordering a causal boundary for
 * hook events that occurred before the user's response but arrived later.
 */
export function recordHookUserSubmission(state: HookEventOrderState | null, occurredAt = Date.now()): void {
	if (!state) {
		return;
	}
	state.latestUserSubmissionAt = Math.max(state.latestUserSubmissionAt ?? occurredAt, occurredAt);
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

	if (!state || !isCodexInput(input)) {
		return { accepted: true };
	}
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		return { accepted: true };
	}
	if (state.retiredTurnIds.has(turnId)) {
		return { accepted: false, reason: "stale_turn" };
	}

	const occurredAt = input.delivery?.occurredAt ?? Date.now();
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

	const hookEventName = normalizedHookEventName(input);
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
	if (!options.advanceTurn || !isCodexInput(input)) {
		return;
	}
	const turnId = input.metadata?.turnId?.trim() || null;
	if (!turnId) {
		return;
	}

	const occurredAt = input.delivery?.occurredAt ?? now;
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
	} else {
		state.activeTurnLatestOccurredAt = Math.max(state.activeTurnLatestOccurredAt ?? occurredAt, occurredAt);
	}

	const hookEventName = normalizedHookEventName(input);
	const toolName = normalizedToolName(input);
	if (hookEventName === "precompact" || hookEventName === "postcompact") {
		state.activeTurnLatestCompactOccurredAt = Math.max(
			state.activeTurnLatestCompactOccurredAt ?? occurredAt,
			occurredAt,
		);
	}
	if (hookEventName === "permissionrequest") {
		state.pendingPermission = { turnId, toolName, occurredAt };
	} else if (hookEventName === "posttooluse") {
		const currentToolKey = toolKey(turnId, toolName);
		if (currentToolKey) {
			state.completedToolOccurredAt.set(currentToolKey, occurredAt);
			capTrackedIds(state.completedToolOccurredAt);
		}
		const pendingToolName = state.pendingPermission?.turnId === turnId ? state.pendingPermission.toolName : null;
		if (!pendingToolName || !toolName || pendingToolName === toolName) {
			state.pendingPermission = null;
		}
	} else if (hookEventName === "userpromptsubmit") {
		state.pendingPermission = null;
	} else if (hookEventName === "stop") {
		state.pendingPermission = null;
		state.activeTurnCompleted = true;
	}
}
