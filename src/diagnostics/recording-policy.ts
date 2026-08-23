import type { DiagnosticRecordingScope, DiagnosticRecordingState } from "../core";
import type { DiagnosticRecordCandidate } from "./diagnostic-record";

const MAX_DEEP_RECORDING_MS = 15 * 60 * 1_000;
export type DiagnosticAdmissionProfile = "flight" | "agent-lab";

function scopeMatches(candidate: DiagnosticRecordCandidate, scope: DiagnosticRecordingScope): boolean {
	if (scope.projectId && candidate.context?.projectId !== scope.projectId) return false;
	if (scope.taskId && candidate.context?.taskId !== scope.taskId) return false;
	if (scope.categories.length > 0) {
		if (
			!scope.categories.some((category) => candidate.name === category || candidate.name.startsWith(`${category}.`))
		) {
			return false;
		}
	}
	return true;
}

export class DiagnosticRecordingPolicy {
	private state: DiagnosticRecordingState;
	private expiryTimer: NodeJS.Timeout | null = null;
	private readonly listeners = new Set<(state: DiagnosticRecordingState) => void>();

	constructor(private readonly profile: DiagnosticAdmissionProfile = "flight") {
		this.state =
			profile === "agent-lab"
				? { active: true, startedAt: Date.now(), expiresAt: null, scope: { categories: [] } }
				: { active: false, startedAt: null, expiresAt: null, scope: null };
	}

	shouldAdmit(candidate: DiagnosticRecordCandidate): boolean {
		if (this.profile === "agent-lab") return true;
		this.expireIfNeeded();
		if (candidate.essential || candidate.kind === "mark" || candidate.kind === "recorder_health") return true;
		if (candidate.level === "warn" || candidate.level === "error") return true;
		return Boolean(this.state.active && this.state.scope && scopeMatches(candidate, this.state.scope));
	}

	start(durationMs: number, scope: DiagnosticRecordingScope): DiagnosticRecordingState {
		if (this.profile === "agent-lab") return this.getState();
		const boundedDurationMs = Math.min(Math.max(1_000, Math.floor(durationMs)), MAX_DEEP_RECORDING_MS);
		const now = Date.now();
		this.state = {
			active: true,
			startedAt: now,
			expiresAt: now + boundedDurationMs,
			scope: {
				...scope,
				categories: [...scope.categories],
			},
		};
		this.armExpiryTimer(boundedDurationMs);
		this.notify();
		return this.getState();
	}

	stop(): DiagnosticRecordingState {
		if (this.profile === "agent-lab") return this.getState();
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
		this.state = {
			active: false,
			startedAt: null,
			expiresAt: null,
			scope: null,
		};
		this.notify();
		return this.getState();
	}

	getState(): DiagnosticRecordingState {
		this.expireIfNeeded();
		return {
			...this.state,
			scope: this.state.scope ? { ...this.state.scope, categories: [...this.state.scope.categories] } : null,
		};
	}

	onChange(listener: (state: DiagnosticRecordingState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
		this.listeners.clear();
	}

	private expireIfNeeded(): void {
		if (!this.state.active || this.state.expiresAt === null || this.state.expiresAt > Date.now()) return;
		this.stop();
	}

	private armExpiryTimer(durationMs: number): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = setTimeout(() => this.stop(), durationMs);
		this.expiryTimer.unref();
	}

	private notify(): void {
		const state = this.getState();
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch {
				// Diagnostics listeners cannot affect recorder policy.
			}
		}
	}
}

export { MAX_DEEP_RECORDING_MS };
