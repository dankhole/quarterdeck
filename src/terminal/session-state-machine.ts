import {
	deriveTaskIndicatorState,
	type RuntimeHookEvent,
	type RuntimeHookMetadata,
	type RuntimeTaskInteractionKind,
	type RuntimeTaskInteractionProvider,
	type RuntimeTaskInteractionResponseKind,
	type RuntimeTaskNativeWorkEvidence,
	type RuntimeTaskOutstandingInteraction,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionSummary,
} from "../core";
import { removeLegacySemanticStateWarning, type StartupRecoveryReviewState } from "./session-startup-recovery-policy";

export type HookSessionReviewReason = Extract<RuntimeTaskSessionReviewReason, "hook" | "attention" | "error">;

export type ProviderHookSessionEvidence = "unconfirmed" | "live" | "startup_replay" | "exited_replay";

export type ProviderHookSessionTransitionEvent = {
	type: "provider.hook";
	event: RuntimeHookEvent;
	metadata?: RuntimeHookMetadata;
	occurredAt?: number;
	deliveryId?: string;
	/** Tool identity correlated from the provider's preceding PreToolUse event. */
	correlatedToolUseId?: string | null;
	/** Controller-authored process/launch evidence; callers cannot self-assert authority. */
	sessionEvidence?: ProviderHookSessionEvidence;
	/** Controller-authored wall-clock time at which live hook evidence was accepted. */
	confirmedAt?: number;
	/**
	 * Launch-scoped Codex auto-review requests are not proof of user-facing
	 * input. The rendered approval detector remains the actionable fallback when
	 * native auto-review delegates an exceptional request to the user.
	 */
	codexAutoReviewPermissionRequest?: boolean;
};

export const NATIVE_WORK_EVIDENCE_LEASE_MS = 5 * 60_000;

export type SessionTransitionEvent =
	| ProviderHookSessionTransitionEvent
	| { type: "agent.permission-prompt"; occurredAt?: number }
	| { type: "agent.rendered-turn-interrupted" }
	| {
			type: "interaction.response_submitted";
			responseKind: Exclude<RuntimeTaskInteractionResponseKind, "provider_denied">;
			occurredAt?: number;
	  }
	| { type: "user.stop" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean }
	| { type: "interrupt.recovery" }
	| { type: "native_work.evidence_expired"; confirmedAt: number; occurredAt?: number }
	| { type: "autorestart.denied" }
	| { type: "resume.failed"; clearResumeSessionId: boolean; warningMessage: string }
	| { type: "structured.owner_activated"; pid: number; sessionInstanceId: string }
	| { type: "structured.turn_started"; pid: number; sessionInstanceId: string }
	| { type: "structured.turn_completed" }
	| { type: "structured.turn_failed"; warningMessage: string }
	| {
			type: "structured.interaction_requested";
			provider: Extract<RuntimeTaskInteractionProvider, "codex" | "claude">;
			interactionKind: "question" | "approval" | "elicitation";
			interactionId: string;
			providerSessionId: string;
			turnId: string | null;
			itemId: string | null;
			openedAt: number;
			sessionInstanceId: string;
	  }
	| { type: "structured.interaction_resolved"; interactionId: string; resolvedAt: number }
	| { type: "structured.interaction_cancelled"; interactionId: string }
	| { type: "structured.owner_stopped" }
	| { type: "structured.owner_crashed"; warningMessage: string; turnOutcomeUnknown: boolean }
	| { type: "reconciliation.launch_path_missing"; warningMessage: string }
	| {
			type: "startup_recovery.exhausted";
			processStillRunning: boolean;
			clearResumeSessionId: boolean;
			warningMessage: string;
			fallbackReviewState: StartupRecoveryReviewState | null;
	  };

export function canApplyCodexRenderedTurnInterruption(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.agentId !== "codex") return false;
	const interaction = summary.outstandingInteraction;
	return (
		summary.state === "running" ||
		(summary.state === "awaiting_review" &&
			interaction?.provider === "codex" &&
			interaction.kind === "permission" &&
			interaction.providerAgentId === null &&
			(interaction.status === "waiting" || interaction.status === "response_submitted"))
	);
}

export type HookMetadataMode = "apply" | "identity_only" | "preserve";

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
	/** Controls whether SessionSummaryStore applies hook activity atomically with the semantic patch. */
	hookMetadataMode?: HookMetadataMode;
	/** Overrides whether an accepted identity-only hook advances provider ordering history. */
	hookOrderingMode?: "advance";
}

const PROCESS_LOST_DURING_INTERACTION_WARNING =
	"The agent process exited while an input request was unresolved. Quarterdeck cannot confirm whether the response was applied; restart the task before continuing.";

function unchanged(hookMetadataMode?: HookMetadataMode): SessionTransitionResult {
	return {
		changed: false,
		patch: {},
		clearAttentionBuffer: false,
		...(hookMetadataMode ? { hookMetadataMode } : {}),
	};
}

function normalized(value: string | null | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function providerFromMetadata(metadata: RuntimeHookMetadata | undefined): RuntimeTaskInteractionProvider | null {
	const source = normalized(metadata?.source);
	return source === "codex" || source === "claude" || source === "pi" ? source : null;
}

function buildNativeWorkEvidence(event: ProviderHookSessionTransitionEvent): RuntimeTaskNativeWorkEvidence | null {
	const provider = providerFromMetadata(event.metadata);
	const sessionInstanceId = event.metadata?.sessionInstanceId?.trim() || null;
	const hookEventName = event.metadata?.hookEventName?.trim() || null;
	if (!provider || !sessionInstanceId || !hookEventName || event.sessionEvidence !== "live") return null;
	const confirmedAt = event.confirmedAt ?? Date.now();
	return {
		provider,
		sessionInstanceId,
		providerSessionId: event.metadata?.sessionId?.trim() || null,
		turnId: event.metadata?.turnId?.trim() || null,
		hookEventName,
		confirmedAt,
		expiresAt: confirmedAt + NATIVE_WORK_EVIDENCE_LEASE_MS,
	};
}

function getInteractionKind(metadata: RuntimeHookMetadata | undefined): RuntimeTaskInteractionKind | null {
	const provider = providerFromMetadata(metadata);
	const hookEventName = normalized(metadata?.hookEventName);
	const notificationType = normalized(metadata?.notificationType);
	const toolName = normalized(metadata?.toolName);

	if (provider === "claude" && hookEventName === "pretooluse") {
		if (toolName === "askuserquestion") return "question";
		if (toolName === "exitplanmode") return "plan_approval";
	}
	if (provider === "claude" && hookEventName === "elicitation") return "elicitation";
	if (provider === "pi" && hookEventName === "projecttrustrequest") return "permission";
	if (hookEventName === "permissionrequest" || (provider === "codex" && notificationType === "permission_prompt")) {
		if (provider === "claude" && toolName === "askuserquestion") return "question";
		if (provider === "claude" && toolName === "exitplanmode") return "plan_approval";
		return "permission";
	}
	return null;
}

function reviewReasonForInteraction(kind: RuntimeTaskInteractionKind): HookSessionReviewReason {
	return kind === "permission" ? "hook" : "attention";
}

function buildOutstandingInteraction(
	event: ProviderHookSessionTransitionEvent,
	kind: RuntimeTaskInteractionKind,
): RuntimeTaskOutstandingInteraction | null {
	const provider = providerFromMetadata(event.metadata);
	if (!provider) return null;
	const occurredAt = event.occurredAt ?? Date.now();
	return {
		provider,
		kind,
		status: "waiting",
		requestEventName: event.metadata?.hookEventName ?? event.metadata?.notificationType ?? "provider_input",
		openedAt: occurredAt,
		updatedAt: occurredAt,
		responseSubmittedAt: null,
		responseKind: null,
		sessionInstanceId: event.metadata?.sessionInstanceId?.trim() || null,
		providerSessionId: event.metadata?.sessionId?.trim() || null,
		turnId: event.metadata?.turnId?.trim() || null,
		promptId: event.metadata?.promptId?.trim() || null,
		toolUseId: event.correlatedToolUseId?.trim() || event.metadata?.toolUseId?.trim() || null,
		elicitationId: event.metadata?.elicitationId?.trim() || null,
		providerAgentId: event.metadata?.providerAgentId?.trim() || null,
		toolName: event.metadata?.toolName?.trim() || null,
	};
}

/** Backward-compatible migration for persisted waits written before durable interaction identity existed. */
export function inferLegacyOutstandingInteraction(
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskOutstandingInteraction | null {
	if (summary.state !== "awaiting_review" || summary.outstandingInteraction) return null;
	const activity = summary.latestHookActivity;
	const provider = providerFromMetadata(activity ?? undefined);
	if (!provider) return null;
	const kind = getInteractionKind(activity ?? undefined) ?? (isPermissionLikeActivity(activity) ? "permission" : null);
	if (!kind || (summary.reviewReason !== "attention" && !(summary.reviewReason === "hook" && kind === "permission"))) {
		return null;
	}
	const openedAt = summary.lastHookAt ?? summary.updatedAt;
	return {
		provider,
		kind,
		status: "waiting",
		requestEventName: activity?.hookEventName ?? activity?.notificationType ?? "legacy_provider_input",
		openedAt,
		updatedAt: openedAt,
		responseSubmittedAt: null,
		responseKind: null,
		sessionInstanceId: summary.sessionInstanceId ?? null,
		providerSessionId: summary.resumeSessionId ?? null,
		turnId: null,
		promptId: null,
		toolUseId: null,
		elicitationId: null,
		providerAgentId: null,
		toolName: activity?.toolName ?? null,
	};
}

function isPermissionLikeActivity(activity: RuntimeTaskSessionSummary["latestHookActivity"]): boolean {
	const hook = normalized(activity?.hookEventName);
	if (providerFromMetadata(activity ?? undefined) === "claude" && hook === "notification") return false;
	const notification = normalized(activity?.notificationType);
	return hook === "permissionrequest" || notification === "permission_prompt" || notification === "permission.asked";
}

function conflicts(left: string | null, right: string | null): boolean {
	return left !== null && right !== null && left !== right;
}

function isSameInteraction(
	current: RuntimeTaskOutstandingInteraction,
	incoming: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (current.provider !== incoming.provider || current.kind !== incoming.kind) return false;
	if (
		conflicts(current.sessionInstanceId, incoming.sessionInstanceId) ||
		conflicts(current.providerSessionId, incoming.providerSessionId) ||
		conflicts(current.turnId, incoming.turnId) ||
		conflicts(current.promptId, incoming.promptId) ||
		conflicts(current.toolUseId, incoming.toolUseId) ||
		conflicts(current.elicitationId, incoming.elicitationId) ||
		conflicts(current.providerAgentId, incoming.providerAgentId)
	) {
		return false;
	}
	if (conflicts(current.toolName, incoming.toolName)) return false;
	if (
		current.status === "response_submitted" &&
		current.responseSubmittedAt !== null &&
		incoming.openedAt > current.responseSubmittedAt
	) {
		// A later request is a new interaction unless it carries the same exact
		// interaction identity. Prompt/turn identity is intentionally insufficient:
		// Claude can ask for several permissions inside one prompt and Codex can
		// request several tools inside one turn.
		const hasExactInteractionIdentity = Boolean(
			(current.toolUseId && incoming.toolUseId === current.toolUseId) ||
				(current.elicitationId && incoming.elicitationId === current.elicitationId) ||
				(current.providerAgentId && incoming.providerAgentId === current.providerAgentId),
		);
		if (!hasExactInteractionIdentity) return false;
	}
	const hasStrongIdentity = Boolean(
		current.turnId ||
			incoming.turnId ||
			current.promptId ||
			incoming.promptId ||
			current.toolUseId ||
			incoming.toolUseId ||
			current.elicitationId ||
			incoming.elicitationId ||
			current.providerAgentId ||
			incoming.providerAgentId,
	);
	if (hasStrongIdentity) return true;
	if (normalized(event.metadata?.hookEventName) === "notification") return true;
	return incoming.openedAt === current.openedAt;
}

function interactionEventIsCurrent(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	const provider = providerFromMetadata(event.metadata);
	if (!provider || provider !== interaction.provider) return false;
	const occurredAt = event.occurredAt;
	if (occurredAt !== undefined && occurredAt < interaction.openedAt) return false;
	if (
		interaction.status === "response_submitted" &&
		interaction.responseSubmittedAt !== null &&
		(occurredAt === undefined || occurredAt < interaction.responseSubmittedAt)
	) {
		return false;
	}
	if (conflicts(interaction.sessionInstanceId, event.metadata?.sessionInstanceId?.trim() || null)) return false;
	if (conflicts(interaction.providerSessionId, event.metadata?.sessionId?.trim() || null)) return false;
	if (conflicts(interaction.turnId, event.metadata?.turnId?.trim() || null)) return false;
	if (conflicts(interaction.promptId, event.metadata?.promptId?.trim() || null)) return false;
	return true;
}

/**
 * Checks only the provider/session/time fence, intentionally ignoring turn and
 * prompt identity. A later foreground lifecycle can supersede an obsolete wait
 * precisely because it belongs to a newer turn or prompt. Exact interaction
 * resolution continues to use interactionEventIsCurrent above.
 */
function providerEventFollowsInteractionInSameSession(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	const provider = providerFromMetadata(event.metadata);
	if (!provider || provider !== interaction.provider) return false;
	const occurredAt = event.occurredAt;
	if (occurredAt === undefined || occurredAt <= interaction.updatedAt) return false;
	if (conflicts(interaction.sessionInstanceId, event.metadata?.sessionInstanceId?.trim() || null)) return false;
	if (conflicts(interaction.providerSessionId, event.metadata?.sessionId?.trim() || null)) return false;
	return true;
}

function hasDifferentForegroundLifecycleIdentity(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	const incomingTurnId = event.metadata?.turnId?.trim() || null;
	const incomingPromptId = event.metadata?.promptId?.trim() || null;
	return Boolean(
		(interaction.turnId && incomingTurnId && incomingTurnId !== interaction.turnId) ||
			(interaction.promptId && incomingPromptId && incomingPromptId !== interaction.promptId),
	);
}

/**
 * A current launch-scoped event from a demonstrably later foreground lifecycle
 * proves that an older permission/question wait no longer owns the TUI. This
 * is not a generic activity heuristic: same-turn parallel work, notifications,
 * and identity-free tool activity remain unable to clear an untouched wait.
 */
function providerLifecycleSupersedesInteraction(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (!providerEventFollowsInteractionInSameSession(interaction, event)) return false;
	const hookEventName = normalized(event.metadata?.hookEventName);
	if (hookEventName === "userpromptsubmit") return event.event === "to_in_progress";
	if (hookEventName !== "pretooluse" && hookEventName !== "posttooluse" && hookEventName !== "posttoolusefailure") {
		return false;
	}
	return hasDifferentForegroundLifecycleIdentity(interaction, event);
}

/** A current root completion is definitive even when the old wait lacks identity. */
function providerCompletionSupersedesInteraction(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (event.event !== "to_review") return false;
	const hookEventName = normalized(event.metadata?.hookEventName);
	return (
		(hookEventName === "stop" || hookEventName === "stopfailure") &&
		providerEventFollowsInteractionInSameSession(interaction, event)
	);
}

function matchesToolResolution(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (!interactionEventIsCurrent(interaction, event)) return false;
	const incomingToolUseId = event.metadata?.toolUseId?.trim() || null;
	if (interaction.toolUseId) return incomingToolUseId === interaction.toolUseId;
	// Claude exposes tool_use_id on Pre/PostToolUse but not PermissionRequest.
	// If the preceding PreToolUse could not be correlated, fail closed instead
	// of letting a parallel completion clear the wait.
	if (interaction.provider === "claude") return false;
	if (normalized(interaction.requestEventName) !== "renderedapprovaloverlay") return false;
	const incomingToolName = event.metadata?.toolName?.trim() || null;
	if (interaction.toolName && incomingToolName && interaction.toolName !== incomingToolName) return false;
	// The rendered Codex overlay has no native turn/tool identity. A completion
	// can resolve it only after Quarterdeck delivered a response; otherwise an
	// unrelated parallel PostToolUse could claim Running while the overlay is
	// still visibly blocking the user.
	return interaction.status === "response_submitted";
}

function matchesPermissionDenied(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (!interactionEventIsCurrent(interaction, event)) return false;
	const incomingToolUseId = event.metadata?.toolUseId?.trim() || null;
	// Claude emits PermissionDenied only for automatic permission-mode denial,
	// and that payload carries the denied tool_use_id. Manual denial has no
	// corresponding hook, so it remains response_submitted until later native
	// work or Stop evidence resolves the wait.
	return Boolean(incomingToolUseId && interaction.toolUseId === incomingToolUseId);
}

function hasExplicitCurrentInteractionScope(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (!interactionEventIsCurrent(interaction, event)) return false;
	if (interaction.turnId && event.metadata?.turnId?.trim() !== interaction.turnId) return false;
	if (interaction.promptId && event.metadata?.promptId?.trim() !== interaction.promptId) return false;
	return Boolean(interaction.turnId || interaction.promptId) || interaction.status === "response_submitted";
}

function matchesInteractionResolution(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (!interactionEventIsCurrent(interaction, event)) return false;
	const hookEventName = normalized(event.metadata?.hookEventName);
	if (
		interaction.provider === "pi" &&
		(hookEventName === "permissionresolved" || hookEventName === "permissiondenied")
	) {
		return matchesToolResolution(interaction, event);
	}
	if (hookEventName === "userpromptsubmit") return true;
	if (hookEventName === "posttooluse" || hookEventName === "posttoolusefailure") {
		return interaction.kind !== "elicitation" && matchesToolResolution(interaction, event);
	}
	if (hookEventName === "elicitationresult" && interaction.kind === "elicitation") {
		const incomingId = event.metadata?.elicitationId?.trim() || null;
		if (interaction.elicitationId) return incomingId === interaction.elicitationId;
		// Older Claude payloads may omit elicitation_id. In that compatibility
		// shape, require both a locally submitted response and prompt identity;
		// never let an unscoped result clear an untouched wait.
		return (
			interaction.status === "response_submitted" &&
			Boolean(interaction.promptId && event.metadata?.promptId?.trim() === interaction.promptId)
		);
	}
	return false;
}

function providerWorkResumedAfterPendingInteraction(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): boolean {
	if (
		interaction.status !== "response_submitted" ||
		!interactionEventIsCurrent(interaction, event) ||
		!providerEventFollowsInteractionInSameSession(interaction, event)
	) {
		return false;
	}
	const hookEventName = normalized(event.metadata?.hookEventName);
	// Only the start of a different tool proves that Claude progressed beyond
	// the answered interaction. A different PostToolUse may be a delayed
	// completion from parallel work that began before the user responded.
	if (hookEventName !== "pretooluse") return false;
	const incomingToolUseId = event.metadata?.toolUseId?.trim() || null;
	return Boolean(incomingToolUseId && incomingToolUseId !== interaction.toolUseId);
}

function isNonAuthoritativeClaudeNotification(event: ProviderHookSessionTransitionEvent): boolean {
	if (
		providerFromMetadata(event.metadata) !== "claude" ||
		normalized(event.metadata?.hookEventName) !== "notification"
	) {
		return false;
	}
	const notificationType = normalized(event.metadata?.notificationType);
	// Notifications are side-effect/presentation events and can duplicate a
	// native permission or elicitation lifecycle. Legacy background-agent types
	// also lack the exact response owner required by the foreground interaction.
	return (
		notificationType === "permission_prompt" ||
		notificationType === "elicitation_dialog" ||
		notificationType === "elicitation_url_dialog" ||
		notificationType === "elicitation_complete" ||
		notificationType === "elicitation_response" ||
		notificationType === "agent_needs_input" ||
		notificationType === "agent_completed"
	);
}

function isClaudeSubagentHook(event: ProviderHookSessionTransitionEvent): boolean {
	return providerFromMetadata(event.metadata) === "claude" && Boolean(event.metadata?.providerAgentId?.trim());
}

function isIdentityBearingClaudeOrderObservation(event: ProviderHookSessionTransitionEvent): boolean {
	if (providerFromMetadata(event.metadata) !== "claude") return false;
	const hookEventName = normalized(event.metadata?.hookEventName);
	return (
		hookEventName === "pretooluse" ||
		hookEventName === "posttooluse" ||
		hookEventName === "posttoolusefailure" ||
		hookEventName === "permissiondenied" ||
		hookEventName === "elicitationresult"
	);
}

function getDelayedClaudePermissionToolUseId(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
): string | null {
	if (
		interaction.provider !== "claude" ||
		interaction.kind !== "permission" ||
		interaction.toolUseId ||
		normalized(event.metadata?.hookEventName) !== "pretooluse"
	) {
		return null;
	}
	const occurredAt = event.occurredAt;
	if (occurredAt === undefined || occurredAt > interaction.openedAt) return null;
	if (providerFromMetadata(event.metadata) !== interaction.provider) return null;
	if (conflicts(interaction.sessionInstanceId, event.metadata?.sessionInstanceId?.trim() || null)) return null;
	if (conflicts(interaction.providerSessionId, event.metadata?.sessionId?.trim() || null)) return null;
	if (conflicts(interaction.promptId, event.metadata?.promptId?.trim() || null)) return null;
	const incomingToolName = event.metadata?.toolName?.trim() || null;
	if (conflicts(interaction.toolName, incomingToolName)) return null;
	return event.metadata?.toolUseId?.trim() || null;
}

function asPendingInteraction(
	interaction: RuntimeTaskOutstandingInteraction,
	event: ProviderHookSessionTransitionEvent,
	responseKind: RuntimeTaskInteractionResponseKind,
): RuntimeTaskOutstandingInteraction {
	const occurredAt = event.occurredAt ?? Date.now();
	return {
		...interaction,
		status: "response_submitted",
		updatedAt: occurredAt,
		responseSubmittedAt: interaction.responseSubmittedAt ?? occurredAt,
		responseKind: interaction.responseKind ?? responseKind,
	};
}

function asConfirmedProviderWorkResult(
	summary: RuntimeTaskSessionSummary,
	event: ProviderHookSessionTransitionEvent,
): SessionTransitionResult {
	const nativeWorkEvidence = buildNativeWorkEvidence(event);
	if (event.sessionEvidence === "live" && !nativeWorkEvidence) return unchanged("preserve");
	const result: SessionTransitionResult = {
		changed: true,
		patch: {
			...clearSemanticUncertainty(summary),
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
			nativeWorkEvidence,
			stalledSince: null,
		},
		clearAttentionBuffer: true,
		hookMetadataMode: "apply",
	};
	if (event.sessionEvidence === "exited_replay") return asExitedProcessResult(summary, result);
	return event.sessionEvidence === "startup_replay" ? asRecoveredInterruptedResult(result) : result;
}

function reduceProviderHook(
	summary: RuntimeTaskSessionSummary,
	event: ProviderHookSessionTransitionEvent,
): SessionTransitionResult {
	const sessionEvidence = event.sessionEvidence ?? "unconfirmed";
	const live = sessionEvidence === "live";
	const startupReplay = sessionEvidence === "startup_replay";
	const exitedReplay = sessionEvidence === "exited_replay";
	const replayed = startupReplay || exitedReplay;
	const metadata = event.metadata;
	const hookEventName = normalized(metadata?.hookEventName);
	const interactionKind = getInteractionKind(metadata);
	const currentInteraction = summary.outstandingInteraction ?? inferLegacyOutstandingInteraction(summary);
	if (!live && !replayed) return unchanged("preserve");
	// Claude documents agent_id as a subagent marker. A task can have several
	// concurrent background agents, while RuntimeTaskSessionSummary currently
	// owns one foreground interaction. Never let one subagent overwrite or
	// resolve that foreground wait; a future typed multi-owner interaction
	// service must model those identities explicitly.
	if (isClaudeSubagentHook(event)) return unchanged("preserve");
	// Claude notifications are delayed presentation signals. In particular,
	// Agent View notifications describe independent background conversations
	// and carry no structured identity for the affected session. They may be
	// logged by ingest, but must never author this Quarterdeck task's state or
	// overwrite stronger identity-bearing hook activity.
	if (isNonAuthoritativeClaudeNotification(event)) return unchanged("preserve");
	if (
		interactionKind === "permission" &&
		providerFromMetadata(metadata) === "codex" &&
		hookEventName === "permissionrequest" &&
		event.codexAutoReviewPermissionRequest === true
	) {
		// PermissionRequest fires before Codex chooses its effective auto-review
		// result. In this exact launch mode it is ordering/correlation evidence, not
		// proof that the TUI is waiting for a person. If Codex actually renders an
		// approval, the narrow screen detector authors the actionable wait.
		return {
			...unchanged("identity_only"),
			hookOrderingMode: "advance",
		};
	}

	if (interactionKind) {
		const incomingInteraction = buildOutstandingInteraction(event, interactionKind);
		if (!incomingInteraction) return unchanged("identity_only");
		const outstandingInteraction =
			currentInteraction && isSameInteraction(currentInteraction, incomingInteraction, event)
				? {
						...currentInteraction,
						updatedAt: Math.max(currentInteraction.updatedAt, incomingInteraction.updatedAt),
						toolUseId: currentInteraction.toolUseId ?? incomingInteraction.toolUseId,
						promptId: currentInteraction.promptId ?? incomingInteraction.promptId,
						turnId: currentInteraction.turnId ?? incomingInteraction.turnId,
						providerAgentId: currentInteraction.providerAgentId ?? incomingInteraction.providerAgentId,
						toolName: currentInteraction.toolName ?? incomingInteraction.toolName,
					}
				: incomingInteraction;
		const result: SessionTransitionResult = {
			changed: true,
			patch: {
				...clearSemanticUncertainty(summary),
				state: "awaiting_review",
				reviewReason: reviewReasonForInteraction(interactionKind),
				outstandingInteraction,
				nativeWorkEvidence: null,
			},
			clearAttentionBuffer: true,
			hookMetadataMode: "apply",
		};
		if (exitedReplay) return asExitedUnknownInteractionResult(result);
		return startupReplay
			? {
					...result,
					patch: { ...result.patch, pid: null, startupRecoveryRequired: true },
				}
			: result;
	}

	if (currentInteraction) {
		if (
			currentInteraction.provider === "pi" &&
			(hookEventName === "projecttrustresolved" || hookEventName === "projecttrustdenied") &&
			matchesToolResolution(currentInteraction, event)
		) {
			const denied = hookEventName === "projecttrustdenied";
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					// Trust acceptance only permits Pi to continue startup; it is not
					// evidence that agent work completed or even began.
					reviewReason: denied ? "error" : "unconfirmed",
					outstandingInteraction: null,
					nativeWorkEvidence: null,
				},
				clearAttentionBuffer: true,
				hookMetadataMode: "apply",
			};
		}
		const delayedClaudeToolUseId = getDelayedClaudePermissionToolUseId(currentInteraction, event);
		if (delayedClaudeToolUseId) {
			return {
				changed: true,
				patch: {
					outstandingInteraction: {
						...currentInteraction,
						toolUseId: delayedClaudeToolUseId,
					},
				},
				clearAttentionBuffer: false,
				hookMetadataMode: "identity_only",
				hookOrderingMode: "advance",
			};
		}
		if (matchesInteractionResolution(currentInteraction, event)) {
			return asConfirmedProviderWorkResult(summary, event);
		}
		if (hookEventName === "permissiondenied" && matchesPermissionDenied(currentInteraction, event)) {
			const result: SessionTransitionResult = {
				changed: true,
				patch: { outstandingInteraction: asPendingInteraction(currentInteraction, event, "provider_denied") },
				clearAttentionBuffer: true,
				hookMetadataMode: "apply",
			};
			if (exitedReplay) return asExitedUnknownInteractionResult(result);
			return startupReplay
				? { ...result, patch: { ...result.patch, pid: null, startupRecoveryRequired: true } }
				: result;
		}
		if (providerWorkResumedAfterPendingInteraction(currentInteraction, event)) {
			return asConfirmedProviderWorkResult(summary, event);
		}
		if (providerLifecycleSupersedesInteraction(currentInteraction, event)) {
			return asConfirmedProviderWorkResult(summary, event);
		}
		if (
			event.event === "to_review" &&
			(hookEventName === "stop" || hookEventName === "stopfailure") &&
			(hasExplicitCurrentInteractionScope(currentInteraction, event) ||
				providerCompletionSupersedesInteraction(currentInteraction, event))
		) {
			const reason: HookSessionReviewReason = hookEventName === "stopfailure" ? "error" : "hook";
			const result: SessionTransitionResult = {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "awaiting_review",
					reviewReason: reason,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					...(replayed
						? {
								pid: null,
								startupRecoveryRequired: false,
								warningMessage: removeProcessLostInteractionWarning(summary.warningMessage ?? null),
							}
						: {}),
				},
				clearAttentionBuffer: true,
				hookMetadataMode: "apply",
			};
			return result;
		}
		// Unrelated parallel provider activity must not replace or resolve the
		// durable request shown to the user. Identity-bearing Claude tool and
		// elicitation observations still advance delivery ordering so their
		// delayed request counterparts cannot reopen a completed interaction.
		return {
			...unchanged("identity_only"),
			...(isIdentityBearingClaudeOrderObservation(event) ? { hookOrderingMode: "advance" as const } : {}),
		};
	}

	// A foreground tool start is direct work evidence, not generic activity.
	// Interaction handling above gets first refusal so same-turn parallel work
	// cannot clear a real wait. With no wait, current launch/order fencing makes
	// PreToolUse sufficient to establish or refresh Running even if the provider's
	// preceding UserPromptSubmit hook was missing.
	if (
		hookEventName === "pretooluse" &&
		(event.event === "activity" || event.event === "to_in_progress") &&
		(summary.state === "running" ||
			canReturnReviewToRunning(summary, { liveSessionConfirmed: live }) ||
			summary.startupRecoverySemanticStateUncertain === true)
	) {
		if (summary.state === "running" && live) {
			const nativeWorkEvidence = buildNativeWorkEvidence(event);
			return nativeWorkEvidence
				? {
						changed: true,
						patch: { nativeWorkEvidence, reviewReason: null, outstandingInteraction: null },
						clearAttentionBuffer: false,
						hookMetadataMode: "apply",
					}
				: unchanged("preserve");
		}
		return asConfirmedProviderWorkResult(summary, event);
	}

	if (event.event === "to_review") {
		const completesInterruptedTurn = summary.state === "awaiting_review" && summary.reviewReason === "interrupted";
		const completesUnconfirmedLaunch = summary.state === "awaiting_review" && summary.reviewReason === "unconfirmed";
		if (
			summary.state !== "running" &&
			!completesInterruptedTurn &&
			!completesUnconfirmedLaunch &&
			summary.startupRecoverySemanticStateUncertain !== true
		) {
			return unchanged("apply");
		}
		const reason: HookSessionReviewReason = hookEventName === "stopfailure" ? "error" : "hook";
		const result: SessionTransitionResult = {
			changed: true,
			patch: {
				...clearSemanticUncertainty(summary),
				state: "awaiting_review",
				reviewReason: reason,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
			},
			clearAttentionBuffer: true,
			hookMetadataMode: "apply",
		};
		return replayed
			? {
					...result,
					patch: { ...result.patch, pid: null, startupRecoveryRequired: false },
				}
			: result;
	}

	if (event.event === "to_in_progress") {
		const nativeWorkEvidence = buildNativeWorkEvidence(event);
		if (live && !nativeWorkEvidence) return unchanged("preserve");
		if (summary.state === "running") {
			return nativeWorkEvidence
				? {
						changed: true,
						patch: { nativeWorkEvidence, reviewReason: null, outstandingInteraction: null },
						clearAttentionBuffer: false,
						hookMetadataMode: "apply",
					}
				: unchanged("apply");
		}
		if (
			!canReturnReviewToRunning(summary, { liveSessionConfirmed: true }) &&
			summary.startupRecoverySemanticStateUncertain !== true
		) {
			return unchanged("apply");
		}
		const result: SessionTransitionResult = {
			changed: true,
			patch: {
				...clearSemanticUncertainty(summary),
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				nativeWorkEvidence,
				stalledSince: null,
			},
			clearAttentionBuffer: true,
			hookMetadataMode: "apply",
		};
		if (exitedReplay) return asExitedProcessResult(summary, result);
		return startupReplay ? asRecoveredInterruptedResult(result) : result;
	}

	return unchanged("apply");
}

function asRecoveredInterruptedResult(result: SessionTransitionResult): SessionTransitionResult {
	return {
		...result,
		patch: {
			...result.patch,
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			outstandingInteraction: null,
			nativeWorkEvidence: null,
			startupRecoveryRequired: true,
		},
	};
}

function removeProcessLostInteractionWarning(warningMessage: string | null): string | null {
	return warningMessage === PROCESS_LOST_DURING_INTERACTION_WARNING ? null : warningMessage;
}

function asExitedUnknownInteractionResult(result: SessionTransitionResult): SessionTransitionResult {
	const interaction = result.patch.outstandingInteraction;
	return {
		...result,
		patch: {
			...result.patch,
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
			nativeWorkEvidence: null,
			outstandingInteraction: interaction
				? {
						...interaction,
						status: "resolution_unknown",
					}
				: null,
			startupRecoveryRequired: false,
			warningMessage: PROCESS_LOST_DURING_INTERACTION_WARNING,
		},
	};
}

function asExitedProcessResult(
	summary: RuntimeTaskSessionSummary,
	result: SessionTransitionResult,
): SessionTransitionResult {
	return {
		...result,
		patch: {
			...result.patch,
			state: "awaiting_review",
			reviewReason: summary.exitCode === 0 ? "exit" : "error",
			pid: null,
			outstandingInteraction: null,
			nativeWorkEvidence: null,
			startupRecoveryRequired: false,
			warningMessage: removeProcessLostInteractionWarning(summary.warningMessage ?? null),
		},
	};
}

function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	return (
		reason === "attention" ||
		reason === "hook" ||
		reason === "error" ||
		reason === "exit" ||
		reason === "stalled" ||
		reason === "unconfirmed"
	);
}

function canReturnReviewToRunning(
	summary: RuntimeTaskSessionSummary,
	options: { liveSessionConfirmed?: boolean } = {},
): boolean {
	if (summary.state !== "awaiting_review") return false;
	return (
		canReturnToRunning(summary.reviewReason) ||
		(options.liveSessionConfirmed === true && summary.reviewReason === "interrupted")
	);
}

function clearSemanticUncertainty(summary: RuntimeTaskSessionSummary): Partial<RuntimeTaskSessionSummary> {
	if (summary.startupRecoverySemanticStateUncertain !== true) return {};
	return {
		startupRecoverySemanticStateUncertain: false,
		warningMessage: removeLegacySemanticStateWarning(summary.warningMessage),
	};
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "provider.hook":
			return reduceProviderHook(summary, event);
		case "agent.permission-prompt": {
			const occurredAt = event.occurredAt ?? Date.now();
			const submittedInteraction = summary.outstandingInteraction;
			const followsSubmittedCodexInteraction =
				summary.state === "awaiting_review" &&
				submittedInteraction?.provider === "codex" &&
				submittedInteraction.status === "response_submitted" &&
				occurredAt >= (submittedInteraction.responseSubmittedAt ?? submittedInteraction.updatedAt);
			if (
				(summary.state !== "running" &&
					summary.reviewReason !== "unconfirmed" &&
					summary.startupRecoverySemanticStateUncertain !== true &&
					!followsSubmittedCodexInteraction) ||
				summary.agentId !== "codex"
			) {
				return unchanged();
			}
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "awaiting_review",
					reviewReason: "hook",
					nativeWorkEvidence: null,
					outstandingInteraction: {
						provider: "codex",
						kind: "permission",
						status: "waiting",
						requestEventName: "RenderedApprovalOverlay",
						openedAt: occurredAt,
						updatedAt: occurredAt,
						responseSubmittedAt: null,
						responseKind: null,
						sessionInstanceId: summary.sessionInstanceId ?? null,
						providerSessionId: summary.resumeSessionId ?? null,
						turnId: null,
						promptId: null,
						toolUseId: null,
						elicitationId: null,
						providerAgentId: null,
						toolName: null,
					},
					latestHookActivity: {
						activityText: "Waiting for approval",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "RenderedApprovalOverlay",
						notificationType: "permission.asked",
						source: "codex",
						conversationSummaryText: null,
					},
				},
				clearAttentionBuffer: true,
			};
		}
		case "interaction.response_submitted": {
			const interaction = summary.outstandingInteraction ?? inferLegacyOutstandingInteraction(summary);
			if (summary.state !== "awaiting_review" || !interaction || interaction.status !== "waiting") {
				return unchanged();
			}
			const occurredAt = event.occurredAt ?? Date.now();
			return {
				changed: true,
				patch: {
					outstandingInteraction: {
						...interaction,
						status: "response_submitted",
						updatedAt: occurredAt,
						responseSubmittedAt: occurredAt,
						responseKind: event.responseKind,
					},
				},
				clearAttentionBuffer: true,
			};
		}
		case "interrupt.recovery": {
			if (summary.state !== "running") return unchanged();
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "agent.rendered-turn-interrupted": {
			if (!canApplyCodexRenderedTurnInterruption(summary)) return unchanged();
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "user.stop": {
			if (summary.state !== "running" && summary.state !== "awaiting_review") return unchanged();
			if (
				summary.state === "awaiting_review" &&
				summary.reviewReason !== "attention" &&
				summary.reviewReason !== "unconfirmed" &&
				!deriveTaskIndicatorState(summary).needsInput &&
				!summary.outstandingInteraction
			) {
				return unchanged();
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "process.exit": {
			if (summary.state === "awaiting_review" && summary.outstandingInteraction) {
				if (event.interrupted && summary.startupRecoveryRequired === true) {
					return {
						changed: true,
						patch: { exitCode: event.exitCode, pid: null, nativeWorkEvidence: null },
						clearAttentionBuffer: false,
					};
				}
				if (event.interrupted) {
					return {
						changed: true,
						patch: {
							state: "awaiting_review",
							reviewReason: "interrupted",
							exitCode: event.exitCode,
							pid: null,
							latestHookActivity: null,
							outstandingInteraction: null,
							nativeWorkEvidence: null,
						},
						clearAttentionBuffer: true,
					};
				}
				const occurredAt = Date.now();
				return {
					changed: true,
					patch: {
						state: "awaiting_review",
						reviewReason: "error",
						exitCode: event.exitCode,
						pid: null,
						outstandingInteraction: {
							...summary.outstandingInteraction,
							status: "resolution_unknown",
							updatedAt: occurredAt,
						},
						nativeWorkEvidence: null,
						warningMessage: PROCESS_LOST_DURING_INTERACTION_WARNING,
					},
					clearAttentionBuffer: true,
				};
			}
			if (summary.state === "awaiting_review" && summary.reviewReason === "unconfirmed") {
				return {
					changed: true,
					patch: {
						reviewReason: event.interrupted ? "interrupted" : "error",
						exitCode: event.exitCode,
						pid: null,
						nativeWorkEvidence: null,
					},
					clearAttentionBuffer: false,
				};
			}
			if (summary.state === "awaiting_review") {
				return {
					changed: true,
					patch: { exitCode: event.exitCode, pid: null, nativeWorkEvidence: null },
					clearAttentionBuffer: false,
				};
			}
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) reason = "interrupted";
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
				},
				clearAttentionBuffer: false,
			};
		}
		case "autorestart.denied": {
			return unchanged();
		}
		case "resume.failed": {
			const unresolvedInteraction = summary.outstandingInteraction
				? {
						...summary.outstandingInteraction,
						status: "resolution_unknown" as const,
						updatedAt: Date.now(),
					}
				: null;
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					outstandingInteraction: unresolvedInteraction,
					nativeWorkEvidence: null,
					...(event.clearResumeSessionId ? { resumeSessionId: null } : {}),
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.owner_activated": {
			return {
				changed: true,
				patch: {
					pid: event.pid,
					sessionInstanceId: event.sessionInstanceId,
					exitCode: null,
					startupRecoveryRequired: false,
				},
				clearAttentionBuffer: false,
			};
		}
		case "structured.turn_started": {
			const confirmedAt = Date.now();
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "running",
					reviewReason: null,
					pid: event.pid,
					sessionInstanceId: event.sessionInstanceId,
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: {
						provider: summary.agentId === "claude" ? "claude" : "codex",
						sessionInstanceId: event.sessionInstanceId,
						providerSessionId: summary.resumeSessionId ?? null,
						turnId: null,
						hookEventName: "StructuredTurnStarted",
						confirmedAt,
						expiresAt: Number.MAX_SAFE_INTEGER,
					},
					stalledSince: null,
					warningMessage: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.turn_completed": {
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					stalledSince: null,
					warningMessage: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.turn_failed": {
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					latestHookActivity: null,
					outstandingInteraction: summary.outstandingInteraction
						? { ...summary.outstandingInteraction, status: "resolution_unknown", updatedAt: Date.now() }
						: null,
					nativeWorkEvidence: null,
					stalledSince: null,
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.interaction_requested": {
			const isApproval = event.interactionKind === "approval";
			const isElicitation = event.interactionKind === "elicitation";
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: isApproval ? "hook" : "attention",
					outstandingInteraction: {
						provider: event.provider,
						kind: event.interactionKind === "approval" ? "permission" : event.interactionKind,
						status: "waiting",
						requestEventName: isApproval
							? "StructuredApproval"
							: isElicitation
								? "StructuredElicitation"
								: "StructuredQuestion",
						openedAt: event.openedAt,
						updatedAt: event.openedAt,
						responseSubmittedAt: null,
						responseKind: null,
						sessionInstanceId: event.sessionInstanceId,
						providerSessionId: event.providerSessionId,
						turnId: event.turnId,
						promptId: event.interactionId,
						toolUseId: event.itemId,
						elicitationId: isElicitation ? event.itemId : null,
						providerAgentId: null,
						toolName: null,
					},
					latestHookActivity: {
						activityText: isApproval ? "Waiting for approval" : "Waiting for input",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: isApproval ? "PermissionRequest" : isElicitation ? "Elicitation" : "Question",
						notificationType: isApproval
							? "permission.asked"
							: isElicitation
								? "elicitation_dialog"
								: "question.asked",
						source: event.provider,
						conversationSummaryText: null,
					},
					nativeWorkEvidence: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.interaction_resolved": {
			const interaction = summary.outstandingInteraction;
			if (
				summary.state !== "awaiting_review" ||
				!interaction ||
				interaction.promptId !== event.interactionId ||
				!interaction.sessionInstanceId ||
				(interaction.provider !== "codex" && interaction.provider !== "claude")
			) {
				return unchanged();
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					latestHookActivity: null,
					outstandingInteraction: {
						...interaction,
						status: "response_submitted",
						updatedAt: event.resolvedAt,
						responseSubmittedAt: event.resolvedAt,
						responseKind: "submit",
					},
					nativeWorkEvidence: {
						provider: interaction.provider,
						sessionInstanceId: interaction.sessionInstanceId,
						providerSessionId: interaction.providerSessionId,
						turnId: interaction.turnId,
						hookEventName: "StructuredInteractionResolved",
						confirmedAt: event.resolvedAt,
						expiresAt: Number.MAX_SAFE_INTEGER,
					},
					stalledSince: null,
					warningMessage: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.interaction_cancelled": {
			const interaction = summary.outstandingInteraction;
			if (
				summary.state !== "awaiting_review" ||
				!interaction ||
				interaction.promptId !== event.interactionId ||
				(interaction.provider !== "codex" && interaction.provider !== "claude")
			) {
				return unchanged();
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "unconfirmed",
					latestHookActivity: null,
					outstandingInteraction: null,
					nativeWorkEvidence: null,
					stalledSince: null,
					warningMessage: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.owner_stopped": {
			if (!summary.outstandingInteraction) {
				return { changed: summary.pid !== null, patch: { pid: null }, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					pid: null,
					outstandingInteraction: {
						...summary.outstandingInteraction,
						status: "resolution_unknown",
						updatedAt: Date.now(),
					},
					nativeWorkEvidence: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "structured.owner_crashed": {
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					pid: null,
					latestHookActivity: null,
					outstandingInteraction: summary.outstandingInteraction
						? { ...summary.outstandingInteraction, status: "resolution_unknown", updatedAt: Date.now() }
						: null,
					nativeWorkEvidence: null,
					stalledSince: null,
					startupRecoveryRequired: true,
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "reconciliation.launch_path_missing": {
			if (summary.state !== "running" && summary.state !== "awaiting_review") return unchanged();
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					latestHookActivity: null,
					outstandingInteraction: summary.outstandingInteraction
						? {
								...summary.outstandingInteraction,
								status: "resolution_unknown",
								updatedAt: Date.now(),
							}
						: null,
					nativeWorkEvidence: null,
					stalledSince: null,
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "startup_recovery.exhausted": {
			const unresolvedInteraction = summary.outstandingInteraction
				? {
						...summary.outstandingInteraction,
						status: "resolution_unknown" as const,
						updatedAt: Date.now(),
					}
				: null;
			if (event.fallbackReviewState && !unresolvedInteraction) {
				return {
					changed: true,
					patch: {
						state: "awaiting_review",
						reviewReason: event.fallbackReviewState.reviewReason,
						...(event.processStillRunning ? {} : { pid: null }),
						lastHookAt: event.fallbackReviewState.lastHookAt,
						latestHookActivity: event.fallbackReviewState.latestHookActivity
							? { ...event.fallbackReviewState.latestHookActivity }
							: null,
						outstandingInteraction: null,
						nativeWorkEvidence: null,
						stalledSince: null,
						startupRecoveryRequired: false,
						...(event.clearResumeSessionId ? { resumeSessionId: null } : {}),
						warningMessage: event.warningMessage,
					},
					clearAttentionBuffer: true,
				};
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					...(event.processStillRunning ? {} : { pid: null }),
					latestHookActivity: unresolvedInteraction ? summary.latestHookActivity : null,
					outstandingInteraction: unresolvedInteraction,
					nativeWorkEvidence: null,
					stalledSince: null,
					startupRecoveryRequired: false,
					...(event.clearResumeSessionId ? { resumeSessionId: null } : {}),
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "native_work.evidence_expired": {
			const evidence = summary.nativeWorkEvidence;
			const occurredAt = event.occurredAt ?? Date.now();
			if (
				summary.state !== "running" ||
				!evidence ||
				evidence.confirmedAt !== event.confirmedAt ||
				evidence.expiresAt > occurredAt
			) {
				return unchanged();
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "unconfirmed",
					nativeWorkEvidence: null,
					outstandingInteraction: null,
					stalledSince: null,
				},
				clearAttentionBuffer: false,
			};
		}
	}
}
