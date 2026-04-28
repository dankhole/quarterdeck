import {
	_disposeAllDedicatedTerminalsForTesting,
	disposeAllDedicatedTerminalsForProject,
	disposeDedicatedTerminal,
	type EnsureDedicatedTerminalInput,
	ensureDedicatedTerminal as ensureDedicatedTerminalInRegistry,
	forEachDedicatedTerminal,
	getDedicatedTerminal,
	getDedicatedTerminalCount,
	isDedicatedTerminalTaskId,
} from "@/terminal/terminal-dedicated-registry";
import { collectTerminalDomDiagnostics, type TerminalDomDiagnostics } from "@/terminal/terminal-dom-diagnostics";
import {
	type PersistentTerminalAppearance,
	TerminalSlot,
	updateGlobalTerminalFontWeight,
} from "@/terminal/terminal-slot";
import { createClientLogger } from "@/utils/client-logger";
import { warnToBrowserConsole } from "@/utils/global-error-capture";

const log = createClientLogger("terminal-pool");
const TERMINAL_DOM_ALERT_MESSAGE = "terminal DOM count exceeded expected ceiling";
const TERMINAL_DOM_ALERT_CONSOLE_MESSAGE =
	"[quarterdeck] terminal DOM count exceeded expected ceiling; run window.__quarterdeckDumpTerminalState() for details.";

interface ViteHotContext {
	dispose(callback: () => void): void;
}

type TerminalBufferDebugInfo = ReturnType<TerminalSlot["getBufferDebugInfo"]>;

export interface RegisteredTerminalDebugSnapshot {
	kind: "pool" | "dedicated";
	key: string | null;
	slotId: number;
	role: SlotRole | null;
	taskId: string | null;
	projectId: string | null;
	buffer: TerminalBufferDebugInfo;
}

export interface TerminalDebugState {
	generatedAt: string;
	registered: {
		total: number;
		pool: number;
		dedicated: number;
	};
	dom: TerminalDomDiagnostics;
	poolSlots: RegisteredTerminalDebugSnapshot[];
	dedicatedSlots: RegisteredTerminalDebugSnapshot[];
}

declare global {
	interface Window {
		__quarterdeckDumpTerminalState?: () => TerminalDebugState;
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlotRole = "FREE" | "PRELOADING" | "READY" | "ACTIVE" | "PREVIOUS";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const slots: TerminalSlot[] = [];
const slotRoles = new Map<TerminalSlot, SlotRole>();
const slotTaskIds = new Map<string, TerminalSlot>(); // taskId -> slot
const roleTimestamps = new Map<TerminalSlot, number>();
const warmupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const warmupMaxTtlTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const previousEvictionTimers = new Map<TerminalSlot, ReturnType<typeof setTimeout>>();
// Retained for future destroyPool() cleanup.
let _rotationTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let nextSlotId = 0;
let poolContainer: HTMLDivElement | null = null;
let terminalDomHealthTimer: ReturnType<typeof setInterval> | null = null;
let lastTerminalDomAlert: { signature: string; timestamp: number } | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_SIZE = 4;
const ROTATION_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const WARMUP_TIMEOUT_MS = 3_000;
const WARMUP_MAX_TTL_MS = 12_000;
/** How long a PREVIOUS slot stays connected before auto-eviction. Keeps instant
 *  switch-back for quick peeks while bounding hidden terminal streams tightly. */
const PREVIOUS_EVICTION_MS = 8_000;
const TERMINAL_DOM_ALERT_THRESHOLD = 8;
const TERMINAL_DOM_ALERT_INTERVAL_MS = 60_000;
const TERMINAL_DOM_ALERT_REPEAT_MS = 5 * 60_000;

/** Default appearance for pool slots at init — real appearance is set on show(). */
const DEFAULT_POOL_APPEARANCE: PersistentTerminalAppearance = {
	cursorColor: "#ffffff",
	terminalBackgroundColor: "#000000",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function clearPreviousEvictionTimer(slot: TerminalSlot): void {
	const timeout = previousEvictionTimers.get(slot);
	if (timeout === undefined) {
		return;
	}
	clearTimeout(timeout);
	previousEvictionTimers.delete(slot);
}

function clearAllPreviousEvictionTimers(): void {
	for (const [, timeout] of previousEvictionTimers) {
		clearTimeout(timeout);
	}
	previousEvictionTimers.clear();
}

/**
 * Schedule auto-eviction of a PREVIOUS slot. Timer ownership is per slot so
 * stale PREVIOUS cleanup cannot cancel the newly demoted PREVIOUS timer.
 */
function schedulePreviousEviction(slot: TerminalSlot): void {
	clearPreviousEvictionTimer(slot);
	const timeout = setTimeout(() => {
		if (previousEvictionTimers.get(slot) !== timeout) {
			return;
		}
		previousEvictionTimers.delete(slot);
		if (getRole(slot) === "PREVIOUS") {
			log.debug(`previous eviction — auto-evicting slot ${slot.slotId} after ${PREVIOUS_EVICTION_MS}ms`);
			evictSlot(slot);
		}
	}, PREVIOUS_EVICTION_MS);
	previousEvictionTimers.set(slot, timeout);
}

function demoteActiveSlotsExcept(nextActiveSlot: TerminalSlot | null): TerminalSlot | null {
	let retainedPrevious: TerminalSlot | null = null;
	for (const slot of slots) {
		if (slot === nextActiveSlot || getRole(slot) !== "ACTIVE") {
			continue;
		}
		setRole(slot, "PREVIOUS");
		schedulePreviousEviction(slot);
		retainedPrevious = slot;
		log.debug(`active transition — demoted slot ${slot.slotId} to PREVIOUS`);
	}
	return retainedPrevious;
}

function evictStalePreviousSlots(retainedPrevious: TerminalSlot | null): void {
	for (const slot of slots) {
		if (slot !== retainedPrevious && getRole(slot) === "PREVIOUS") {
			log.debug(`active transition — evicting stale PREVIOUS slot ${slot.slotId}`);
			evictSlot(slot);
		}
	}
}

function prepareSlotForActiveRole(slot: TerminalSlot): SlotRole {
	const previousRole = getRole(slot);
	if (previousRole === "PREVIOUS") {
		clearPreviousEvictionTimer(slot);
	}
	const demotedPrevious = demoteActiveSlotsExcept(slot);
	setRole(slot, "ACTIVE");
	const retainedPrevious = demotedPrevious ?? (previousRole === "ACTIVE" ? findNewestSlotByRole("PREVIOUS") : null);
	evictStalePreviousSlots(retainedPrevious);
	return previousRole;
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

function clearWarmupMaxTtlTimeout(taskId: string): void {
	const timeout = warmupMaxTtlTimeouts.get(taskId);
	if (timeout !== undefined) {
		clearTimeout(timeout);
		warmupMaxTtlTimeouts.delete(taskId);
	}
}

function clearWarmupTimers(taskId: string): void {
	clearWarmupTimeout(taskId);
	clearWarmupMaxTtlTimeout(taskId);
}

function clearAllWarmupTimers(): void {
	for (const [, timeout] of warmupTimeouts) {
		clearTimeout(timeout);
	}
	warmupTimeouts.clear();
	for (const [, timeout] of warmupMaxTtlTimeouts) {
		clearTimeout(timeout);
	}
	warmupMaxTtlTimeouts.clear();
}

function buildTerminalDomAlertPayload(trigger: string): {
	trigger: string;
	threshold: number;
	registeredTotal: number;
	registeredPool: number;
	registeredDedicated: number;
	helperTextareas: number;
	helperTextareasMissingId: number;
	helperTextareasMissingName: number;
	xtermElements: number;
	parkingRootChildren: number;
} {
	const dom = collectTerminalDomDiagnostics();
	return {
		trigger,
		threshold: TERMINAL_DOM_ALERT_THRESHOLD,
		registeredTotal: slots.length + getDedicatedTerminalCount(),
		registeredPool: slots.length,
		registeredDedicated: getDedicatedTerminalCount(),
		helperTextareas: dom.helperTextareaCount,
		helperTextareasMissingId: dom.helperTextareasMissingId,
		helperTextareasMissingName: dom.helperTextareasMissingName,
		xtermElements: dom.xtermElementCount,
		parkingRootChildren: dom.parkingRoot?.childElementCount ?? 0,
	};
}

function queueQuarterdeckTerminalDomAlert(payload: ReturnType<typeof buildTerminalDomAlertPayload>): void {
	setTimeout(() => {
		try {
			log.warn(TERMINAL_DOM_ALERT_MESSAGE, payload);
		} catch {
			// Browser console output above is the reliable diagnostic path.
		}
	}, 0);
}

function maybeWarnAboutTerminalDomGrowth(trigger: string): void {
	const payload = buildTerminalDomAlertPayload(trigger);
	const observedCount = Math.max(payload.registeredTotal, payload.helperTextareas, payload.xtermElements);
	if (observedCount <= TERMINAL_DOM_ALERT_THRESHOLD) {
		lastTerminalDomAlert = null;
		return;
	}

	const signature = [
		payload.registeredTotal,
		payload.helperTextareas,
		payload.xtermElements,
		payload.parkingRootChildren,
		payload.helperTextareasMissingId,
		payload.helperTextareasMissingName,
	].join(":");
	const now = Date.now();
	if (
		lastTerminalDomAlert?.signature === signature &&
		now - lastTerminalDomAlert.timestamp < TERMINAL_DOM_ALERT_REPEAT_MS
	) {
		return;
	}

	lastTerminalDomAlert = { signature, timestamp: now };
	// Raw console first because this alert is specifically for cases where the
	// debug panel or Quarterdeck logging path may be too slow to use.
	warnToBrowserConsole(TERMINAL_DOM_ALERT_CONSOLE_MESSAGE, payload);
	queueQuarterdeckTerminalDomAlert(payload);
}

function startTerminalDomHealthMonitor(): void {
	if (terminalDomHealthTimer !== null) {
		return;
	}
	terminalDomHealthTimer = setInterval(
		() => maybeWarnAboutTerminalDomGrowth("interval"),
		TERMINAL_DOM_ALERT_INTERVAL_MS,
	);
	maybeWarnAboutTerminalDomGrowth("init");
}

function stopTerminalDomHealthMonitor(): void {
	if (terminalDomHealthTimer !== null) {
		clearInterval(terminalDomHealthTimer);
		terminalDomHealthTimer = null;
	}
	lastTerminalDomAlert = null;
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
	clearPreviousEvictionTimer(slot);
	const evictedTaskId = removeSlotFromTaskIndex(slot);
	if (evictedTaskId) {
		clearWarmupTimers(evictedTaskId);
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
	startTerminalDomHealthMonitor();
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
export function acquireForTask(taskId: string, projectId: string): TerminalSlot {
	const t0 = performance.now();
	// 1. If task already has a slot: cancel warmup, transition to ACTIVE, return it.
	const existing = slotTaskIds.get(taskId);
	if (existing) {
		clearWarmupTimers(taskId);
		// Re-open sockets if they closed (e.g. after sleep/wake).
		existing.ensureConnected();
		const previousRole = prepareSlotForActiveRole(existing);
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
	const retainedPrevious = demoteActiveSlotsExcept(null);
	evictStalePreviousSlots(retainedPrevious);

	// 3. Find FREE slot or evict PRELOADING/READY.
	const freeSlot = findFreeOrEvict();
	if (!freeSlot) {
		// This should never happen with a pool of 4 (at most ACTIVE + PREVIOUS = 2,
		// leaving 2 evictable). Fall back to evicting the oldest PREVIOUS to avoid
		// breaking the 4-slot cap.
		const previousSlot = findOldestSlotByRole("PREVIOUS");
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
			`acquireForTask — pool exhausted with ${slots.length} slots, all ACTIVE. This is a pool state machine bug.`,
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
	slotTaskIds.set(taskId, slot);
	setRole(slot, "ACTIVE");
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
	slot.connectToTask(taskId, projectId);
	slotTaskIds.set(taskId, slot);
	setRole(slot, "PRELOADING");
	log.debug(`[perf] warmup — slot ${slot.slotId} preloading for ${taskId}`, {
		elapsedMs: (performance.now() - t0).toFixed(1),
	});

	// 4. Transition to READY when connection is ready
	slot.onceConnectionReady(() => {
		if (getRole(slot) === "PRELOADING" && slotTaskIds.get(taskId) === slot) {
			setRole(slot, "READY");
			log.debug(`[perf] warmup — slot ${slot.slotId} ready for ${taskId}`, {
				totalMs: (performance.now() - t0).toFixed(1),
			});
		}
	});

	// 5. Bound warm slots even if the caller never sends cancelWarmup().
	const maxTtlTimeoutId = setTimeout(() => {
		if (warmupMaxTtlTimeouts.get(taskId) !== maxTtlTimeoutId) {
			return;
		}
		warmupMaxTtlTimeouts.delete(taskId);
		evictWarmupSlot(taskId, "warmupMaxTtl");
	}, WARMUP_MAX_TTL_MS);
	warmupMaxTtlTimeouts.set(taskId, maxTtlTimeoutId);
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
		clearWarmupTimers(taskId);
		return;
	}
	const role = getRole(slot);
	if (role !== "PRELOADING" && role !== "READY") {
		clearWarmupTimers(taskId);
		return;
	}
	clearWarmupMaxTtlTimeout(taskId);
	// Already has a pending eviction timeout — leave it running.
	if (warmupTimeouts.has(taskId)) {
		return;
	}
	const timeoutId = setTimeout(() => {
		warmupTimeouts.delete(taskId);
		evictWarmupSlot(taskId, "cancelWarmup");
	}, WARMUP_TIMEOUT_MS);
	warmupTimeouts.set(taskId, timeoutId);
}

/** Immediately evict a PRELOADING/READY warmup slot. */
function evictWarmupSlot(taskId: string, reason: "cancelWarmup" | "warmupMaxTtl" = "cancelWarmup"): void {
	clearWarmupTimers(taskId);
	const slot = slotTaskIds.get(taskId);
	if (!slot) {
		return;
	}
	const role = getRole(slot);
	if (role === "PRELOADING" || role === "READY") {
		log.debug(`${reason} — releasing slot ${slot.slotId} for ${taskId}`);
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
	clearPreviousEvictionTimer(slot);
	clearWarmupTimers(taskId);
	slotTaskIds.delete(taskId);
	setRole(slot, "FREE");
	log.debug(`releaseTask — freed slot ${slot.slotId} from ${taskId}`);
	void slot.disconnectFromTask();
}

/**
 * Release all pool slots to FREE. Clears all warmup timers.
 */
export function releaseAll(): void {
	clearAllWarmupTimers();
	clearAllPreviousEvictionTimers();

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

/** Iterate over all terminal slots (pool + dedicated). */
function* allSlots(): Generator<TerminalSlot> {
	for (const slot of slots) {
		yield slot;
	}
	const dedicatedSlots: TerminalSlot[] = [];
	forEachDedicatedTerminal((slot) => {
		dedicatedSlots.push(slot);
	});
	yield* dedicatedSlots;
}

/**
 * Reset the renderer on all terminals (pool + dedicated).
 */
export function resetAllTerminalRenderers(): void {
	const count = slots.length + getDedicatedTerminalCount();
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
	const count = slots.length + getDedicatedTerminalCount();
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
 * Log debug info for all pool slots and dedicated terminals.
 */
export function dumpTerminalDebugInfo(): TerminalDebugState {
	const state = collectTerminalDebugState();
	logTerminalDebugState(state);
	dumpTerminalDebugStateToConsole(state);
	return state;
}

function buildSlotDebugSnapshot(
	kind: "pool" | "dedicated",
	slot: TerminalSlot,
	options: { key?: string; role?: SlotRole } = {},
): RegisteredTerminalDebugSnapshot {
	return {
		kind,
		key: options.key ?? null,
		slotId: slot.slotId,
		role: options.role ?? null,
		taskId: slot.connectedTaskId,
		projectId: slot.connectedProjectId,
		buffer: slot.getBufferDebugInfo(),
	};
}

export function collectTerminalDebugState(): TerminalDebugState {
	const dedicatedTerminalCount = getDedicatedTerminalCount();
	const totalTerminalCount = slots.length + dedicatedTerminalCount;
	const dedicatedSlots: RegisteredTerminalDebugSnapshot[] = [];
	forEachDedicatedTerminal((slot, key) => {
		dedicatedSlots.push(buildSlotDebugSnapshot("dedicated", slot, { key }));
	});

	return {
		generatedAt: new Date().toISOString(),
		registered: {
			total: totalTerminalCount,
			pool: slots.length,
			dedicated: dedicatedTerminalCount,
		},
		dom: collectTerminalDomDiagnostics(),
		poolSlots: slots.map((slot) => buildSlotDebugSnapshot("pool", slot, { role: getRole(slot) })),
		dedicatedSlots,
	};
}

function logTerminalDebugState(state: TerminalDebugState): void {
	if (state.registered.total === 0) {
		log.info("No active terminals");
		return;
	}

	log.info("terminal instance counts", {
		total: state.registered.total,
		pool: state.registered.pool,
		dedicated: state.registered.dedicated,
		helperTextareas: state.dom.helperTextareaCount,
		helperTextareasMissingId: state.dom.helperTextareasMissingId,
		helperTextareasMissingName: state.dom.helperTextareasMissingName,
		parkingRootChildren: state.dom.parkingRoot?.childElementCount ?? 0,
	});

	// Pool slots
	for (const slot of state.poolSlots) {
		log.info(`pool slot ${slot.slotId} [${slot.role ?? "unknown"}]`, {
			taskId: slot.taskId ?? "(none)",
			projectId: slot.projectId ?? "(none)",
			buffer: slot.buffer.activeBuffer,
			scrollback: `${slot.buffer.normalScrollbackLines} lines (max ${slot.buffer.scrollbackOption})`,
			normal: `len=${slot.buffer.normalLength} baseY=${slot.buffer.normalBaseY}`,
			alternate: `len=${slot.buffer.alternateLength}`,
			viewport: slot.buffer.viewportRows,
			session: slot.buffer.sessionState,
		});
	}

	// Dedicated terminals
	for (const slot of state.dedicatedSlots) {
		log.info(`dedicated ${slot.key ?? "(unknown)"}`, {
			taskId: slot.taskId ?? "(none)",
			projectId: slot.projectId ?? "(none)",
			buffer: slot.buffer.activeBuffer,
			scrollback: `${slot.buffer.normalScrollbackLines} lines (max ${slot.buffer.scrollbackOption})`,
			normal: `len=${slot.buffer.normalLength} baseY=${slot.buffer.normalBaseY}`,
			alternate: `len=${slot.buffer.alternateLength}`,
			viewport: slot.buffer.viewportRows,
			session: slot.buffer.sessionState,
		});
	}
}

function summarizeHelperForConsole(helper: TerminalDomDiagnostics["helperTextareas"][number]): {
	index: number;
	id: string;
	name: string;
	inParkingRoot: boolean;
	isConnected: boolean;
	parentPath: string;
} {
	return {
		index: helper.index,
		id: helper.id || "(missing)",
		name: helper.name || "(missing)",
		inParkingRoot: helper.inParkingRoot,
		isConnected: helper.isConnected,
		parentPath: helper.parentPath,
	};
}

function dumpTerminalDebugStateToConsole(state = collectTerminalDebugState()): TerminalDebugState {
	console.groupCollapsed(
		`[quarterdeck] terminal state: ${state.registered.total} registered, ${state.dom.helperTextareaCount} helper textarea(s)`,
	);
	console.info(state);
	if (state.dom.helperTextareas.length > 0) {
		console.table(state.dom.helperTextareas.map(summarizeHelperForConsole));
	}
	if (state.dom.parkingRoot?.children.length) {
		console.table(state.dom.parkingRoot.children);
	}
	console.groupEnd();
	return state;
}

function installTerminalDebugHook(): void {
	window.__quarterdeckDumpTerminalState = dumpTerminalDebugStateToConsole;
}

function uninstallTerminalDebugHook(): void {
	if (window.__quarterdeckDumpTerminalState === dumpTerminalDebugStateToConsole) {
		delete window.__quarterdeckDumpTerminalState;
	}
}

/**
 * Write text to a terminal buffer. Checks pool first, then dedicated terminals.
 */
export function writeToTerminalBuffer(projectId: string, taskId: string, text: string): void {
	// Check pool first
	const poolSlot = slotTaskIds.get(taskId);
	if (poolSlot) {
		poolSlot.writeText(text);
		return;
	}
	// Check dedicated terminals
	const dedicated = getDedicatedTerminal(projectId, taskId);
	if (dedicated) {
		dedicated.writeText(text);
	}
}

/**
 * Check if a terminal session is running. Checks pool first, then dedicated.
 */
export function isTerminalSessionRunning(projectId: string, taskId: string): boolean {
	// Check pool first
	const poolSlot = slotTaskIds.get(taskId);
	if (poolSlot) {
		return poolSlot.sessionState === "running";
	}
	// Check dedicated terminals
	const dedicated = getDedicatedTerminal(projectId, taskId);
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
	resetPoolState();
}

function resetPoolState(): void {
	clearAllWarmupTimers();
	clearAllPreviousEvictionTimers();
	stopTerminalDomHealthMonitor();

	// Dispose all pool slots
	for (const slot of slots) {
		slot.dispose();
	}
	slots.length = 0;
	slotRoles.clear();
	slotTaskIds.clear();
	roleTimestamps.clear();

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

installTerminalDebugHook();

const hot = (import.meta as ImportMeta & { hot?: ViteHotContext }).hot;
if (hot) {
	hot.dispose(() => {
		resetPoolState();
		uninstallTerminalDebugHook();
	});
}
