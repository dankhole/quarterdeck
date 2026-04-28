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
	setPoolRoleForDiagnostics: ReturnType<typeof vi.fn>;
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
			setPoolRoleForDiagnostics: vi.fn(),
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
	disposeAllDedicatedTerminalsForProject,
	disposeDedicatedTerminal,
	ensureDedicatedTerminal,
	initPool,
	isDedicatedTerminalTaskId,
	isTerminalSessionRunning,
	writeToTerminalBuffer,
} from "@/terminal/terminal-pool";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-pool — dedicated terminals", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_resetPoolForTesting();
	});

	afterEach(() => {
		_resetPoolForTesting();
		vi.useRealTimers();
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
				projectId: "ws-1",
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
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot2 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				projectId: "ws-1",
				cursorColor: "#aaa",
				terminalBackgroundColor: "#111",
			});

			expect(slot1).toBe(slot2);
			const mockSlot = slot1 as unknown as MockSlot;
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
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			disposeDedicatedTerminal("ws-1", "__home_terminal__");

			const mockSlot = slot as unknown as MockSlot;
			expect(mockSlot.dispose).toHaveBeenCalled();

			const slot2 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});
			expect(slot2).not.toBe(slot);
		});
	});

	// -----------------------------------------------------------------------
	// disposeAllDedicatedTerminalsForProject
	// -----------------------------------------------------------------------

	describe("disposeAllDedicatedTerminalsForProject", () => {
		it("disposes matching entries", () => {
			const slot1 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot2 = ensureDedicatedTerminal({
				taskId: "__detail_terminal__:task-x",
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			const slot3 = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				projectId: "ws-2",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			disposeAllDedicatedTerminalsForProject("ws-1");

			expect((slot1 as unknown as MockSlot).dispose).toHaveBeenCalled();
			expect((slot2 as unknown as MockSlot).dispose).toHaveBeenCalled();
			expect((slot3 as unknown as MockSlot).dispose).not.toHaveBeenCalled();

			const slot3Again = ensureDedicatedTerminal({
				taskId: "__home_terminal__",
				projectId: "ws-2",
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
				projectId: "ws-1",
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
				projectId: "ws-1",
				cursorColor: "#fff",
				terminalBackgroundColor: "#000",
			});

			expect(isTerminalSessionRunning("ws-1", "__home_terminal__")).toBe(false);

			(slot as unknown as MockSlot)._sessionState = "running";
			expect(isTerminalSessionRunning("ws-1", "__home_terminal__")).toBe(true);
		});

		it("returns false for unknown terminal", () => {
			expect(isTerminalSessionRunning("ws-1", "nonexistent")).toBe(false);
		});
	});
});
