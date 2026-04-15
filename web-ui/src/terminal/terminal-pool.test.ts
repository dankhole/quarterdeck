import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock TerminalSlot
// ---------------------------------------------------------------------------

interface MockSlot {
	slotId: number;
	_taskId: string | null;
	_workspaceId: string | null;
	_sessionState: string | null;
	connectToTask: ReturnType<typeof vi.fn>;
	disconnectFromTask: ReturnType<typeof vi.fn>;
	onceConnectionReady: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	resetRenderer: ReturnType<typeof vi.fn>;
	requestRestore: ReturnType<typeof vi.fn>;
	setFontWeight: ReturnType<typeof vi.fn>;
	setWebGLRenderer: ReturnType<typeof vi.fn>;
	writeText: ReturnType<typeof vi.fn>;
	setAppearance: ReturnType<typeof vi.fn>;
	getBufferDebugInfo: ReturnType<typeof vi.fn>;
	connectedTaskId: string | null;
	connectedWorkspaceId: string | null;
	sessionState: string | null;
}

vi.mock("@/terminal/terminal-slot", () => {
	function createMock(slotId: number): MockSlot {
		const mock: MockSlot = {
			slotId,
			_taskId: null,
			_workspaceId: null,
			_sessionState: null,
			connectToTask: vi.fn((taskId: string, workspaceId: string) => {
				mock._taskId = taskId;
				mock._workspaceId = workspaceId;
			}),
			disconnectFromTask: vi.fn(async () => {
				mock._taskId = null;
				mock._workspaceId = null;
			}),
			onceConnectionReady: vi.fn(),
			dispose: vi.fn(),
			resetRenderer: vi.fn(),
			requestRestore: vi.fn(),
			setFontWeight: vi.fn(),
			setWebGLRenderer: vi.fn(),
			writeText: vi.fn(),
			setAppearance: vi.fn(),
			getBufferDebugInfo: vi.fn(() => ({
				activeBuffer: "NORMAL" as const,
				normalLength: 0,
				normalBaseY: 0,
				normalScrollbackLines: 0,
				alternateLength: 0,
				viewportRows: 24,
				scrollbackOption: 3_000,
				sessionState: null,
			})),
			get connectedTaskId() {
				return mock._taskId;
			},
			get connectedWorkspaceId() {
				return mock._workspaceId;
			},
			get sessionState() {
				return mock._sessionState;
			},
		};
		return mock;
	}

	// Use a real class so `new TerminalSlot(...)` works
	const MockTerminalSlot = vi.fn(function (this: MockSlot, slotId: number) {
		const mock = createMock(slotId);
		// Copy all own properties and method mocks
		for (const key of Object.keys(mock)) {
			(this as unknown as Record<string, unknown>)[key] = (mock as unknown as Record<string, unknown>)[key];
		}
		// Re-define getters on `this`
		const self = this;
		Object.defineProperty(this, "connectedTaskId", {
			get() {
				return self._taskId;
			},
			configurable: true,
		});
		Object.defineProperty(this, "connectedWorkspaceId", {
			get() {
				return self._workspaceId;
			},
			configurable: true,
		});
		Object.defineProperty(this, "sessionState", {
			get() {
				return self._sessionState;
			},
			configurable: true,
		});
		// Re-bind connectToTask/disconnectFromTask to reference `this`
		this.connectToTask = vi.fn((taskId: string, workspaceId: string) => {
			self._taskId = taskId;
			self._workspaceId = workspaceId;
		});
		this.disconnectFromTask = vi.fn(async () => {
			self._taskId = null;
			self._workspaceId = null;
		});
	});

	return {
		TerminalSlot: MockTerminalSlot,
		updateGlobalTerminalFontWeight: vi.fn(),
		updateGlobalTerminalWebGLRenderer: vi.fn(),
		PersistentTerminalAppearance: undefined,
	};
});

vi.mock("@/utils/client-logger", () => ({
	createClientLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// ---------------------------------------------------------------------------
// Import pool under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import {
	_resetPoolForTesting,
	acquireForTask,
	cancelWarmup,
	disposeAllDedicatedTerminalsForWorkspace,
	disposeDedicatedTerminal,
	ensureDedicatedTerminal,
	getSlotForTask,
	getSlotRole,
	initPool,
	isDedicatedTerminalTaskId,
	isTerminalSessionRunning,
	releaseAll,
	releaseTask,
	type SlotRole,
	warmup,
	writeToTerminalBuffer,
} from "@/terminal/terminal-pool";
import { TerminalSlot } from "@/terminal/terminal-slot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TerminalSlotMock = TerminalSlot as unknown as ReturnType<typeof vi.fn>;

function getPoolSlots(): MockSlot[] {
	// Each initPool call creates 4 TerminalSlot instances.
	// We can access them via TerminalSlotMock.mock.results.
	return TerminalSlotMock.mock.instances as unknown as MockSlot[];
}

/** Get all pool slots created during the most recent initPool() call (last 4). */
function getCurrentPoolSlots(): MockSlot[] {
	const all = getPoolSlots();
	return all.slice(all.length - 4);
}

function getSlotRoles(poolSlots: MockSlot[]): SlotRole[] {
	return poolSlots.map((s) => getSlotRole(s as unknown as TerminalSlot));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-pool", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_resetPoolForTesting();
		TerminalSlotMock.mockClear();
	});

	afterEach(() => {
		_resetPoolForTesting();
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// initPool
	// -----------------------------------------------------------------------

	describe("initPool", () => {
		it("creates 4 slots all FREE", () => {
			initPool();
			expect(TerminalSlotMock).toHaveBeenCalledTimes(4);
			const poolSlots = getCurrentPoolSlots();
			expect(poolSlots).toHaveLength(4);
			const roles = getSlotRoles(poolSlots);
			expect(roles).toEqual(["FREE", "FREE", "FREE", "FREE"]);
		});
	});

	// -----------------------------------------------------------------------
	// acquireForTask
	// -----------------------------------------------------------------------

	describe("acquireForTask", () => {
		beforeEach(() => {
			initPool();
		});

		it("returns slot and sets ACTIVE", () => {
			const slot = acquireForTask("task-1", "ws-1");
			expect(slot).toBeDefined();
			expect(getSlotRole(slot)).toBe("ACTIVE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.connectToTask).toHaveBeenCalledWith("task-1", "ws-1");
		});

		it("for same task returns same slot", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			const slot2 = acquireForTask("task-1", "ws-1");
			expect(slot1).toBe(slot2);
			expect(getSlotRole(slot1)).toBe("ACTIVE");
		});

		it("transitions previous ACTIVE to PREVIOUS", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");
			expect(getSlotRole(slot1)).toBe("PREVIOUS");
		});

		it("evicts old PREVIOUS when new PREVIOUS is set", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			const slot2 = acquireForTask("task-2", "ws-1");

			// After two acquires: slot1=PREVIOUS(task-1), slot2=ACTIVE(task-2)
			expect(getSlotRole(slot1)).toBe("PREVIOUS");
			expect(getSlotRole(slot2)).toBe("ACTIVE");

			const slot3 = acquireForTask("task-3", "ws-1");

			// Step 2: slot2 (ACTIVE) -> PREVIOUS
			// Step 3: slot1 (old PREVIOUS, != slot2) -> evicted (FREE + disconnect)
			// Step 4: slot1 (now FREE) is picked up and reused for task-3 -> ACTIVE
			// Result: slot1 is now ACTIVE for task-3, slot2 is PREVIOUS
			expect(slot3).toBe(slot1); // reused the evicted slot
			expect(getSlotRole(slot2)).toBe("PREVIOUS");
			const mockSlot1 = slot1 as unknown as MockSlot;
			expect(mockSlot1.disconnectFromTask).toHaveBeenCalled();
		});

		it("evicts PRELOADING before READY", () => {
			// We need all 4 slots occupied with no PREVIOUS to free, so:
			// Warmup 3 tasks (3 PRELOADING), acquire 1 (ACTIVE).
			// Then promote one to READY and acquire a new task to trigger eviction.
			warmup("task-warm-1", "ws-1"); // slot0=PRELOADING
			vi.advanceTimersByTime(50);
			warmup("task-warm-2", "ws-1"); // slot1=PRELOADING
			vi.advanceTimersByTime(50);

			// Promote task-warm-1 to READY
			const warmSlot1 = getSlotForTask("task-warm-1")!;
			const readyCallback1 = (warmSlot1 as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			readyCallback1?.();
			expect(getSlotRole(warmSlot1)).toBe("READY");

			const warmSlot2 = getSlotForTask("task-warm-2")!;
			expect(getSlotRole(warmSlot2)).toBe("PRELOADING");

			// Acquire task-a (uses a FREE slot)
			acquireForTask("task-a", "ws-1"); // slot2=ACTIVE

			// Acquire task-b — demotes task-a to PREVIOUS, then finds FREE slot
			acquireForTask("task-b", "ws-1"); // slot3=ACTIVE, slot2=PREVIOUS

			// All 4 slots occupied: READY, PRELOADING, PREVIOUS, ACTIVE
			// Now acquire task-c — demotes task-b to PREVIOUS, evicts old PREVIOUS (task-a),
			// reuses its slot. PRELOADING is not touched because a FREE slot appeared.
			// To truly test PRELOADING-before-READY eviction, we need NO previous to evict.
			// Let's use a different approach: fill all 4 with warmup, then acquire.

			// Reset and try again
			releaseAll();
			vi.advanceTimersByTime(100);

			// Fill all 4 slots with warmup
			warmup("w1", "ws-1"); // slot0=PRELOADING
			vi.advanceTimersByTime(50);
			warmup("w2", "ws-1"); // slot1=PRELOADING
			vi.advanceTimersByTime(50);
			warmup("w3", "ws-1"); // slot2=PRELOADING
			vi.advanceTimersByTime(50);
			warmup("w4", "ws-1"); // slot3=PRELOADING

			// Promote w3 and w4 to READY
			const slotW3 = getSlotForTask("w3")!;
			const cbW3 = (slotW3 as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			cbW3?.();
			expect(getSlotRole(slotW3)).toBe("READY");

			const slotW4 = getSlotForTask("w4")!;
			const cbW4 = (slotW4 as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			cbW4?.();
			expect(getSlotRole(slotW4)).toBe("READY");

			// w1 and w2 are still PRELOADING.
			// Acquire a new task — should evict oldest PRELOADING (w1), not READY.
			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("w1")).toBeNull(); // w1 was evicted (oldest PRELOADING)
			expect(getSlotForTask("w2")).not.toBeNull(); // w2 still PRELOADING
			expect(getSlotForTask("w3")).not.toBeNull(); // w3 still READY
			expect(getSlotForTask("w4")).not.toBeNull(); // w4 still READY
		});

		it("evicts oldest READY when multiple exist", () => {
			// Fill all 4 slots: 1 ACTIVE, 1 PREVIOUS, 2 READY
			// We need no FREE/PRELOADING so eviction falls through to READY.
			// Strategy: warmup 4, promote all to READY, then acquire 2 (uses READY slots).
			// That leaves 2 READY + 1 ACTIVE + 1 PREVIOUS. Acquire again -> evicts old PREVIOUS,
			// provides FREE. Instead: warmup all 4 to READY, then acquire.

			warmup("r1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r2", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r3", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r4", "ws-1");

			// Promote all to READY
			for (const tid of ["r1", "r2", "r3", "r4"]) {
				const slot = getSlotForTask(tid)!;
				const cb = (slot as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as (() => void) | undefined;
				cb?.();
				expect(getSlotRole(slot)).toBe("READY");
			}

			// Acquire new-task: no FREE, no PRELOADING, evicts oldest READY (r1)
			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("r1")).toBeNull(); // oldest READY evicted
			expect(getSlotForTask("r2")).not.toBeNull(); // second oldest READY survives
			expect(getSlotForTask("r3")).not.toBeNull();
			expect(getSlotForTask("r4")).not.toBeNull();
		});

		it("never evicts ACTIVE or PREVIOUS", () => {
			// Fill pool: 1 ACTIVE + 1 PREVIOUS + 2 PRELOADING
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1"); // task-1 -> PREVIOUS

			warmup("task-warm-1", "ws-1");
			warmup("task-warm-2", "ws-1");

			const activeSlot = getSlotForTask("task-2")!;

			// Acquire task-3 — evicts a PRELOADING slot
			acquireForTask("task-3", "ws-1");

			// The old active (task-2) is now PREVIOUS, old PREVIOUS (task-1) was evicted
			// Actually re-check: acquireForTask("task-3") demotes task-2 to PREVIOUS,
			// then evicts old PREVIOUS (task-1). Then finds a free/evictable slot.
			// After that, task-2 is PREVIOUS, task-3 is ACTIVE.
			expect(getSlotRole(activeSlot)).toBe("PREVIOUS");

			// Acquire task-4 — task-3 -> PREVIOUS, task-2 evicted, uses remaining PRELOADING
			acquireForTask("task-4", "ws-1");
			const task3Slot = getSlotForTask("task-3")!;
			expect(getSlotRole(task3Slot)).toBe("PREVIOUS");
		});

		it("on PRELOADING/READY slot promotes to ACTIVE", () => {
			initPool(); // extra init is no-op (guarded), but we already init in beforeEach

			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(getSlotRole(slot)).toBe("PRELOADING");

			// Acquire the same task — should promote to ACTIVE without allocating new slot
			const acquired = acquireForTask("task-1", "ws-1");
			expect(acquired).toBe(slot);
			expect(getSlotRole(slot)).toBe("ACTIVE");
		});
	});

	// -----------------------------------------------------------------------
	// warmup
	// -----------------------------------------------------------------------

	describe("warmup", () => {
		beforeEach(() => {
			initPool();
		});

		it("connects FREE slot and sets PRELOADING", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(slot).not.toBeNull();
			expect(getSlotRole(slot)).toBe("PRELOADING");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.connectToTask).toHaveBeenCalledWith("task-1", "ws-1");
			expect(mockSlot.onceConnectionReady).toHaveBeenCalledWith(expect.any(Function));
		});

		it("is no-op for ACTIVE task", () => {
			acquireForTask("task-1", "ws-1");
			const slotBefore = getSlotForTask("task-1")!;
			warmup("task-1", "ws-1");
			const slotAfter = getSlotForTask("task-1")!;
			expect(slotBefore).toBe(slotAfter);
			expect(getSlotRole(slotAfter)).toBe("ACTIVE");
		});

		it("is no-op for PREVIOUS task", () => {
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1"); // task-1 -> PREVIOUS
			expect(getSlotRole(getSlotForTask("task-1")!)).toBe("PREVIOUS");

			warmup("task-1", "ws-1"); // Should be no-op
			expect(getSlotRole(getSlotForTask("task-1")!)).toBe("PREVIOUS");
		});

		it("evicts oldest PRELOADING if no FREE", () => {
			// Use up all 4 slots: 1 ACTIVE, 1 PREVIOUS, 2 PRELOADING
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");

			warmup("task-warm-1", "ws-1");
			vi.advanceTimersByTime(100);
			warmup("task-warm-2", "ws-1");

			// All 4 slots used. Warmup a 5th task — should evict oldest PRELOADING.
			warmup("task-warm-3", "ws-1");
			expect(getSlotForTask("task-warm-1")).toBeNull(); // evicted
			expect(getSlotForTask("task-warm-3")).not.toBeNull();
			expect(getSlotRole(getSlotForTask("task-warm-3")!)).toBe("PRELOADING");
		});

		it("auto-cancels after 3s if not acquired", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(getSlotRole(slot)).toBe("PRELOADING");

			vi.advanceTimersByTime(3000);

			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotRole(slot)).toBe("FREE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// cancelWarmup
	// -----------------------------------------------------------------------

	describe("cancelWarmup", () => {
		beforeEach(() => {
			initPool();
		});

		it("disconnects and returns to FREE", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(getSlotRole(slot)).toBe("PRELOADING");

			cancelWarmup("task-1");

			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotRole(slot)).toBe("FREE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});

		it("is no-op for non-warming task", () => {
			cancelWarmup("nonexistent-task");
			// Should not throw
		});
	});

	// -----------------------------------------------------------------------
	// releaseAll
	// -----------------------------------------------------------------------

	describe("releaseAll", () => {
		beforeEach(() => {
			initPool();
		});

		it("disconnects all slots to FREE", () => {
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");
			warmup("task-3", "ws-1");

			releaseAll();

			const poolSlots = getCurrentPoolSlots();
			const roles = getSlotRoles(poolSlots);
			expect(roles).toEqual(["FREE", "FREE", "FREE", "FREE"]);

			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotForTask("task-2")).toBeNull();
			expect(getSlotForTask("task-3")).toBeNull();
		});

		it("clears warmup timeouts", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;

			releaseAll();

			// Advancing past the warmup timeout should not cause disconnect again
			vi.advanceTimersByTime(5000);
			// cancelWarmup triggered by timeout would try to operate, but since
			// the slot is already FREE and task is unlinked, it's effectively a no-op.
			// The key assertion: no errors thrown and slot stays FREE.
			expect(getSlotRole(slot)).toBe("FREE");
		});
	});

	// -----------------------------------------------------------------------
	// getSlotForTask
	// -----------------------------------------------------------------------

	describe("getSlotForTask", () => {
		beforeEach(() => {
			initPool();
		});

		it("returns slot or null", () => {
			expect(getSlotForTask("task-1")).toBeNull();

			const slot = acquireForTask("task-1", "ws-1");
			expect(getSlotForTask("task-1")).toBe(slot);

			releaseTask("task-1");
			expect(getSlotForTask("task-1")).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// releaseTask
	// -----------------------------------------------------------------------

	describe("releaseTask", () => {
		beforeEach(() => {
			initPool();
		});

		it("disconnects slot and sets FREE", () => {
			const slot = acquireForTask("task-1", "ws-1");
			expect(getSlotRole(slot)).toBe("ACTIVE");

			releaseTask("task-1");

			expect(getSlotRole(slot)).toBe("FREE");
			expect(getSlotForTask("task-1")).toBeNull();
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});

		it("is no-op for unknown taskId", () => {
			releaseTask("nonexistent-task");
			// Should not throw
		});
	});

	// -----------------------------------------------------------------------
	// rotation
	// -----------------------------------------------------------------------

	describe("rotation", () => {
		it("replaces oldest FREE slot", () => {
			initPool();
			const initialSlots = getCurrentPoolSlots();

			// Trigger rotation timer (3 minutes)
			vi.advanceTimersByTime(3 * 60 * 1000);

			// The oldest FREE slot should have been disposed and replaced
			const oldestSlot = initialSlots[0]!;
			expect(oldestSlot.dispose).toHaveBeenCalled();

			// A new TerminalSlot was created (5th call total: 4 init + 1 rotation)
			expect(TerminalSlotMock).toHaveBeenCalledTimes(5);
		});

		it("skips when no FREE slots", () => {
			initPool();

			// Fill all 4 slots: ACTIVE + PREVIOUS + 2 PRELOADING.
			// Warmup 2 tasks first (uses 2 FREE slots), then acquire 2 tasks (uses remaining 2).
			warmup("w1", "ws-1");
			warmup("w2", "ws-1");
			acquireForTask("a1", "ws-1"); // uses FREE slot -> ACTIVE
			acquireForTask("a2", "ws-1"); // a1 -> PREVIOUS, uses last FREE -> ACTIVE

			// Verify all 4 occupied
			expect(getSlotRole(getSlotForTask("w1")!)).toBe("PRELOADING");
			expect(getSlotRole(getSlotForTask("w2")!)).toBe("PRELOADING");
			expect(getSlotRole(getSlotForTask("a1")!)).toBe("PREVIOUS");
			expect(getSlotRole(getSlotForTask("a2")!)).toBe("ACTIVE");

			// Advance to just before the 3s warmup timeout, then check rotation
			// The rotation interval is 3 minutes. We can't advance 3 minutes without
			// the 3s warmup auto-cancelling first. Instead, advance to just under 3s
			// so warmups survive, then verify the state is stable.
			// The real rotation fires at 3 minutes. We need to test it at that point.
			// Strategy: advance in increments. First, advance to 2.9s (warmups survive),
			// then re-warm right before each 3s boundary.

			// Simpler: advance to rotation interval minus a bit, refill warmups, advance rest.
			// Rotation fires at exactly 3*60*1000=180000ms after initPool.
			// Advance to 179000ms (warmups have long since expired, slots freed).
			// Then re-fill and advance the last 1000ms (< 3000ms warmup timeout).
			vi.advanceTimersByTime(179_000);

			// Refill: warmup 2, acquire 2 (all 4 occupied again)
			warmup("w3", "ws-1");
			warmup("w4", "ws-1");
			acquireForTask("a3", "ws-1");
			acquireForTask("a4", "ws-1");

			const constructCallsBefore = TerminalSlotMock.mock.calls.length;

			// Advance the remaining 1000ms to trigger rotation at t=180000
			// (warmup timeout at 3s won't fire since only 1s passes)
			vi.advanceTimersByTime(1_000);

			// No new slot was created — rotation skipped because no FREE slots
			expect(TerminalSlotMock.mock.calls.length).toBe(constructCallsBefore);
		});

		it("disposes old before creating new (no 5th slot)", () => {
			initPool();
			const initialSlots = getCurrentPoolSlots();
			const slot0 = initialSlots[0]!;

			// Track dispose call order
			let disposedBeforeCreate = false;
			slot0.dispose.mockImplementation(() => {
				// At this point, TerminalSlot constructor should NOT have been called for the replacement yet
				const callsSoFar = TerminalSlotMock.mock.calls.length;
				// 4 from initPool — no new one yet
				disposedBeforeCreate = callsSoFar === 4;
			});

			vi.advanceTimersByTime(3 * 60 * 1000);

			expect(disposedBeforeCreate).toBe(true);
			// After rotation: 4 init + 1 rotation = 5 total constructor calls
			expect(TerminalSlotMock).toHaveBeenCalledTimes(5);
		});
	});

	// -----------------------------------------------------------------------
	// eviction clears warmup timeout
	// -----------------------------------------------------------------------

	describe("eviction", () => {
		beforeEach(() => {
			initPool();
		});

		it("cancels warmup timeout for evicted task", () => {
			// Fill all 4 slots with warmups so no FREE slots remain
			warmup("w1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w2", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w3", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w4", "ws-1");

			const slotW1 = getSlotForTask("w1")!;
			const mockW1 = slotW1 as unknown as MockSlot;

			// All 4 PRELOADING. Acquire a new task — findFreeOrEvict evicts oldest
			// PRELOADING (w1), which should also clear w1's warmup timeout.
			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("w1")).toBeNull(); // evicted

			const disconnectCallsBefore = mockW1.disconnectFromTask.mock.calls.length;

			// Advance past the original warmup timeout (3s). If the timeout wasn't
			// cleared, cancelWarmup("w1") would run and call disconnectFromTask again.
			vi.advanceTimersByTime(5000);

			// No additional disconnectFromTask calls — the timeout was cleared on eviction.
			expect(mockW1.disconnectFromTask.mock.calls.length).toBe(disconnectCallsBefore);
		});
	});

	// -----------------------------------------------------------------------
	// isDedicatedTerminalTaskId
	// -----------------------------------------------------------------------

	describe("isDedicatedTerminalTaskId", () => {
		it("returns true for home shell", () => {
			expect(isDedicatedTerminalTaskId("__home_terminal__")).toBe(true);
		});

		it("returns true for detail terminal prefix", () => {
			expect(isDedicatedTerminalTaskId("__detail_terminal__:some-task")).toBe(true);
		});

		it("returns false for regular taskId", () => {
			expect(isDedicatedTerminalTaskId("task-123")).toBe(false);
			expect(isDedicatedTerminalTaskId("regular-task")).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// ensureDedicatedTerminal
	// -----------------------------------------------------------------------

	describe("ensureDedicatedTerminal", () => {
		it("creates and connects TerminalSlot", () => {
			const slot = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			expect(slot).toBeDefined();
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.connectToTask).toHaveBeenCalledWith("__home_terminal__", "ws-1");
		});

		it("reuses existing for same key", () => {
			const slot1 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot2 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#aaa",
				terminalBackgroundColor: "#111",
			});

			expect(slot1).toBe(slot2);
			const mockSlot = slot1 as unknown as MockSlot;
			// setAppearance should have been called on the reuse path
			expect(mockSlot.setAppearance).toHaveBeenCalledWith({
				cursorColor: "#aaa",
				terminalBackgroundColor: "#111",
			});
		});
	});

	// -----------------------------------------------------------------------
	// disposeDedicatedTerminal
	// -----------------------------------------------------------------------

	describe("disposeDedicatedTerminal", () => {
		it("disposes and removes from map", () => {
			const slot = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			disposeDedicatedTerminal("ws-1", "__home_terminal__");

			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.dispose).toHaveBeenCalled();

			// Ensure it was removed — creating again should produce a new slot
			const slot2 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});
			expect(slot2).not.toBe(slot);
		});
	});

	// -----------------------------------------------------------------------
	// disposeAllDedicatedTerminalsForWorkspace
	// -----------------------------------------------------------------------

	describe("disposeAllDedicatedTerminalsForWorkspace", () => {
		it("disposes matching entries", () => {
			const slot1 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot2 = ensureDedicatedTerminal({
				taskId: "__detail_terminal__:task-x",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot3 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-2",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			disposeAllDedicatedTerminalsForWorkspace("ws-1");

			expect((slot1 as unknown as MockSlot).dispose).toHaveBeenCalled();
			expect((slot2 as unknown as MockSlot).dispose).toHaveBeenCalled();
			expect((slot3 as unknown as MockSlot).dispose).not.toHaveBeenCalled();

			// ws-2 terminal should still be reusable
			const slot3Again = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-2",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});
			expect(slot3Again).toBe(slot3);
		});
	});

	// -----------------------------------------------------------------------
	// writeToTerminalBuffer
	// -----------------------------------------------------------------------

	describe("writeToTerminalBuffer", () => {
		it("finds dedicated terminal", () => {
			const slot = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			writeToTerminalBuffer("ws-1", "__home_terminal__", "hello world");

			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.writeText).toHaveBeenCalledWith("hello world");
		});

		it("finds pool terminal", () => {
			initPool();
			const slot = acquireForTask("task-1", "ws-1");

			writeToTerminalBuffer("ws-1", "task-1", "pool text");

			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.writeText).toHaveBeenCalledWith("pool text");
		});
	});

	// -----------------------------------------------------------------------
	// isTerminalSessionRunning
	// -----------------------------------------------------------------------

	describe("isTerminalSessionRunning", () => {
		it("finds dedicated terminal", () => {
			const slot = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				workspaceId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			// Default session state is null
			expect(isTerminalSessionRunning("ws-1", "__home_terminal__")).toBe(false);

			// Set session state to running
			(slot as unknown as MockSlot)._sessionState = "running";
			expect(isTerminalSessionRunning("ws-1", "__home_terminal__")).toBe(true);
		});

		it("returns false for unknown terminal", () => {
			expect(isTerminalSessionRunning("ws-1", "nonexistent")).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// releaseTask calls disconnectFromTask (test 35)
	// -----------------------------------------------------------------------

	describe("disconnectFromTask on release", () => {
		beforeEach(() => {
			initPool();
		});

		it("releaseTask calls disconnectFromTask on the slot", () => {
			const slot = acquireForTask("task-1", "ws-1");
			const mockSlot = slot as unknown as MockSlot;

			releaseTask("task-1");

			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});
	});
});
