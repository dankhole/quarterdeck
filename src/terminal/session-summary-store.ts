// Owns the Map<taskId, RuntimeTaskSessionSummary> and all pure-data mutations.
// TerminalSessionManager delegates summary operations here; external callers
// (TRPC handlers, project-registry, shutdown-coordinator) read/mutate through
// this interface instead of reaching into the terminal layer.
//
// Designed as a synchronous, process-agnostic store so it maps 1:1 to a Go interface.

import {
	type ConversationSummaryEntry,
	createTaggedLogger,
	normalizeRuntimeTaskSessionSummary,
	type RuntimeHookMetadata,
	type RuntimeTaskHookActivity,
	type RuntimeTaskProviderHookOrderObservation,
	type RuntimeTaskSessionSummary,
	type RuntimeTaskTurnCheckpoint,
} from "../core";
import { compactDisplaySummaryText } from "../title";
import { deriveStartupRecoveryPolicy } from "./session-startup-recovery-policy";
import {
	inferLegacyOutstandingInteraction,
	reduceSessionTransition,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-state-machine";

const storeLog = createTaggedLogger("session-store");
const MAX_RECENT_PROVIDER_HOOK_DELIVERY_IDS = 128;
const MAX_RECENT_PROVIDER_HOOK_ORDER_OBSERVATIONS = 512;

export type { SessionTransitionEvent, SessionTransitionResult };

export interface SessionSummaryStore {
	// Reads
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];

	// Lifecycle
	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void;
	ensureEntry(taskId: string): RuntimeTaskSessionSummary;

	// Low-level update (used by session-manager for PTY event patches)
	update(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary | null;

	// State machine transitions
	applySessionEvent(
		taskId: string,
		event: SessionTransitionEvent,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
	recordProviderHookReceipt(
		taskId: string,
		observation: RuntimeTaskProviderHookOrderObservation | null,
	): RuntimeTaskSessionSummary | null;

	// Domain mutations
	appendConversationSummary(
		taskId: string,
		entry: { text: string; capturedAt: number },
	): RuntimeTaskSessionSummary | null;
	setDisplaySummary(taskId: string, text: string, generatedAt: number | null): RuntimeTaskSessionSummary | null;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;

	// Bulk operations
	markAllInterrupted(
		activeTaskIds: string[],
		options?: { forceInterruptedTaskIds?: ReadonlySet<string> },
	): RuntimeTaskSessionSummary[];

	// Recovery
	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null;

	// Subscription
	onChange(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		sessionInstanceId: null,
		launchOperationId: null,
		state: "idle",
		agentId: null,
		sessionLaunchPath: null,
		resumeSessionId: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		lastProviderHookOccurredAt: null,
		recentProviderHookDeliveryIds: [],
		recentProviderHookOrderObservations: [],
		latestHookActivity: null,
		outstandingInteraction: null,
		nativeWorkEvidence: null,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

export function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		recentProviderHookDeliveryIds: [...summary.recentProviderHookDeliveryIds],
		recentProviderHookOrderObservations: summary.recentProviderHookOrderObservations.map((entry) => ({ ...entry })),
		latestHookActivity: summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
		outstandingInteraction: summary.outstandingInteraction ? { ...summary.outstandingInteraction } : null,
		nativeWorkEvidence: summary.nativeWorkEvidence ? { ...summary.nativeWorkEvidence } : null,
		latestTurnCheckpoint: summary.latestTurnCheckpoint ? { ...summary.latestTurnCheckpoint } : null,
		previousTurnCheckpoint: summary.previousTurnCheckpoint ? { ...summary.previousTurnCheckpoint } : null,
		conversationSummaries: summary.conversationSummaries.map((entry) => ({ ...entry })),
	};
}

function isActiveState(state: RuntimeTaskSessionSummary["state"]): boolean {
	return state === "running" || state === "awaiting_review";
}

function buildNextHookActivity(
	previous: RuntimeTaskHookActivity | null,
	activity: Partial<RuntimeTaskHookActivity>,
): RuntimeTaskHookActivity | null {
	const normalizedHookEvent = activity.hookEventName?.toLowerCase() ?? "";
	const isSessionIdentityOnly =
		(normalizedHookEvent === "session_meta" || normalizedHookEvent === "sessionstart") &&
		typeof activity.activityText !== "string" &&
		typeof activity.toolName !== "string" &&
		typeof activity.toolInputSummary !== "string" &&
		typeof activity.finalMessage !== "string" &&
		typeof activity.conversationSummaryText !== "string" &&
		typeof activity.notificationType !== "string";
	if (isSessionIdentityOnly) {
		return previous;
	}

	const hasActivityUpdate =
		typeof activity.activityText === "string" ||
		typeof activity.toolName === "string" ||
		typeof activity.toolInputSummary === "string" ||
		typeof activity.finalMessage === "string" ||
		typeof activity.hookEventName === "string" ||
		typeof activity.notificationType === "string" ||
		typeof activity.source === "string";
	if (!hasActivityUpdate) {
		return previous;
	}

	const isNewEvent = typeof activity.hookEventName === "string" || typeof activity.notificationType === "string";
	return {
		activityText:
			typeof activity.activityText === "string"
				? activity.activityText
				: isNewEvent
					? null
					: (previous?.activityText ?? null),
		toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
		toolInputSummary:
			typeof activity.toolInputSummary === "string"
				? activity.toolInputSummary
				: (previous?.toolInputSummary ?? null),
		finalMessage:
			typeof activity.finalMessage === "string"
				? activity.finalMessage
				: isNewEvent
					? null
					: (previous?.finalMessage ?? null),
		hookEventName:
			typeof activity.hookEventName === "string"
				? activity.hookEventName
				: isNewEvent
					? null
					: (previous?.hookEventName ?? null),
		notificationType:
			typeof activity.notificationType === "string"
				? activity.notificationType
				: isNewEvent
					? null
					: (previous?.notificationType ?? null),
		source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		conversationSummaryText:
			typeof activity.conversationSummaryText === "string"
				? activity.conversationSummaryText
				: (previous?.conversationSummaryText ?? null),
	};
}

function didHookActivityChange(
	previous: RuntimeTaskHookActivity | null,
	next: RuntimeTaskHookActivity | null,
): boolean {
	return (
		(next?.activityText ?? null) !== (previous?.activityText ?? null) ||
		(next?.toolName ?? null) !== (previous?.toolName ?? null) ||
		(next?.toolInputSummary ?? null) !== (previous?.toolInputSummary ?? null) ||
		(next?.finalMessage ?? null) !== (previous?.finalMessage ?? null) ||
		(next?.hookEventName ?? null) !== (previous?.hookEventName ?? null) ||
		(next?.notificationType ?? null) !== (previous?.notificationType ?? null) ||
		(next?.source ?? null) !== (previous?.source ?? null) ||
		(next?.conversationSummaryText ?? null) !== (previous?.conversationSummaryText ?? null)
	);
}

function buildHookMetadataPatch(
	taskId: string,
	entry: RuntimeTaskSessionSummary,
	metadata: RuntimeHookMetadata,
	timestamp: number,
): Partial<RuntimeTaskSessionSummary> | null {
	const previousActivity = entry.latestHookActivity;
	const nextActivity = buildNextHookActivity(previousActivity, metadata);
	const normalizedSessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : null;
	const nextResumeSessionId = normalizedSessionId ?? entry.resumeSessionId ?? null;
	const activityChanged = didHookActivityChange(previousActivity, nextActivity);
	const resumeSessionIdChanged = nextResumeSessionId !== (entry.resumeSessionId ?? null);
	if (metadata.sessionId || resumeSessionIdChanged) {
		storeLog.debug("applyHookMetadata session-id check", {
			taskId,
			incomingSessionId: metadata.sessionId ?? null,
			normalizedSessionId,
			previousResumeSessionId: entry.resumeSessionId ?? null,
			nextResumeSessionId,
			resumeSessionIdChanged,
			activityChanged,
			hookEventName: metadata.hookEventName ?? null,
			source: metadata.source ?? null,
		});
	}
	if (!activityChanged && !resumeSessionIdChanged) {
		return null;
	}

	return {
		...(activityChanged
			? {
					lastHookAt: timestamp,
					latestHookActivity: nextActivity,
					stalledSince: null,
				}
			: {}),
		...(resumeSessionIdChanged ? { resumeSessionId: nextResumeSessionId } : {}),
	};
}

// ── Implementation ───────────────────────────────────────────────────────────

export class InMemorySessionSummaryStore implements SessionSummaryStore {
	private readonly entries = new Map<string, RuntimeTaskSessionSummary>();
	private readonly listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();

	// ── Reads ─────────────────────────────────────────────────────────────

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map(cloneSummary);
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			const migrated = normalizeRuntimeTaskSessionSummary(cloneSummary(summary), {
				invalidateNativeWorkEvidence: true,
			});
			migrated.outstandingInteraction =
				migrated.outstandingInteraction ?? inferLegacyOutstandingInteraction(migrated);
			this.entries.set(taskId, migrated);
		}
	}

	ensureEntry(taskId: string): RuntimeTaskSessionSummary {
		const existing = this.entries.get(taskId);
		if (existing) {
			return cloneSummary(existing);
		}
		const created = createDefaultSummary(taskId);
		this.entries.set(taskId, created);
		return cloneSummary(created);
	}

	// ── Low-level update ──────────────────────────────────────────────────

	update(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const updated = normalizeRuntimeTaskSessionSummary(
			{
				...entry,
				...patch,
				updatedAt: now(),
			},
			{ now: now() },
		);
		this.entries.set(taskId, updated);
		this.emit(updated);
		return cloneSummary(updated);
	}

	// ── State machine transitions ─────────────────────────────────────────

	applySessionEvent(
		taskId: string,
		event: SessionTransitionEvent,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const transition = reduceSessionTransition(entry, event);
		const timestamp = now();
		const semanticSummary: RuntimeTaskSessionSummary = {
			...entry,
			...transition.patch,
		};
		const hookMetadata = event.type === "provider.hook" ? event.metadata : undefined;
		const metadataMode = transition.hookMetadataMode ?? (hookMetadata ? "apply" : "preserve");
		const metadataForPatch =
			metadataMode === "apply"
				? hookMetadata
				: metadataMode === "identity_only" && hookMetadata?.sessionId
					? ({ sessionId: hookMetadata.sessionId } satisfies RuntimeHookMetadata)
					: undefined;
		const metadataPatch = metadataForPatch
			? buildHookMetadataPatch(taskId, semanticSummary, metadataForPatch, timestamp)
			: null;
		if (!transition.changed && !metadataPatch) {
			return { ...transition, summary: cloneSummary(entry) };
		}
		const updated = normalizeRuntimeTaskSessionSummary(
			{
				...semanticSummary,
				...(metadataPatch ?? {}),
				updatedAt: timestamp,
			},
			{ now: timestamp },
		);
		// Reset hook activity timing when a reviewed task returns to running so
		// diagnostics reflect the current active turn, not the prior review stop.
		if (transition.changed && transition.patch.state === "running" && !metadataPatch?.lastHookAt) {
			updated.lastHookAt = timestamp;
		}
		this.entries.set(taskId, updated);
		this.emit(updated);
		return { ...transition, summary: cloneSummary(updated) };
	}

	recordProviderHookReceipt(
		taskId: string,
		observation: RuntimeTaskProviderHookOrderObservation | null,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry || !observation || observation.sessionInstanceId !== entry.sessionInstanceId) {
			return entry ? cloneSummary(entry) : null;
		}
		const hasDelivery = entry.recentProviderHookDeliveryIds.includes(observation.deliveryId);
		const hasObservation = entry.recentProviderHookOrderObservations.some(
			(candidate) => candidate.deliveryId === observation.deliveryId,
		);
		if (hasDelivery && hasObservation) return cloneSummary(entry);

		const updated: RuntimeTaskSessionSummary = {
			...entry,
			lastProviderHookOccurredAt: Math.max(entry.lastProviderHookOccurredAt ?? 0, observation.occurredAt),
			recentProviderHookDeliveryIds: hasDelivery
				? entry.recentProviderHookDeliveryIds
				: [...entry.recentProviderHookDeliveryIds, observation.deliveryId].slice(
						-MAX_RECENT_PROVIDER_HOOK_DELIVERY_IDS,
					),
			recentProviderHookOrderObservations: hasObservation
				? entry.recentProviderHookOrderObservations
				: [...entry.recentProviderHookOrderObservations, observation].slice(
						-MAX_RECENT_PROVIDER_HOOK_ORDER_OBSERVATIONS,
					),
			updatedAt: now(),
		};
		this.entries.set(taskId, updated);
		this.emit(updated);
		return cloneSummary(updated);
	}

	// ── Domain mutations ──────────────────────────────────────────────────

	appendConversationSummary(
		taskId: string,
		entry: { text: string; capturedAt: number },
	): RuntimeTaskSessionSummary | null {
		const sessionEntry = this.entries.get(taskId);
		if (!sessionEntry) {
			return null;
		}

		// Truncate hook-provided text to 500 chars as a UI/state safety net.
		const text = entry.text.length > 500 ? `${entry.text.slice(0, 500)}\u2026` : entry.text;

		// Auto-assign sessionIndex from the highest existing index.
		const existing = sessionEntry.conversationSummaries;
		const maxIndex = existing.reduce((max, e) => Math.max(max, e.sessionIndex), -1);
		const newEntry: ConversationSummaryEntry = {
			text,
			capturedAt: entry.capturedAt,
			sessionIndex: maxIndex + 1,
		};

		let entries = [...existing, newEntry];

		// Retention: count limit first (max 5), then character cap (max 2000).
		// Always retain the first entry (index 0 in array) and the latest (just appended).
		if (entries.length > 5) {
			const first = entries[0] as (typeof entries)[number];
			const latest = entries[entries.length - 1] as (typeof entries)[number];
			// Drop oldest non-first entries until count <= 5.
			const middle = entries.slice(1, -1);
			const keep = 5 - 2; // slots for first + latest
			entries = [first, ...middle.slice(middle.length - keep), latest];
		}

		// Character cap: sum all text lengths, drop oldest non-first (excluding latest) until <= 2000.
		while (entries.length > 2) {
			const totalChars = entries.reduce((sum, e) => sum + e.text.length, 0);
			if (totalChars <= 2000) break;
			// Drop the second entry (oldest non-first, excluding latest which is last).
			entries.splice(1, 1);
		}

		const patch: Partial<RuntimeTaskSessionSummary> = {
			conversationSummaries: entries,
			displaySummary: compactDisplaySummaryText(text),
			displaySummaryGeneratedAt: null,
		};

		return this.update(taskId, patch);
	}

	setDisplaySummary(taskId: string, text: string, generatedAt: number | null): RuntimeTaskSessionSummary | null {
		return this.update(taskId, {
			displaySummary: text,
			displaySummaryGeneratedAt: generatedAt,
		});
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry);
		}

		return this.update(taskId, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
	}

	// ── Bulk operations ───────────────────────────────────────────────────

	markAllInterrupted(
		activeTaskIds: string[],
		options?: { forceInterruptedTaskIds?: ReadonlySet<string> },
	): RuntimeTaskSessionSummary[] {
		const results: RuntimeTaskSessionSummary[] = [];
		for (const taskId of activeTaskIds) {
			const entry = this.entries.get(taskId);
			if (!entry) {
				continue;
			}
			// Runtime shutdown invalidates process ownership, not the semantic
			// handoff already shown to the user. Preserve Review/Needs Input/Error
			// meaning and persist whether a replacement runtime should restore the
			// interactive chat. Only work that was actually running becomes
			// interrupted.
			const preserveReviewState =
				entry.state === "awaiting_review" &&
				entry.reviewReason !== null &&
				entry.reviewReason !== "unconfirmed" &&
				!options?.forceInterruptedTaskIds?.has(taskId);
			const startupRecoveryRequired = deriveStartupRecoveryPolicy(entry).required;
			const updated = this.update(
				taskId,
				preserveReviewState
					? {
							pid: null,
							startupRecoveryRequired,
						}
					: {
							state: "awaiting_review",
							reviewReason: "interrupted",
							pid: null,
							latestHookActivity: null,
							outstandingInteraction: null,
							nativeWorkEvidence: null,
							stalledSince: null,
							startupRecoveryRequired: true,
						},
			);
			if (updated) {
				results.push(updated);
			}
		}
		return results;
	}

	// ── Recovery ──────────────────────────────────────────────────────────

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (!isActiveState(entry.state)) {
			return cloneSummary(entry);
		}

		// Preserve agentId so the server can route to the correct agent type
		// when a task is restored from trash.
		return this.update(taskId, {
			state: "idle",
			sessionLaunchPath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			lastProviderHookOccurredAt: null,
			recentProviderHookDeliveryIds: [],
			recentProviderHookOrderObservations: [],
			latestHookActivity: null,
			outstandingInteraction: null,
			nativeWorkEvidence: null,
			stalledSince: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
	}

	// ── Subscription ──────────────────────────────────────────────────────

	onChange(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private emit(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
