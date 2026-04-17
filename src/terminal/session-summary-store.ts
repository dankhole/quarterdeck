// Owns the Map<taskId, RuntimeTaskSessionSummary> and all pure-data mutations.
// TerminalSessionManager delegates summary operations here; external callers
// (TRPC handlers, workspace-registry, shutdown-coordinator) read/mutate through
// this interface instead of reaching into the terminal layer.
//
// Designed as a synchronous, process-agnostic store so it maps 1:1 to a Go interface.

import type {
	ConversationSummaryEntry,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core";
import { DISPLAY_SUMMARY_MAX_LENGTH } from "../title";
import {
	reduceSessionTransition,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-state-machine";

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

	// Domain mutations
	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null;
	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null;
	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null;
	appendConversationSummary(
		taskId: string,
		entry: { text: string; capturedAt: number },
	): RuntimeTaskSessionSummary | null;
	setDisplaySummary(taskId: string, text: string, generatedAt: number | null): RuntimeTaskSessionSummary | null;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;

	// Bulk operations
	markAllInterrupted(activeTaskIds: string[]): RuntimeTaskSessionSummary[];

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
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
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
	return { ...summary };
}

function isActiveState(state: RuntimeTaskSessionSummary["state"]): boolean {
	return state === "running" || state === "awaiting_review";
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
			this.entries.set(taskId, cloneSummary(summary));
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
		const updated: RuntimeTaskSessionSummary = {
			...entry,
			...patch,
			updatedAt: now(),
		};
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
		if (!transition.changed) {
			return { ...transition, summary: cloneSummary(entry) };
		}
		const updated: RuntimeTaskSessionSummary = {
			...entry,
			...transition.patch,
			updatedAt: now(),
		};
		// Reset the hook timer on any state-machine transition to running so that
		// prior idle time (review, attention, etc.) doesn't count toward the
		// stalled detection threshold.
		if (transition.patch.state === "running") {
			updated.lastHookAt = now();
		}
		this.entries.set(taskId, updated);
		this.emit(updated);
		return { ...transition, summary: cloneSummary(updated) };
	}

	// ── Domain mutations ──────────────────────────────────────────────────

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		if (reason !== "hook") {
			const entry = this.entries.get(taskId);
			return entry ? cloneSummary(entry) : null;
		}
		const result = this.applySessionEvent(taskId, { type: "hook.to_review" });
		return result ? result.summary : null;
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const result = this.applySessionEvent(taskId, { type: "hook.to_in_progress" });
		if (!result) {
			return null;
		}
		if (result.changed && result.summary.latestHookActivity) {
			// Clear hook activity on transition to running — matches original session-manager behavior.
			return this.update(taskId, { latestHookActivity: null });
		}
		return result.summary;
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
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
			return cloneSummary(entry);
		}

		const previous = entry.latestHookActivity;
		const isNewEvent = typeof activity.hookEventName === "string" || typeof activity.notificationType === "string";
		const next: RuntimeTaskHookActivity = {
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

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null) ||
			next.conversationSummaryText !== (previous?.conversationSummaryText ?? null);
		if (!didChange) {
			return cloneSummary(entry);
		}

		return this.update(taskId, {
			lastHookAt: now(),
			latestHookActivity: next,
			stalledSince: null,
		});
	}

	appendConversationSummary(
		taskId: string,
		entry: { text: string; capturedAt: number },
	): RuntimeTaskSessionSummary | null {
		const sessionEntry = this.entries.get(taskId);
		if (!sessionEntry) {
			return null;
		}

		// Truncate text to 500 chars as a safety net (parser already caps at 500).
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
			const first = entries[0]!;
			const latest = entries[entries.length - 1]!;
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

		// Only overwrite displaySummary with raw text if there's no existing LLM-generated
		// summary. When the user has autoGenerateSummary enabled, we don't want a raw last
		// message to clobber a nicely condensed LLM summary. We preserve
		// displaySummaryGeneratedAt so it continues to act as a sentinel — staleness is
		// detected by comparing the generation timestamp against conversationSummaries
		// capturedAt in the generateDisplaySummary endpoint.
		const hasLlmSummary = sessionEntry.displaySummaryGeneratedAt !== null;
		const rawDisplay =
			text.length > DISPLAY_SUMMARY_MAX_LENGTH ? `${text.slice(0, DISPLAY_SUMMARY_MAX_LENGTH)}\u2026` : text;

		const patch: Partial<RuntimeTaskSessionSummary> = {
			conversationSummaries: entries,
		};
		if (!hasLlmSummary) {
			patch.displaySummary = rawDisplay;
		}

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

	markAllInterrupted(activeTaskIds: string[]): RuntimeTaskSessionSummary[] {
		const results: RuntimeTaskSessionSummary[] = [];
		for (const taskId of activeTaskIds) {
			const entry = this.entries.get(taskId);
			if (!entry) {
				continue;
			}
			const updated = this.update(taskId, {
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
			});
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
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
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
