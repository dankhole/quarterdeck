import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock TerminalSlot
// ---------------------------------------------------------------------------

interface MockSlot {
	slotId: number;
	_taskId: string | null;
	_projectId: string | null;
	_sessionState: string | null;
	connectToTask: ReturnType<typeof vi.fn>;
	ensureConnected: ReturnType<typeof vi.fn>;
	disconnectFromTask: ReturnType<typeof vi.fn>;
	onceConnectionReady: ReturnType<typeof vi.fn>;
	attachToStageContainer: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	resetRenderer: ReturnType<typeof vi.fn>;
	requestRestore: ReturnType<typeof vi.fn>;
	setFontWeight: ReturnType<typeof vi.fn>;
	writeText: ReturnType<typeof vi.fn>;
	setAppearance: ReturnType<typeof vi.fn>;
	getBufferDebugInfo: ReturnType<typeof vi.fn>;
	connectedTaskId: string | null;
	connectedProjectId: string | null;
	sessionState: string | null;
}

vi.mock("@/terminal/terminal-slot", () => {
	function createMock(slotId: number): MockSlot {
		const mock: MockSlot = {
			slotId,
			_taskId: null,
			_projectId: null,
			_sessionState: null,
			connectToTask: vi.fn((taskId: string, projectId: string) => {
				mock._taskId = taskId;
				mock._projectId = projectId;
			}),
			ensureConnected: vi.fn(),
			disconnectFromTask: vi.fn(async () => {
				mock._taskId = null;
				mock._projectId = null;
			}),
			onceConnectionReady: vi.fn(),
			attachToStageContainer: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
			resetRenderer: vi.fn(),
			requestRestore: vi.fn(),
			setFontWeight: vi.fn(),
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
			get connectedProjectId() {
				return mock._projectId;
			},
			get sessionState() {
				return mock._sessionState;
			},
		};
		return mock;
	}

	const MockTerminalSlot = vi.fn(function (this: MockSlot, slotId: number) {
		const mock = createMock(slotId);
		for (const key of Object.keys(mock)) {
			(this as unknown as Record<string, unknown>)[key] = (mock as unknown as Record<string, unknown>)[key];
		}
		const self = this;
		Object.defineProperty(this, "connectedTaskId", {
			get() {
				return self._taskId;
			},
			configurable: true,
		});
		Object.defineProperty(this, "connectedProjectId", {
			get() {
				return self._projectId;
			},
			configurable: true,
		});
		Object.defineProperty(this, "sessionState", {
			get() {
				return self._sessionState;
			},
			configurable: true,
		});
		this.connectToTask = vi.fn((taskId: string, projectId: string) => {
			self._taskId = taskId;
			self._projectId = projectId;
		});
		this.disconnectFromTask = vi.fn(async () => {
			self._taskId = null;
			self._projectId = null;
		});
	});

	return {
		TerminalSlot: MockTerminalSlot,
		updateGlobalTerminalFontWeight: vi.fn(),
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
	getSlotForTask,
	getSlotRole,
	initPool,
	releaseAll,
	releaseTask,
	type SlotRole,
	warmup,
} from "@/terminal/terminal-pool";
import { TerminalSlot } from "@/terminal/terminal-slot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TerminalSlotMock = TerminalSlot as unknown as ReturnType<typeof vi.fn>;

function getSlotRoles(poolSlots: MockSlot[]): SlotRole[] {
	return poolSlots.map((s) => getSlotRole(s as unknown as TerminalSlot));
}

/** Get all pool slots created during the most recent initPool() call (last 4). */
function getCurrentPoolSlots(): MockSlot[] {
	const all = TerminalSlotMock.mock.instances as unknown as MockSlot[];
	return all.slice(all.length - 4);
}

const WARMUP_MAX_TTL_MS = 12_000;
const PREVIOUS_EVICTION_MS = 8_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-pool — acquire & release", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_resetPoolForTesting();
		TerminalSlotMock.mockClear();
		initPool();
	});

	afterEach(() => {
		_resetPoolForTesting();
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// acquireForTask
	// -----------------------------------------------------------------------

	describe("acquireForTask", () => {
		it("returns slot and sets ACTIVE", () => {
			const slot = acquireForTask("task-1", "ws-1");
			expect(slot).toBeDefined();
			expect(getSlotRole(slot)).toBe("ACTIVE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.connectToTask).toHaveBeenCalledWith("task-1", "ws-1");
		});

		it("for same task returns same slot and calls ensureConnected", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			const mock = slot1 as unknown as MockSlot;
			mock.ensureConnected.mockClear();
			mock.requestRestore.mockClear();
			const slot2 = acquireForTask("task-1", "ws-1");
			expect(slot1).toBe(slot2);
			expect(getSlotRole(slot1)).toBe("ACTIVE");
			expect(mock.ensureConnected).toHaveBeenCalledOnce();
			expect(mock.requestRestore).not.toHaveBeenCalled();
		});

		it("transitions previous ACTIVE to PREVIOUS", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");
			expect(getSlotRole(slot1)).toBe("PREVIOUS");
		});

		it("evicts old PREVIOUS when new PREVIOUS is set", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			const slot2 = acquireForTask("task-2", "ws-1");

			expect(getSlotRole(slot1)).toBe("PREVIOUS");
			expect(getSlotRole(slot2)).toBe("ACTIVE");

			const slot3 = acquireForTask("task-3", "ws-1");

			expect(slot3).toBe(slot1); // reused the evicted slot
			expect(getSlotRole(slot2)).toBe("PREVIOUS");
			const mockSlot1 = slot1 as unknown as MockSlot;
			expect(mockSlot1.disconnectFromTask).toHaveBeenCalled();
		});

		it("evicts PRELOADING before READY", () => {
			warmup("task-warm-1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("task-warm-2", "ws-1");
			vi.advanceTimersByTime(50);

			const warmSlot1 = getSlotForTask("task-warm-1")!;
			const readyCallback1 = (warmSlot1 as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			readyCallback1?.();
			expect(getSlotRole(warmSlot1)).toBe("READY");

			const warmSlot2 = getSlotForTask("task-warm-2")!;
			expect(getSlotRole(warmSlot2)).toBe("PRELOADING");

			acquireForTask("task-a", "ws-1");
			acquireForTask("task-b", "ws-1");

			releaseAll();
			vi.advanceTimersByTime(100);

			warmup("w1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w2", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w3", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w4", "ws-1");

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

			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("w1")).toBeNull();
			expect(getSlotForTask("w2")).not.toBeNull();
			expect(getSlotForTask("w3")).not.toBeNull();
			expect(getSlotForTask("w4")).not.toBeNull();
		});

		it("evicts oldest READY when multiple exist", () => {
			warmup("r1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r2", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r3", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("r4", "ws-1");

			for (const tid of ["r1", "r2", "r3", "r4"]) {
				const slot = getSlotForTask(tid)!;
				const cb = (slot as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as (() => void) | undefined;
				cb?.();
				expect(getSlotRole(slot)).toBe("READY");
			}

			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("r1")).toBeNull();
			expect(getSlotForTask("r2")).not.toBeNull();
			expect(getSlotForTask("r3")).not.toBeNull();
			expect(getSlotForTask("r4")).not.toBeNull();
		});

		it("never evicts ACTIVE or PREVIOUS", () => {
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");

			warmup("task-warm-1", "ws-1");
			warmup("task-warm-2", "ws-1");

			const activeSlot = getSlotForTask("task-2")!;

			acquireForTask("task-3", "ws-1");
			expect(getSlotRole(activeSlot)).toBe("PREVIOUS");

			acquireForTask("task-4", "ws-1");
			const task3Slot = getSlotForTask("task-3")!;
			expect(getSlotRole(task3Slot)).toBe("PREVIOUS");
		});

		it("on PRELOADING/READY slot promotes to ACTIVE", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(getSlotRole(slot)).toBe("PRELOADING");

			const acquired = acquireForTask("task-1", "ws-1");
			expect(acquired).toBe(slot);
			expect(getSlotRole(slot)).toBe("ACTIVE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.requestRestore).toHaveBeenCalledOnce();
		});

		it("demotes the current ACTIVE slot when promoting a warm slot", () => {
			const activeSlot = acquireForTask("task-active", "ws-1");
			warmup("task-warm", "ws-1");
			const warmSlot = getSlotForTask("task-warm")!;

			const acquired = acquireForTask("task-warm", "ws-1");

			expect(acquired).toBe(warmSlot);
			expect(getSlotRole(warmSlot)).toBe("ACTIVE");
			expect(getSlotRole(activeSlot)).toBe("PREVIOUS");
			expect(getSlotRoles(getCurrentPoolSlots()).filter((role) => role === "ACTIVE")).toHaveLength(1);

			vi.advanceTimersByTime(PREVIOUS_EVICTION_MS);

			expect(getSlotForTask("task-active")).toBeNull();
			expect(getSlotRole(activeSlot)).toBe("FREE");
		});

		it("reuses a prewarm slot when the user quickly clicks after hover", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			const mockSlot = slot as unknown as MockSlot;

			vi.advanceTimersByTime(500);

			const acquired = acquireForTask("task-1", "ws-1");
			expect(acquired).toBe(slot);
			expect(getSlotRole(slot)).toBe("ACTIVE");

			vi.advanceTimersByTime(WARMUP_MAX_TTL_MS);

			expect(getSlotForTask("task-1")).toBe(slot);
			expect(getSlotRole(slot)).toBe("ACTIVE");
			expect(mockSlot.disconnectFromTask).not.toHaveBeenCalled();
		});

		it("re-syncs when reacquiring a PREVIOUS slot", () => {
			const slot1 = acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");

			const mockSlot1 = slot1 as unknown as MockSlot;
			mockSlot1.requestRestore.mockClear();

			const reacquired = acquireForTask("task-1", "ws-1");
			expect(reacquired).toBe(slot1);
			expect(getSlotRole(slot1)).toBe("ACTIVE");
			expect(mockSlot1.requestRestore).toHaveBeenCalledOnce();
		});

		it("demotes the current ACTIVE slot when reacquiring a PREVIOUS slot", () => {
			const task1Slot = acquireForTask("task-1", "ws-1");
			const task2Slot = acquireForTask("task-2", "ws-1");

			const reacquired = acquireForTask("task-1", "ws-1");

			expect(reacquired).toBe(task1Slot);
			expect(getSlotRole(task1Slot)).toBe("ACTIVE");
			expect(getSlotRole(task2Slot)).toBe("PREVIOUS");
			expect(getSlotRoles(getCurrentPoolSlots()).filter((role) => role === "ACTIVE")).toHaveLength(1);

			vi.advanceTimersByTime(PREVIOUS_EVICTION_MS);

			expect(getSlotForTask("task-2")).toBeNull();
			expect(getSlotRole(task2Slot)).toBe("FREE");
		});
	});

	// -----------------------------------------------------------------------
	// releaseTask
	// -----------------------------------------------------------------------

	describe("releaseTask", () => {
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
		});
	});

	// -----------------------------------------------------------------------
	// getSlotForTask
	// -----------------------------------------------------------------------

	describe("getSlotForTask", () => {
		it("returns slot or null", () => {
			expect(getSlotForTask("task-1")).toBeNull();

			const slot = acquireForTask("task-1", "ws-1");
			expect(getSlotForTask("task-1")).toBe(slot);

			releaseTask("task-1");
			expect(getSlotForTask("task-1")).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// releaseAll
	// -----------------------------------------------------------------------

	describe("releaseAll", () => {
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

		it("clears warmup timers", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			const mockSlot = slot as unknown as MockSlot;

			releaseAll();
			const disconnectCallsAfterRelease = mockSlot.disconnectFromTask.mock.calls.length;

			vi.advanceTimersByTime(WARMUP_MAX_TTL_MS);
			expect(getSlotRole(slot)).toBe("FREE");
			expect(mockSlot.disconnectFromTask.mock.calls.length).toBe(disconnectCallsAfterRelease);
		});
	});

	// -----------------------------------------------------------------------
	// disconnectFromTask on release
	// -----------------------------------------------------------------------

	describe("disconnectFromTask on release", () => {
		it("releaseTask calls disconnectFromTask on the slot", () => {
			const slot = acquireForTask("task-1", "ws-1");
			const mockSlot = slot as unknown as MockSlot;

			releaseTask("task-1");

			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});
	});
});
