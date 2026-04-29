import {
	_disposeAllDedicatedTerminalsForTesting,
	disposeAllDedicatedTerminalsForProject,
	disposeDedicatedTerminal,
	type EnsureDedicatedTerminalInput,
	ensureDedicatedTerminal as ensureDedicatedTerminalInRegistry,
	forEachDedicatedTerminal,
	isDedicatedTerminalTaskId,
} from "@/terminal/terminal-dedicated-registry";
import {
	collectTerminalDebugState as collectTerminalDebugStateFromProvider,
	createTerminalDomHealthMonitor,
	dumpTerminalDebugInfo as dumpTerminalDebugInfoFromProvider,
	installTerminalDebugHook,
	type RegisteredTerminalDebugSnapshot,
	type TerminalDebugSnapshotProvider,
	type TerminalDebugState,
} from "@/terminal/terminal-pool-diagnostics";
import { TerminalPoolPolicy } from "@/terminal/terminal-pool-policy";
import { TerminalPoolState } from "@/terminal/terminal-pool-state";
import type { SlotRole } from "@/terminal/terminal-pool-types";
import { type PersistentTerminalAppearance, TerminalSlot } from "@/terminal/terminal-slot";
import {
	isTerminalSessionRunning as isTerminalSessionRunningAcrossSurfaces,
	resetAllTerminalRenderers as resetAllTerminalRenderersAcrossSurfaces,
	setTerminalFontWeight as setTerminalFontWeightAcrossSurfaces,
	type TerminalSurfaceProvider,
	writeToTerminalBuffer as writeToTerminalBufferAcrossSurfaces,
} from "@/terminal/terminal-surface-helpers";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("terminal-pool");

interface ViteHotContext {
	dispose(callback: () => void): void;
}

export type { RegisteredTerminalDebugSnapshot, SlotRole, TerminalDebugState };

const poolState = new TerminalPoolState();

// Retained for future destroyPool() cleanup.
let _rotationTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let nextSlotId = 0;
let poolContainer: HTMLDivElement | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_SIZE = 4;
const ROTATION_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** Default appearance for pool slots at init — real appearance is set on show(). */
const DEFAULT_POOL_APPEARANCE: PersistentTerminalAppearance = {
	cursorColor: "#ffffff",
	terminalBackgroundColor: "#000000",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find a FREE slot or evict PRELOADING (oldest first), then READY (oldest first).
 * When evicting: cancel warmup timeout, remove from task index, disconnect -> FREE.
 * Returns null if no evictable slot is found.
 */
function findFreeOrEvict(): TerminalSlot | null {
	// 1. Look for the newest FREE slot — leaves the oldest FREE for rotation to recycle.
	const free = poolState.findNewestSlotByRole("FREE");
	if (free) {
		return free;
	}
	// 2. Evict oldest PRELOADING
	const preloading = poolState.findOldestSlotByRole("PRELOADING");
	if (preloading) {
		evictSlot(preloading);
		return preloading;
	}
	// 3. Evict oldest READY
	const ready = poolState.findOldestSlotByRole("READY");
	if (ready) {
		evictSlot(ready);
		return ready;
	}
	return null;
}

/**
 * Evict a slot: cancel its warmup timeout, remove from task index synchronously,
 * set to FREE, and kick off async disconnect.
 */
function evictSlot(slot: TerminalSlot): void {
	poolPolicy.clearPreviousEvictionTimer(slot);
	const evictedTaskId = poolState.removeTaskSlotForSlot(slot);
	if (evictedTaskId) {
		poolPolicy.clearWarmupTimers(evictedTaskId);
	}
	poolState.setRole(slot, "FREE");
	// Async disconnect — socket close + buffer reset happen in the background.
	void slot.disconnectFromTask();
}

/** Immediately evict a PRELOADING/READY warmup slot. */
function evictWarmupSlot(taskId: string, reason: "cancelWarmup" | "warmupMaxTtl" = "cancelWarmup"): void {
	poolPolicy.clearWarmupTimers(taskId);
	const slot = poolState.getSlotForTask(taskId);
	if (!slot) {
		return;
	}
	const role = poolState.getRole(slot);
	if (role === "PRELOADING" || role === "READY") {
		log.debug(`${reason} — releasing slot ${slot.slotId} for ${taskId}`);
		poolState.removeTaskSlot(taskId);
		poolState.setRole(slot, "FREE");
		void slot.disconnectFromTask();
	}
}

function getDedicatedSlotEntries(): { key: string; slot: TerminalSlot }[] {
	const dedicatedSlots: { key: string; slot: TerminalSlot }[] = [];
	forEachDedicatedTerminal((slot, key) => {
		dedicatedSlots.push({ key, slot });
	});
	return dedicatedSlots;
}

const terminalDebugProvider: TerminalDebugSnapshotProvider = {
	getPoolSlots: () => poolState.getSlots(),
	getPoolSlotRole: (slot) => poolState.getRole(slot),
	getDedicatedSlots: getDedicatedSlotEntries,
};

const terminalSurfaceProvider: TerminalSurfaceProvider = {
	getPoolSlots: () => poolState.getSlots(),
	getPooledSlotForTask: (taskId) => poolState.getSlotForTask(taskId),
	log,
};

const terminalDomHealthMonitor = createTerminalDomHealthMonitor(terminalDebugProvider, log);
const uninstallTerminalDebugHook = installTerminalDebugHook(terminalDebugProvider);

const poolPolicy = new TerminalPoolPolicy({
	getSlots: () => poolState.getSlots(),
	getRole: (slot) => poolState.getRole(slot),
	setRole: (slot, role) => poolState.setRole(slot, role),
	findNewestSlotByRole: (role) => poolState.findNewestSlotByRole(role),
	evictSlot,
	evictWarmupSlot,
	logDebug: (message, metadata) => {
		log.debug(message, metadata);
	},
});

// ---------------------------------------------------------------------------
// Pool functions
// ---------------------------------------------------------------------------

/**
 * Initialize the pool with POOL_SIZE slots, all FREE.
 * Starts the proactive rotation timer.
 * No-op if already initialized.
 */
export function initPool(): void {
	if (initialized) {
		log.warn("initPool called but pool is already initialized");
		return;
	}
	initialized = true;
	log.info(`initializing pool with ${POOL_SIZE} slots`);
	for (let i = 0; i < POOL_SIZE; i++) {
		const slotId = nextSlotId++;
		const slot = new TerminalSlot(slotId, DEFAULT_POOL_APPEARANCE);
		poolState.addSlot(slot, "FREE");
	}
	// Start proactive rotation timer
	_rotationTimer = setInterval(rotateOldestFreeSlot, ROTATION_INTERVAL_MS);
	terminalDomHealthMonitor.start();
}

/**
 * Register the DOM container for pool terminals. Moves all pool slots
 * into the container. Called via React ref callback when the terminal
 * panel mounts. Idempotent for the same container.
 */
export function attachPoolContainer(container: HTMLDivElement): void {
	if (poolContainer === container) return;
	poolContainer = container;
	for (const slot of poolState.getSlots()) {
		slot.attachToStageContainer(container);
	}
	log.info(`pool container attached — ${poolState.getSlots().length} slots staged`);
}

/**
 * Detach the pool container. Called when the terminal panel unmounts.
 * Slots remain in the (now detached) DOM — harmless. They'll be moved
 * on the next attachPoolContainer call.
 */
export function detachPoolContainer(): void {
	poolContainer = null;
	log.info("pool container detached");
}

/**
 * Acquire a pool slot for a task. Returns the TerminalSlot connected to the task.
 *
 * - If the task already has a slot, transitions it to ACTIVE.
 * - Demotes the current ACTIVE to PREVIOUS, evicts stale PREVIOUS.
 * - Finds a FREE slot or evicts the oldest PRELOADING/READY.
 */
export function acquireForTask(taskId: string, projectId: string): TerminalSlot {
	const t0 = performance.now();
	// 1. If task already has a slot: cancel warmup, transition to ACTIVE, return it.
	const existing = poolState.getSlotForTask(taskId);
	if (existing) {
		poolPolicy.clearWarmupTimers(taskId);
		// Re-open sockets if they closed (e.g. after sleep/wake).
		existing.ensureConnected();
		const previousRole = poolPolicy.prepareSlotForActiveRole(existing);
		// Hidden pooled task terminals can drift visually while off-screen, especially
		// when reactivated into a different layout width. Request a fresh restore when
		// promoting any non-ACTIVE slot back to the visible task view.
		if (previousRole !== "ACTIVE") {
			existing.requestRestore();
		}
		log.debug(`[perf] acquireForTask — reused slot ${existing.slotId} for ${taskId}`, {
			previousRole,
			elapsedMs: (performance.now() - t0).toFixed(1),
		});
		return existing;
	}

	// 2. Make room for the new active slot while preserving only the latest
	// PREVIOUS slot for quick switch-back.
	const retainedPrevious = poolPolicy.demoteActiveSlotsExcept(null);
	poolPolicy.evictStalePreviousSlots(retainedPrevious);

	// 3. Find FREE slot or evict PRELOADING/READY.
	const freeSlot = findFreeOrEvict();
	if (!freeSlot) {
		// This should never happen with a pool of 4 (at most ACTIVE + PREVIOUS = 2,
		// leaving 2 evictable). Fall back to evicting the oldest PREVIOUS to avoid
		// breaking the 4-slot cap.
		const previousSlot = poolState.findOldestSlotByRole("PREVIOUS");
		if (previousSlot) {
			log.warn("acquireForTask — no free slots, evicting PREVIOUS");
			evictSlot(previousSlot);
			const result = acquireForTaskIntoSlot(previousSlot, taskId, projectId);
			log.debug(`[perf] acquireForTask — fallback slot ${previousSlot.slotId} to ${taskId}`, {
				elapsedMs: (performance.now() - t0).toFixed(1),
			});
			return result;
		}
		// If we reach here, the state machine has a bug. Throw rather than silently
		// growing the pool array (which would violate the 4-slot cap permanently).
		throw new Error(
			`acquireForTask — pool exhausted with ${poolState.getSlots().length} slots, all ACTIVE. This is a pool state machine bug.`,
		);
	}

	const result = acquireForTaskIntoSlot(freeSlot, taskId, projectId);
	log.debug(`[perf] acquireForTask — assigned slot ${freeSlot.slotId} to ${taskId}`, {
		elapsedMs: (performance.now() - t0).toFixed(1),
	});
	return result;
}

function acquireForTaskIntoSlot(slot: TerminalSlot, taskId: string, projectId: string): TerminalSlot {
	slot.connectToTask(taskId, projectId);
	poolState.assignTaskSlot(taskId, slot);
	poolState.setRole(slot, "ACTIVE");
	return slot;
}

/**
 * Warm up a pool slot for a task that may be needed soon (e.g. mouseover).
 * Connects the slot and begins preloading. If neither acquireForTask nor
 * cancelWarmup is called within WARMUP_MAX_TTL_MS, the warmup is evicted.
 */
export function warmup(taskId: string, projectId: string): void {
	const t0 = performance.now();
	// 1. If task already has a slot (any role): no-op
	if (poolState.hasSlotForTask(taskId)) {
		return;
	}

	// 2. Find FREE slot, or evict oldest PRELOADING, then oldest READY.
	//    If only ACTIVE/PREVIOUS remain: no-op
	const slot = findFreeOrEvict();
	if (!slot) {
		log.debug(`warmup — no evictable slots for ${taskId}, skipping`);
		return;
	}

	// 3. Connect and set PRELOADING
	slot.connectToTask(taskId, projectId);
	poolState.assignTaskSlot(taskId, slot);
	poolState.setRole(slot, "PRELOADING");
	log.debug(`[perf] warmup — slot ${slot.slotId} preloading for ${taskId}`, {
		elapsedMs: (performance.now() - t0).toFixed(1),
	});

	// 4. Transition to READY when connection is ready
	slot.onceConnectionReady(() => {
		if (poolState.getRole(slot) === "PRELOADING" && poolState.getSlotForTask(taskId) === slot) {
			poolState.setRole(slot, "READY");
			log.debug(`[perf] warmup — slot ${slot.slotId} ready for ${taskId}`, {
				totalMs: (performance.now() - t0).toFixed(1),
			});
		}
	});

	// 5. Bound warm slots even if the caller never sends cancelWarmup().
	poolPolicy.scheduleWarmupMaxTtl(taskId);
}

/**
 * Schedule eviction of a warmed-up slot after a grace period.
 * Called on mouseLeave — if acquireForTask is called within the grace
 * window (e.g. the user clicks shortly after leaving), the timeout is
 * cleared and the warm slot is reused.
 */
export function cancelWarmup(taskId: string): void {
	const slot = poolState.getSlotForTask(taskId);
	if (!slot) {
		poolPolicy.clearWarmupTimers(taskId);
		return;
	}
	const role = poolState.getRole(slot);
	if (role !== "PRELOADING" && role !== "READY") {
		poolPolicy.clearWarmupTimers(taskId);
		return;
	}
	poolPolicy.scheduleCancelWarmup(taskId);
}

/**
 * Release a task's slot back to FREE. No-op if the task has no slot.
 */
export function releaseTask(taskId: string): void {
	const slot = poolState.getSlotForTask(taskId);
	if (!slot) {
		return;
	}
	poolPolicy.clearPreviousEvictionTimer(slot);
	poolPolicy.clearWarmupTimers(taskId);
	poolState.removeTaskSlot(taskId);
	poolState.setRole(slot, "FREE");
	log.debug(`releaseTask — freed slot ${slot.slotId} from ${taskId}`);
	void slot.disconnectFromTask();
}

/**
 * Release all pool slots to FREE. Clears all warmup timers.
 */
export function releaseAll(): void {
	poolPolicy.clearAllTimers();

	// Disconnect all non-FREE slots
	for (const slot of poolState.getSlots()) {
		if (poolState.getRole(slot) !== "FREE") {
			poolState.removeTaskSlotForSlot(slot);
			poolState.setRole(slot, "FREE");
			void slot.disconnectFromTask();
		}
	}
	log.info("releaseAll — all pool slots freed");
}

/**
 * Get the pool slot for a task, or null if the task has no slot.
 */
export function getSlotForTask(taskId: string): TerminalSlot | null {
	return poolState.getSlotForTask(taskId);
}

/**
 * Get the current role of a pool slot.
 */
export function getSlotRole(slot: TerminalSlot): SlotRole {
	return poolState.getRole(slot);
}

/**
 * Proactive rotation: dispose the oldest FREE slot and replace it with a fresh one.
 * This prevents xterm.js canvas/WebGL resource staleness over long sessions.
 */
function rotateOldestFreeSlot(): void {
	const oldest = poolState.findOldestSlotByRole("FREE");
	if (!oldest) {
		log.debug("rotation — no FREE slots to rotate");
		return;
	}

	const replacementIndex = poolState.prepareSlotReplacement(oldest);
	if (replacementIndex === null) {
		return;
	}

	const oldSlotId = oldest.slotId;

	// Dispose old FIRST, then create new (no temporary 5th slot)
	oldest.dispose();

	const newSlotId = nextSlotId++;
	const fresh = new TerminalSlot(newSlotId, DEFAULT_POOL_APPEARANCE);
	poolState.replaceSlotAt(replacementIndex, fresh, "FREE");
	if (poolContainer) {
		fresh.attachToStageContainer(poolContainer);
	}

	log.debug(`rotation — replaced slot ${oldSlotId} with slot ${newSlotId}`);
}

// ---------------------------------------------------------------------------
// Dedicated terminal functions
// ---------------------------------------------------------------------------

export { disposeAllDedicatedTerminalsForProject, disposeDedicatedTerminal, isDedicatedTerminalTaskId };

/**
 * Ensure a dedicated terminal exists for the given task. Creates or reuses.
 * Dedicated terminals are NOT managed by the shared-slot pool.
 */
export function ensureDedicatedTerminal(input: EnsureDedicatedTerminalInput): TerminalSlot {
	return ensureDedicatedTerminalInRegistry(input, (appearance) => {
		const slotId = nextSlotId++;
		return new TerminalSlot(slotId, appearance);
	});
}

// ---------------------------------------------------------------------------
// Bulk utility functions (iterate BOTH pool slots AND dedicatedTerminals)
// ---------------------------------------------------------------------------

/**
 * Reset the renderer on all terminals (pool + dedicated).
 */
export function resetAllTerminalRenderers(): void {
	resetAllTerminalRenderersAcrossSurfaces(terminalSurfaceProvider);
}

/**
 * Set font weight on all terminals (pool + dedicated).
 */
export function setTerminalFontWeight(weight: number): void {
	setTerminalFontWeightAcrossSurfaces(terminalSurfaceProvider, weight);
}

/**
 * Log debug info for all pool slots and dedicated terminals.
 */
export function dumpTerminalDebugInfo(): TerminalDebugState {
	return dumpTerminalDebugInfoFromProvider(terminalDebugProvider, log);
}

export function collectTerminalDebugState(): TerminalDebugState {
	return collectTerminalDebugStateFromProvider(terminalDebugProvider);
}

/**
 * Write text to a terminal buffer. Checks pool first, then dedicated terminals.
 */
export function writeToTerminalBuffer(projectId: string, taskId: string, text: string): void {
	writeToTerminalBufferAcrossSurfaces(terminalSurfaceProvider, projectId, taskId, text);
}

/**
 * Check if a terminal session is running. Checks pool first, then dedicated.
 */
export function isTerminalSessionRunning(projectId: string, taskId: string): boolean {
	return isTerminalSessionRunningAcrossSurfaces(terminalSurfaceProvider, projectId, taskId);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal — test only. Resets pool-owned state so tests start clean. */
export function _resetPoolForTesting(): void {
	resetPoolState();
}

function resetPoolState(): void {
	poolPolicy.clearAllTimers();
	terminalDomHealthMonitor.stop();

	// Dispose all pool slots
	for (const slot of poolState.getSlots()) {
		slot.dispose();
	}
	poolState.clear();

	// Dispose all dedicated terminals
	_disposeAllDedicatedTerminalsForTesting();

	// Clear rotation timer
	if (_rotationTimer !== null) {
		clearInterval(_rotationTimer);
		_rotationTimer = null;
	}

	// Reset flags
	initialized = false;
	nextSlotId = 0;
	poolContainer = null;
}

const hot = (import.meta as ImportMeta & { hot?: ViteHotContext }).hot;
if (hot) {
	hot.dispose(() => {
		resetPoolState();
		uninstallTerminalDebugHook();
	});
}
