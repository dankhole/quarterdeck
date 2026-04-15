import { DETAIL_TERMINAL_TASK_PREFIX, HOME_TERMINAL_TASK_ID } from "@/hooks/terminal-constants";
import {
	type PersistentTerminalAppearance,
	TerminalSlot,
	updateGlobalTerminalFontWeight,
	updateGlobalTerminalWebGLRenderer,
} from "@/terminal/terminal-slot";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("terminal-pool");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlotRole = "FREE" | "PRELOADING" | "READY" | "ACTIVE" | "PREVIOUS";

export interface EnsureDedicatedTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const slots: TerminalSlot[] = [];
const slotRoles = new Map<TerminalSlot, SlotRole>();
const slotTaskIds = new Map<string, TerminalSlot>(); // taskId -> slot
const roleTimestamps = new Map<TerminalSlot, number>();
const warmupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
let previousEvictionTimer: ReturnType<typeof setTimeout> | null = null;
// Retained for future destroyPool() cleanup.
let _rotationTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let nextSlotId = 0;
const dedicatedTerminals = new Map<string, TerminalSlot>(); // workspaceId:taskId -> TerminalSlot
let poolContainer: HTMLDivElement | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_SIZE = 4;
const ROTATION_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const WARMUP_TIMEOUT_MS = 3_000;
/** How long a PREVIOUS slot stays connected before auto-eviction. Keeps instant
 *  switch-back for quick peeks while stopping hidden WebGL rendering long-term. */
const PREVIOUS_EVICTION_MS = 30_000;

/** Default appearance for pool slots at init — real appearance is set on show(). */
const DEFAULT_POOL_APPEARANCE: PersistentTerminalAppearance = {
	cursorColor: "#ffffff",
	terminalBackgroundColor: "#000000",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function setRole(slot: TerminalSlot, role: SlotRole): void {
	slotRoles.set(slot, role);
	roleTimestamps.set(slot, Date.now());
}

function getRole(slot: TerminalSlot): SlotRole {
	return slotRoles.get(slot) ?? "FREE";
}

function getTimestamp(slot: TerminalSlot): number {
	return roleTimestamps.get(slot) ?? 0;
}

/** Remove a slot from slotTaskIds by its taskId. Returns the taskId if found. */
function removeSlotFromTaskIndex(slot: TerminalSlot): string | null {
	for (const [taskId, s] of slotTaskIds.entries()) {
		if (s === slot) {
			slotTaskIds.delete(taskId);
			return taskId;
		}
	}
	return null;
}

/**
 * Cancel any pending PREVIOUS eviction timer.
 */
function clearPreviousEvictionTimer(): void {
	if (previousEvictionTimer !== null) {
		clearTimeout(previousEvictionTimer);
		previousEvictionTimer = null;
	}
}

/**
 * Schedule auto-eviction of the current PREVIOUS slot. Cancels any existing timer.
 */
function schedulePreviousEviction(slot: TerminalSlot): void {
	clearPreviousEvictionTimer();
	previousEvictionTimer = setTimeout(() => {
		previousEvictionTimer = null;
		if (getRole(slot) === "PREVIOUS") {
			log.debug(`previous eviction — auto-evicting slot ${slot.slotId} after ${PREVIOUS_EVICTION_MS}ms`);
			evictSlot(slot);
		}
	}, PREVIOUS_EVICTION_MS);
}

/**
 * Clear warmup timeout for a taskId if one exists.
 */
function clearWarmupTimeout(taskId: string): void {
	const timeout = warmupTimeouts.get(taskId);
	if (timeout !== undefined) {
		clearTimeout(timeout);
		warmupTimeouts.delete(taskId);
	}
}

/**
 * Find the oldest slot with a given role. Returns null if none found.
 */
function findOldestSlotByRole(role: SlotRole): TerminalSlot | null {
	let oldest: TerminalSlot | null = null;
	let oldestTime = Number.POSITIVE_INFINITY;
	for (const slot of slots) {
		if (getRole(slot) === role) {
			const ts = getTimestamp(slot);
			if (ts < oldestTime) {
				oldestTime = ts;
				oldest = slot;
			}
		}
	}
	return oldest;
}

/**
 * Find the newest slot with a given role. Returns null if none found.
 */
function findNewestSlotByRole(role: SlotRole): TerminalSlot | null {
	let newest: TerminalSlot | null = null;
	let newestTime = -1;
	for (const slot of slots) {
		if (getRole(slot) === role) {
			const ts = getTimestamp(slot);
			if (ts > newestTime) {
				newestTime = ts;
				newest = slot;
			}
		}
	}
	return newest;
}

/**
 * Find a FREE slot or evict PRELOADING (oldest first), then READY (oldest first).
 * When evicting: cancel warmup timeout, remove from task index, disconnect -> FREE.
 * Returns null if no evictable slot is found.
 */
function findFreeOrEvict(): TerminalSlot | null {
	// 1. Look for the newest FREE slot — leaves the oldest FREE for rotation to recycle.
	const free = findNewestSlotByRole("FREE");
	if (free) {
		return free;
	}
	// 2. Evict oldest PRELOADING
	const preloading = findOldestSlotByRole("PRELOADING");
	if (preloading) {
		evictSlot(preloading);
		return preloading;
	}
	// 3. Evict oldest READY
	const ready = findOldestSlotByRole("READY");
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
	const evictedTaskId = removeSlotFromTaskIndex(slot);
	if (evictedTaskId) {
		clearWarmupTimeout(evictedTaskId);
	}
	setRole(slot, "FREE");
	// Async disconnect — socket close + buffer reset happen in the background.
	void slot.disconnectFromTask();
}

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
		slots.push(slot);
		setRole(slot, "FREE");
	}
	// Start proactive rotation timer
	_rotationTimer = setInterval(rotateOldestFreeSlot, ROTATION_INTERVAL_MS);
}

/**
 * Register the DOM container for pool terminals. Moves all pool slots
 * into the container. Called via React ref callback when the terminal
 * panel mounts. Idempotent for the same container.
 */
export function attachPoolContainer(container: HTMLDivElement): void {
	if (poolContainer === container) return;
	poolContainer = container;
	for (const slot of slots) {
		slot.attachToStageContainer(container);
	}
	log.info(`pool container attached — ${slots.length} slots staged`);
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
export function acquireForTask(taskId: string, workspaceId: string): TerminalSlot {
	// 1. If task already has a slot: cancel warmup, transition to ACTIVE, return it
	const existing = slotTaskIds.get(taskId);
	if (existing) {
		clearWarmupTimeout(taskId);
		// If reacquiring the PREVIOUS slot (user switched back), cancel its eviction timer
		if (getRole(existing) === "PREVIOUS") {
			clearPreviousEvictionTimer();
		}
		setRole(existing, "ACTIVE");
		log.debug(`acquireForTask — reusing slot ${existing.slotId} for ${taskId}`);
		return existing;
	}

	// 2. If current ACTIVE exists and is a different task: transition to PREVIOUS
	const currentActive = findOldestSlotByRole("ACTIVE");
	if (currentActive) {
		setRole(currentActive, "PREVIOUS");
		// Re-sync the buffer from the server's headless mirror while the user
		// isn't looking. This repairs any client-side visual drift (garbled
		// rendering, stale cursor state) so the terminal is clean if the user
		// switches back before the slot is evicted.
		currentActive.requestRestore();
		// Auto-evict after 30s — keeps instant switch-back for quick peeks
		// while stopping hidden WebGL rendering from burning GPU/WindowServer.
		schedulePreviousEviction(currentActive);
		log.debug(`acquireForTask — demoted slot ${currentActive.slotId} to PREVIOUS`);
	}

	// 3. If current PREVIOUS exists and is a different task from the new PREVIOUS:
	//    evict the old PREVIOUS
	//    (After step 2, there may be two PREVIOUS slots — the old one needs eviction)
	for (const slot of slots) {
		if (getRole(slot) === "PREVIOUS" && slot !== currentActive) {
			log.debug(`acquireForTask — evicting stale PREVIOUS slot ${slot.slotId}`);
			clearPreviousEvictionTimer(); // clear timer for the old PREVIOUS
			evictSlot(slot);
		}
	}

	// 4. Find FREE slot or evict PRELOADING/READY
	const freeSlot = findFreeOrEvict();
	if (!freeSlot) {
		// This should never happen with a pool of 4 (at most ACTIVE + PREVIOUS = 2,
		// leaving 2 evictable). Fall back to evicting the oldest PREVIOUS to avoid
		// breaking the 4-slot cap.
		const previousSlot = findOldestSlotByRole("PREVIOUS");
		if (previousSlot) {
			log.warn("acquireForTask — no free slots, evicting PREVIOUS");
			evictSlot(previousSlot);
			return acquireForTaskIntoSlot(previousSlot, taskId, workspaceId);
		}
		// If we reach here, the state machine has a bug. Throw rather than silently
		// growing the pool array (which would violate the 4-slot cap permanently).
		throw new Error(
			`acquireForTask — pool exhausted with ${slots.length} slots, all ACTIVE. This is a pool state machine bug.`,
		);
	}

	return acquireForTaskIntoSlot(freeSlot, taskId, workspaceId);
}

function acquireForTaskIntoSlot(slot: TerminalSlot, taskId: string, workspaceId: string): TerminalSlot {
	slot.connectToTask(taskId, workspaceId);
	slotTaskIds.set(taskId, slot);
	setRole(slot, "ACTIVE");
	log.debug(`acquireForTask — assigned slot ${slot.slotId} to ${taskId}`);
	return slot;
}

/**
 * Warm up a pool slot for a task that may be needed soon (e.g. mouseover).
 * Connects the slot and begins preloading. If acquireForTask is not called
 * within WARMUP_TIMEOUT_MS, the warmup is cancelled.
 */
export function warmup(taskId: string, workspaceId: string): void {
	// 1. If task already has a slot (any role): no-op
	if (slotTaskIds.has(taskId)) {
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
	slot.connectToTask(taskId, workspaceId);
	slotTaskIds.set(taskId, slot);
	setRole(slot, "PRELOADING");
	log.debug(`warmup — slot ${slot.slotId} preloading for ${taskId}`);

	// 4. Transition to READY when connection is ready
	slot.onceConnectionReady(() => {
		if (getRole(slot) === "PRELOADING" && slotTaskIds.get(taskId) === slot) {
			setRole(slot, "READY");
			log.debug(`warmup — slot ${slot.slotId} ready for ${taskId}`);
		}
	});

	// 5. No timeout here — the slot stays warm as long as the caller holds it.
	//    The timeout starts when cancelWarmup() is called (i.e. mouseLeave),
	//    giving a grace period before eviction in case the user clicks shortly
	//    after leaving the card.
}

/**
 * Schedule eviction of a warmed-up slot after a grace period.
 * Called on mouseLeave — if acquireForTask is called within the grace
 * window (e.g. the user clicks shortly after leaving), the timeout is
 * cleared and the warm slot is reused.
 */
export function cancelWarmup(taskId: string): void {
	const slot = slotTaskIds.get(taskId);
	if (!slot) {
		clearWarmupTimeout(taskId);
		return;
	}
	const role = getRole(slot);
	if (role !== "PRELOADING" && role !== "READY") {
		clearWarmupTimeout(taskId);
		return;
	}
	// Already has a pending eviction timeout — leave it running.
	if (warmupTimeouts.has(taskId)) {
		return;
	}
	const timeoutId = setTimeout(() => {
		warmupTimeouts.delete(taskId);
		evictWarmupSlot(taskId);
	}, WARMUP_TIMEOUT_MS);
	warmupTimeouts.set(taskId, timeoutId);
}

/** Immediately evict a PRELOADING/READY warmup slot. */
function evictWarmupSlot(taskId: string): void {
	clearWarmupTimeout(taskId);
	const slot = slotTaskIds.get(taskId);
	if (!slot) {
		return;
	}
	const role = getRole(slot);
	if (role === "PRELOADING" || role === "READY") {
		log.debug(`cancelWarmup — releasing slot ${slot.slotId} for ${taskId}`);
		slotTaskIds.delete(taskId);
		setRole(slot, "FREE");
		void slot.disconnectFromTask();
	}
}

/**
 * Release a task's slot back to FREE. No-op if the task has no slot.
 */
export function releaseTask(taskId: string): void {
	const slot = slotTaskIds.get(taskId);
	if (!slot) {
		return;
	}
	clearWarmupTimeout(taskId);
	slotTaskIds.delete(taskId);
	setRole(slot, "FREE");
	log.debug(`releaseTask — freed slot ${slot.slotId} from ${taskId}`);
	void slot.disconnectFromTask();
}

/**
 * Release all pool slots to FREE. Clears all warmup timeouts.
 */
export function releaseAll(): void {
	// Clear all timers
	for (const [, timeout] of warmupTimeouts) {
		clearTimeout(timeout);
	}
	warmupTimeouts.clear();
	clearPreviousEvictionTimer();

	// Disconnect all non-FREE slots
	for (const slot of slots) {
		if (getRole(slot) !== "FREE") {
			removeSlotFromTaskIndex(slot);
			setRole(slot, "FREE");
			void slot.disconnectFromTask();
		}
	}
	log.info("releaseAll — all pool slots freed");
}

/**
 * Get the pool slot for a task, or null if the task has no slot.
 */
export function getSlotForTask(taskId: string): TerminalSlot | null {
	return slotTaskIds.get(taskId) ?? null;
}

/**
 * Get the current role of a pool slot.
 */
export function getSlotRole(slot: TerminalSlot): SlotRole {
	return getRole(slot);
}

/**
 * Proactive rotation: dispose the oldest FREE slot and replace it with a fresh one.
 * This prevents xterm.js canvas/WebGL resource staleness over long sessions.
 */
function rotateOldestFreeSlot(): void {
	const oldest = findOldestSlotByRole("FREE");
	if (!oldest) {
		log.debug("rotation — no FREE slots to rotate");
		return;
	}

	const idx = slots.indexOf(oldest);
	if (idx === -1) {
		return;
	}

	const oldSlotId = oldest.slotId;

	// Dispose old FIRST, then create new (no temporary 5th slot)
	slotRoles.delete(oldest);
	roleTimestamps.delete(oldest);
	oldest.dispose();

	const newSlotId = nextSlotId++;
	const fresh = new TerminalSlot(newSlotId, DEFAULT_POOL_APPEARANCE);
	slots[idx] = fresh;
	setRole(fresh, "FREE");
	if (poolContainer) {
		fresh.attachToStageContainer(poolContainer);
	}

	log.debug(`rotation — replaced slot ${oldSlotId} with slot ${newSlotId}`);
}

// ---------------------------------------------------------------------------
// Dedicated terminal functions
// ---------------------------------------------------------------------------

/**
 * Returns true if the taskId is a dedicated terminal (home or detail).
 */
export function isDedicatedTerminalTaskId(taskId: string): boolean {
	return taskId === HOME_TERMINAL_TASK_ID || taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
}

/**
 * Ensure a dedicated terminal exists for the given task. Creates or reuses.
 * Dedicated terminals are NOT managed by the pool — they have their own lifecycle.
 */
export function ensureDedicatedTerminal(input: EnsureDedicatedTerminalInput): TerminalSlot {
	const key = buildKey(input.workspaceId, input.taskId);
	const existing = dedicatedTerminals.get(key);
	if (existing) {
		existing.setAppearance({
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
		});
		return existing;
	}

	const slotId = nextSlotId++;
	const slot = new TerminalSlot(slotId, {
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
	});
	slot.connectToTask(input.taskId, input.workspaceId);
	dedicatedTerminals.set(key, slot);
	log.debug(`ensureDedicatedTerminal — created slot ${slotId} for ${key}`);
	return slot;
}

/**
 * Dispose a specific dedicated terminal.
 */
export function disposeDedicatedTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const slot = dedicatedTerminals.get(key);
	if (!slot) {
		return;
	}
	slot.dispose();
	dedicatedTerminals.delete(key);
	log.debug(`disposeDedicatedTerminal — disposed ${key}`);
}

/**
 * Dispose all dedicated terminals for a workspace.
 */
export function disposeAllDedicatedTerminalsForWorkspace(workspaceId: string): void {
	const prefix = `${workspaceId}:`;
	for (const [key, slot] of dedicatedTerminals.entries()) {
		if (key.startsWith(prefix)) {
			slot.dispose();
			dedicatedTerminals.delete(key);
			log.debug(`disposeAllDedicatedTerminalsForWorkspace — disposed ${key}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Bulk utility functions (iterate BOTH pool slots AND dedicatedTerminals)
// ---------------------------------------------------------------------------

/** Iterate over all terminal slots (pool + dedicated). */
function* allSlots(): Generator<TerminalSlot> {
	for (const slot of slots) {
		yield slot;
	}
	for (const slot of dedicatedTerminals.values()) {
		yield slot;
	}
}

/**
 * Reset the renderer on all terminals (pool + dedicated).
 */
export function resetAllTerminalRenderers(): void {
	const count = slots.length + dedicatedTerminals.size;
	if (count === 0) {
		log.warn("resetAllTerminalRenderers — no terminals");
		return;
	}
	const t0 = performance.now();
	log.info(`resetting renderers for ${count} terminal(s)`);
	for (const slot of allSlots()) {
		slot.resetRenderer();
	}
	const elapsed = (performance.now() - t0).toFixed(1);
	log.info(`renderer reset complete — ${elapsed}ms total`);
}

/**
 * Request a restore on all connected terminals (pool + dedicated).
 */
export function restoreAllTerminals(): void {
	const count = slots.length + dedicatedTerminals.size;
	if (count === 0) {
		log.warn("restoreAllTerminals — no terminals");
		return;
	}
	log.info(`requesting restore for ${count} terminal(s)`);
	for (const slot of allSlots()) {
		if (slot.connectedTaskId) {
			slot.requestRestore();
		}
	}
}

/**
 * Set font weight on all terminals (pool + dedicated).
 */
export function setTerminalFontWeight(weight: number): void {
	updateGlobalTerminalFontWeight(weight);
	for (const slot of allSlots()) {
		slot.setFontWeight(weight);
	}
}

/**
 * Set WebGL renderer on all terminals (pool + dedicated).
 */
export function setTerminalWebGLRenderer(enabled: boolean): void {
	updateGlobalTerminalWebGLRenderer(enabled);
	for (const slot of allSlots()) {
		slot.setWebGLRenderer(enabled);
	}
}

/**
 * Log debug info for all pool slots and dedicated terminals.
 */
export function dumpTerminalDebugInfo(): void {
	if (slots.length === 0 && dedicatedTerminals.size === 0) {
		log.info("No active terminals");
		return;
	}

	// Pool slots
	for (const slot of slots) {
		const role = getRole(slot);
		const taskId = slot.connectedTaskId;
		const info = slot.getBufferDebugInfo();
		log.info(`pool slot ${slot.slotId} [${role}]`, {
			taskId: taskId ?? "(none)",
			buffer: info.activeBuffer,
			scrollback: `${info.normalScrollbackLines} lines (max ${info.scrollbackOption})`,
			normal: `len=${info.normalLength} baseY=${info.normalBaseY}`,
			alternate: `len=${info.alternateLength}`,
			viewport: info.viewportRows,
			session: info.sessionState,
		});
	}

	// Dedicated terminals
	for (const [key, slot] of dedicatedTerminals.entries()) {
		const info = slot.getBufferDebugInfo();
		log.info(`dedicated ${key}`, {
			buffer: info.activeBuffer,
			scrollback: `${info.normalScrollbackLines} lines (max ${info.scrollbackOption})`,
			normal: `len=${info.normalLength} baseY=${info.normalBaseY}`,
			alternate: `len=${info.alternateLength}`,
			viewport: info.viewportRows,
			session: info.sessionState,
		});
	}
}

/**
 * Write text to a terminal buffer. Checks pool first, then dedicated terminals.
 */
export function writeToTerminalBuffer(workspaceId: string, taskId: string, text: string): void {
	// Check pool first
	const poolSlot = slotTaskIds.get(taskId);
	if (poolSlot) {
		poolSlot.writeText(text);
		return;
	}
	// Check dedicated terminals
	const key = buildKey(workspaceId, taskId);
	const dedicated = dedicatedTerminals.get(key);
	if (dedicated) {
		dedicated.writeText(text);
	}
}

/**
 * Check if a terminal session is running. Checks pool first, then dedicated.
 */
export function isTerminalSessionRunning(workspaceId: string, taskId: string): boolean {
	// Check pool first
	const poolSlot = slotTaskIds.get(taskId);
	if (poolSlot) {
		return poolSlot.sessionState === "running";
	}
	// Check dedicated terminals
	const key = buildKey(workspaceId, taskId);
	const dedicated = dedicatedTerminals.get(key);
	if (dedicated) {
		return dedicated.sessionState === "running";
	}
	return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal — test only. Resets all module-level state so tests start clean. */
export function _resetPoolForTesting(): void {
	// Clear all timers
	for (const [, timeout] of warmupTimeouts) {
		clearTimeout(timeout);
	}
	warmupTimeouts.clear();
	clearPreviousEvictionTimer();

	// Dispose all pool slots
	for (const slot of slots) {
		slot.dispose();
	}
	slots.length = 0;
	slotRoles.clear();
	slotTaskIds.clear();
	roleTimestamps.clear();

	// Dispose all dedicated terminals
	for (const [, slot] of dedicatedTerminals) {
		slot.dispose();
	}
	dedicatedTerminals.clear();

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
