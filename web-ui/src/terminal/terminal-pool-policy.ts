import type { SlotRole } from "@/terminal/terminal-pool-types";
import type { TerminalSlot } from "@/terminal/terminal-slot";

type TimerId = ReturnType<typeof setTimeout>;

const WARMUP_TIMEOUT_MS = 3_000;
const WARMUP_MAX_TTL_MS = 12_000;
/** How long a PREVIOUS slot stays connected before auto-eviction. Keeps instant
 *  switch-back for quick peeks while bounding hidden terminal streams tightly. */
const PREVIOUS_EVICTION_MS = 8_000;

type WarmupEvictionReason = "cancelWarmup" | "warmupMaxTtl";

interface TerminalPoolPolicyOptions {
	getSlots: () => readonly TerminalSlot[];
	getRole: (slot: TerminalSlot) => SlotRole;
	setRole: (slot: TerminalSlot, role: SlotRole) => void;
	findNewestSlotByRole: (role: SlotRole) => TerminalSlot | null;
	evictSlot: (slot: TerminalSlot) => void;
	evictWarmupSlot: (taskId: string, reason: WarmupEvictionReason) => void;
	logDebug: (message: string, metadata?: Record<string, unknown>) => void;
}

export class TerminalPoolPolicy {
	private readonly warmupTimeouts = new Map<string, TimerId>();
	private readonly warmupMaxTtlTimeouts = new Map<string, TimerId>();
	private readonly previousEvictionTimers = new Map<TerminalSlot, TimerId>();

	constructor(private readonly options: TerminalPoolPolicyOptions) {}

	clearPreviousEvictionTimer(slot: TerminalSlot): void {
		const timeout = this.previousEvictionTimers.get(slot);
		if (timeout === undefined) {
			return;
		}
		clearTimeout(timeout);
		this.previousEvictionTimers.delete(slot);
	}

	clearAllPreviousEvictionTimers(): void {
		for (const [, timeout] of this.previousEvictionTimers) {
			clearTimeout(timeout);
		}
		this.previousEvictionTimers.clear();
	}

	prepareSlotForActiveRole(slot: TerminalSlot): SlotRole {
		const previousRole = this.options.getRole(slot);
		if (previousRole === "PREVIOUS") {
			this.clearPreviousEvictionTimer(slot);
		}
		const demotedPrevious = this.demoteActiveSlotsExcept(slot);
		this.options.setRole(slot, "ACTIVE");
		const retainedPrevious =
			demotedPrevious ?? (previousRole === "ACTIVE" ? this.options.findNewestSlotByRole("PREVIOUS") : null);
		this.evictStalePreviousSlots(retainedPrevious);
		return previousRole;
	}

	demoteActiveSlotsExcept(nextActiveSlot: TerminalSlot | null): TerminalSlot | null {
		let retainedPrevious: TerminalSlot | null = null;
		for (const slot of this.options.getSlots()) {
			if (slot === nextActiveSlot || this.options.getRole(slot) !== "ACTIVE") {
				continue;
			}
			this.options.setRole(slot, "PREVIOUS");
			this.schedulePreviousEviction(slot);
			retainedPrevious = slot;
			this.options.logDebug(`active transition — demoted slot ${slot.slotId} to PREVIOUS`);
		}
		return retainedPrevious;
	}

	evictStalePreviousSlots(retainedPrevious: TerminalSlot | null): void {
		for (const slot of this.options.getSlots()) {
			if (slot !== retainedPrevious && this.options.getRole(slot) === "PREVIOUS") {
				this.options.logDebug(`active transition — evicting stale PREVIOUS slot ${slot.slotId}`);
				this.options.evictSlot(slot);
			}
		}
	}

	clearWarmupTimeout(taskId: string): void {
		const timeout = this.warmupTimeouts.get(taskId);
		if (timeout !== undefined) {
			clearTimeout(timeout);
			this.warmupTimeouts.delete(taskId);
		}
	}

	clearWarmupMaxTtlTimeout(taskId: string): void {
		const timeout = this.warmupMaxTtlTimeouts.get(taskId);
		if (timeout !== undefined) {
			clearTimeout(timeout);
			this.warmupMaxTtlTimeouts.delete(taskId);
		}
	}

	clearWarmupTimers(taskId: string): void {
		this.clearWarmupTimeout(taskId);
		this.clearWarmupMaxTtlTimeout(taskId);
	}

	clearAllWarmupTimers(): void {
		for (const [, timeout] of this.warmupTimeouts) {
			clearTimeout(timeout);
		}
		this.warmupTimeouts.clear();
		for (const [, timeout] of this.warmupMaxTtlTimeouts) {
			clearTimeout(timeout);
		}
		this.warmupMaxTtlTimeouts.clear();
	}

	scheduleWarmupMaxTtl(taskId: string): void {
		const maxTtlTimeoutId = setTimeout(() => {
			if (this.warmupMaxTtlTimeouts.get(taskId) !== maxTtlTimeoutId) {
				return;
			}
			this.warmupMaxTtlTimeouts.delete(taskId);
			this.options.evictWarmupSlot(taskId, "warmupMaxTtl");
		}, WARMUP_MAX_TTL_MS);
		this.warmupMaxTtlTimeouts.set(taskId, maxTtlTimeoutId);
	}

	scheduleCancelWarmup(taskId: string): void {
		this.clearWarmupMaxTtlTimeout(taskId);
		// Already has a pending eviction timeout — leave it running.
		if (this.warmupTimeouts.has(taskId)) {
			return;
		}
		const timeoutId = setTimeout(() => {
			this.warmupTimeouts.delete(taskId);
			this.options.evictWarmupSlot(taskId, "cancelWarmup");
		}, WARMUP_TIMEOUT_MS);
		this.warmupTimeouts.set(taskId, timeoutId);
	}

	clearAllTimers(): void {
		this.clearAllWarmupTimers();
		this.clearAllPreviousEvictionTimers();
	}

	private schedulePreviousEviction(slot: TerminalSlot): void {
		this.clearPreviousEvictionTimer(slot);
		const timeout = setTimeout(() => {
			if (this.previousEvictionTimers.get(slot) !== timeout) {
				return;
			}
			this.previousEvictionTimers.delete(slot);
			if (this.options.getRole(slot) === "PREVIOUS") {
				this.options.logDebug(
					`previous eviction — auto-evicting slot ${slot.slotId} after ${PREVIOUS_EVICTION_MS}ms`,
				);
				this.options.evictSlot(slot);
			}
		}, PREVIOUS_EVICTION_MS);
		this.previousEvictionTimers.set(slot, timeout);
	}
}
