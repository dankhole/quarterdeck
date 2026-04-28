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

const browserWarnMock = vi.hoisted(() => vi.fn());
const clientLogWarnMock = vi.hoisted(() => vi.fn());

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
		warn: clientLogWarnMock,
		error: vi.fn(),
	}),
}));

vi.mock("@/utils/global-error-capture", () => ({
	warnToBrowserConsole: browserWarnMock,
}));

// ---------------------------------------------------------------------------
// Import pool under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import {
	_resetPoolForTesting,
	acquireForTask,
	attachPoolContainer,
	cancelWarmup,
	collectTerminalDebugState,
	detachPoolContainer,
	getSlotForTask,
	getSlotRole,
	initPool,
	type SlotRole,
	warmup,
} from "@/terminal/terminal-pool";
import { TerminalSlot } from "@/terminal/terminal-slot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TerminalSlotMock = TerminalSlot as unknown as ReturnType<typeof vi.fn>;

function getPoolSlots(): MockSlot[] {
	return TerminalSlotMock.mock.instances as unknown as MockSlot[];
}

function getCurrentPoolSlots(): MockSlot[] {
	const all = getPoolSlots();
	return all.slice(all.length - 4);
}

function getSlotRoles(poolSlots: MockSlot[]): SlotRole[] {
	return poolSlots.map((s) => getSlotRole(s as unknown as TerminalSlot));
}

const WARMUP_TIMEOUT_MS = 3_000;
const WARMUP_MAX_TTL_MS = 12_000;
const PREVIOUS_EVICTION_MS = 8_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-pool — lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_resetPoolForTesting();
		TerminalSlotMock.mockClear();
		browserWarnMock.mockClear();
		clientLogWarnMock.mockClear();
		document.body.innerHTML = "";
	});

	afterEach(() => {
		_resetPoolForTesting();
		document.body.innerHTML = "";
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

		it("exposes a console-safe terminal state dump hook", () => {
			initPool();
			const helperTextarea = document.createElement("textarea");
			helperTextarea.className = "xterm-helper-textarea";
			document.body.appendChild(helperTextarea);

			const state = collectTerminalDebugState();

			expect(typeof window.__quarterdeckDumpTerminalState).toBe("function");
			expect(state.registered).toEqual({
				total: 4,
				pool: 4,
				dedicated: 0,
			});
			expect(state.poolSlots).toHaveLength(4);
			expect(state.dom.helperTextareaCount).toBe(1);
			expect(state.dom.helperTextareasMissingId).toBe(1);
		});

		it("warns when terminal DOM counts exceed the expected ceiling", () => {
			initPool();
			for (let index = 0; index < 9; index += 1) {
				const helperTextarea = document.createElement("textarea");
				helperTextarea.className = "xterm-helper-textarea";
				document.body.appendChild(helperTextarea);
			}

			vi.advanceTimersByTime(60_000);
			vi.advanceTimersByTime(1);

			expect(browserWarnMock).toHaveBeenCalledWith(
				expect.stringContaining("terminal DOM count exceeded expected ceiling"),
				expect.objectContaining({
					helperTextareas: 9,
					threshold: 8,
				}),
			);
			expect(clientLogWarnMock).toHaveBeenCalledWith(
				"terminal DOM count exceeded expected ceiling",
				expect.objectContaining({
					helperTextareas: 9,
					threshold: 8,
				}),
			);
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
			acquireForTask("task-2", "ws-1");
			expect(getSlotRole(getSlotForTask("task-1")!)).toBe("PREVIOUS");

			warmup("task-1", "ws-1");
			expect(getSlotRole(getSlotForTask("task-1")!)).toBe("PREVIOUS");
		});

		it("evicts oldest PRELOADING if no FREE", () => {
			acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");

			warmup("task-warm-1", "ws-1");
			vi.advanceTimersByTime(100);
			warmup("task-warm-2", "ws-1");

			warmup("task-warm-3", "ws-1");
			expect(getSlotForTask("task-warm-1")).toBeNull();
			expect(getSlotForTask("task-warm-3")).not.toBeNull();
			expect(getSlotRole(getSlotForTask("task-warm-3")!)).toBe("PRELOADING");
		});

		it("evicts warm slots after max TTL even without cancelWarmup", () => {
			warmup("task-preloading", "ws-1");
			warmup("task-ready", "ws-1");
			const preloadingSlot = getSlotForTask("task-preloading")!;
			const readySlot = getSlotForTask("task-ready")!;
			expect(getSlotRole(preloadingSlot)).toBe("PRELOADING");
			expect(getSlotRole(readySlot)).toBe("PRELOADING");

			const readyCallback = (readySlot as unknown as MockSlot).onceConnectionReady.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			readyCallback?.();
			expect(getSlotRole(readySlot)).toBe("READY");

			vi.advanceTimersByTime(WARMUP_MAX_TTL_MS - 1);

			expect(getSlotForTask("task-preloading")).toBe(preloadingSlot);
			expect(getSlotForTask("task-ready")).toBe(readySlot);

			vi.advanceTimersByTime(1);

			expect(getSlotForTask("task-preloading")).toBeNull();
			expect(getSlotForTask("task-ready")).toBeNull();
			expect(getSlotRole(preloadingSlot)).toBe("FREE");
			expect(getSlotRole(readySlot)).toBe("FREE");
			expect((preloadingSlot as unknown as MockSlot).disconnectFromTask).toHaveBeenCalled();
			expect((readySlot as unknown as MockSlot).disconnectFromTask).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// cancelWarmup
	// -----------------------------------------------------------------------

	describe("cancelWarmup", () => {
		beforeEach(() => {
			initPool();
		});

		it("starts a grace period then disconnects and returns to FREE", () => {
			warmup("task-1", "ws-1");
			const slot = getSlotForTask("task-1")!;
			expect(getSlotRole(slot)).toBe("PRELOADING");

			cancelWarmup("task-1");

			expect(getSlotForTask("task-1")).not.toBeNull();
			expect(getSlotRole(slot)).toBe("PRELOADING");

			vi.advanceTimersByTime(WARMUP_TIMEOUT_MS);

			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotRole(slot)).toBe("FREE");
			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.disconnectFromTask).toHaveBeenCalled();
		});

		it("grace period is cancelled if acquireForTask reuses the slot", () => {
			warmup("task-1", "ws-1");
			cancelWarmup("task-1");

			const slot = acquireForTask("task-1", "ws-1");
			expect(slot).toBeDefined();

			vi.advanceTimersByTime(WARMUP_TIMEOUT_MS + 2_000);
			expect(getSlotRole(slot)).toBe("ACTIVE");
		});

		it("is no-op for non-warming task", () => {
			cancelWarmup("nonexistent-task");
		});
	});

	// -----------------------------------------------------------------------
	// eviction
	// -----------------------------------------------------------------------

	describe("eviction", () => {
		beforeEach(() => {
			initPool();
		});

		it("evicts PREVIOUS slots after the shorter TTL", () => {
			const slot = acquireForTask("task-1", "ws-1");
			acquireForTask("task-2", "ws-1");
			expect(getSlotRole(slot)).toBe("PREVIOUS");

			vi.advanceTimersByTime(PREVIOUS_EVICTION_MS - 1);

			expect(getSlotForTask("task-1")).toBe(slot);
			expect(getSlotRole(slot)).toBe("PREVIOUS");

			vi.advanceTimersByTime(1);

			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotRole(slot)).toBe("FREE");
			expect((slot as unknown as MockSlot).disconnectFromTask).toHaveBeenCalled();
		});

		it("keeps the newly demoted PREVIOUS timer when stale PREVIOUS is evicted", () => {
			acquireForTask("task-1", "ws-1");
			const task2Slot = acquireForTask("task-2", "ws-1");
			expect(getSlotRole(task2Slot)).toBe("ACTIVE");

			acquireForTask("task-3", "ws-1");
			expect(getSlotForTask("task-1")).toBeNull();
			expect(getSlotRole(task2Slot)).toBe("PREVIOUS");

			vi.advanceTimersByTime(PREVIOUS_EVICTION_MS);

			expect(getSlotForTask("task-2")).toBeNull();
			expect(getSlotRole(task2Slot)).toBe("FREE");
			expect((task2Slot as unknown as MockSlot).disconnectFromTask).toHaveBeenCalled();
		});

		it("cancels warmup timeout for evicted task", () => {
			warmup("w1", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w2", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w3", "ws-1");
			vi.advanceTimersByTime(50);
			warmup("w4", "ws-1");

			const slotW1 = getSlotForTask("w1")!;
			const mockW1 = slotW1 as unknown as MockSlot;

			acquireForTask("new-task", "ws-1");
			expect(getSlotForTask("w1")).toBeNull();

			const disconnectCallsBefore = mockW1.disconnectFromTask.mock.calls.length;

			vi.advanceTimersByTime(WARMUP_TIMEOUT_MS + 2_000);

			expect(mockW1.disconnectFromTask.mock.calls.length).toBe(disconnectCallsBefore);
		});
	});

	// -----------------------------------------------------------------------
	// rotation
	// -----------------------------------------------------------------------

	describe("rotation", () => {
		it("replaces oldest FREE slot", () => {
			initPool();
			const initialSlots = getCurrentPoolSlots();

			vi.advanceTimersByTime(3 * 60 * 1000);

			const oldestSlot = initialSlots[0]!;
			expect(oldestSlot.dispose).toHaveBeenCalled();

			expect(TerminalSlotMock).toHaveBeenCalledTimes(5);
		});

		it("skips when no FREE slots", () => {
			initPool();

			warmup("w1", "ws-1");
			warmup("w2", "ws-1");
			acquireForTask("a1", "ws-1");
			acquireForTask("a2", "ws-1");

			expect(getSlotRole(getSlotForTask("w1")!)).toBe("PRELOADING");
			expect(getSlotRole(getSlotForTask("w2")!)).toBe("PRELOADING");
			expect(getSlotRole(getSlotForTask("a1")!)).toBe("PREVIOUS");
			expect(getSlotRole(getSlotForTask("a2")!)).toBe("ACTIVE");

			vi.advanceTimersByTime(179_000);

			warmup("w3", "ws-1");
			warmup("w4", "ws-1");
			acquireForTask("a3", "ws-1");
			acquireForTask("a4", "ws-1");

			const constructCallsBefore = TerminalSlotMock.mock.calls.length;

			vi.advanceTimersByTime(1_000);

			expect(TerminalSlotMock.mock.calls.length).toBe(constructCallsBefore);
		});

		it("disposes old before creating new (no 5th slot)", () => {
			initPool();
			const initialSlots = getCurrentPoolSlots();
			const slot0 = initialSlots[0]!;

			let disposedBeforeCreate = false;
			slot0.dispose.mockImplementation(() => {
				const callsSoFar = TerminalSlotMock.mock.calls.length;
				disposedBeforeCreate = callsSoFar === 4;
			});

			vi.advanceTimersByTime(3 * 60 * 1000);

			expect(disposedBeforeCreate).toBe(true);
			expect(TerminalSlotMock).toHaveBeenCalledTimes(5);
		});
	});

	// -----------------------------------------------------------------------
	// attachPoolContainer / detachPoolContainer
	// -----------------------------------------------------------------------

	describe("attachPoolContainer", () => {
		it("calls attachToStageContainer on all pool slots", () => {
			initPool();
			const poolSlots = getCurrentPoolSlots();
			const container = document.createElement("div");

			attachPoolContainer(container);

			for (const slot of poolSlots) {
				expect(slot.attachToStageContainer).toHaveBeenCalledWith(container);
			}
		});

		it("is idempotent for the same container", () => {
			initPool();
			const poolSlots = getCurrentPoolSlots();
			const container = document.createElement("div");

			attachPoolContainer(container);
			attachPoolContainer(container);

			for (const slot of poolSlots) {
				expect(slot.attachToStageContainer).toHaveBeenCalledTimes(1);
			}
		});

		it("stages replacement slot after rotation", () => {
			initPool();
			const container = document.createElement("div");
			attachPoolContainer(container);

			vi.advanceTimersByTime(3 * 60 * 1000);

			const allSlots = getPoolSlots();
			const replacementSlot = allSlots[allSlots.length - 1]!;
			expect(replacementSlot.attachToStageContainer).toHaveBeenCalledWith(container);
		});
	});

	describe("detachPoolContainer", () => {
		it("clears poolContainer so rotation does not stage", () => {
			initPool();
			const container = document.createElement("div");
			attachPoolContainer(container);
			detachPoolContainer();

			vi.advanceTimersByTime(3 * 60 * 1000);

			const allSlots = getPoolSlots();
			const replacementSlot = allSlots[allSlots.length - 1]!;
			expect(replacementSlot.attachToStageContainer).not.toHaveBeenCalled();
		});
	});
});
