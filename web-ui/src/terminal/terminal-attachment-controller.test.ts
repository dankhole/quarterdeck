import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId } from "@/runtime/types";

const viewportInstances: Array<{
	forceResize: ReturnType<typeof vi.fn>;
	stageContainer: HTMLDivElement | null;
}> = [];
const sessionInstances: Array<{
	requestRestore: ReturnType<typeof vi.fn>;
	reconnect: ReturnType<typeof vi.fn>;
	sessionAgentId: RuntimeAgentId | null;
	isIoOpen: boolean;
	emitSummaryStateChange: (summary: {
		state: "idle" | "running" | "awaiting_review" | "interrupted" | "failed";
		startedAt: number | null;
		pid: number | null;
	}) => void;
}> = [];

let nextSessionAgentId: RuntimeAgentId | null = null;

vi.mock("@/terminal/terminal-viewport", () => ({
	TerminalViewport: vi.fn(function TerminalViewportMock() {
		const stageContainer = document.createElement("div");
		const instance = {
			forceResize: vi.fn(),
			visibleContainer: null,
			stageContainer,
			ensureVisible: vi.fn(),
			invalidateResize: vi.fn(),
			requestResize: vi.fn(),
			attachToStageContainer: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			park: vi.fn(),
			writeText: vi.fn(),
			focus: vi.fn(),
			input: vi.fn(),
			paste: vi.fn(),
			clear: vi.fn(),
			reset: vi.fn(),
			resetRenderer: vi.fn(),
			refreshVisibleRows: vi.fn(),
			getBufferDebugInfo: vi.fn(),
			readBufferLines: vi.fn(() => []),
			dispose: vi.fn(),
			setAppearance: vi.fn(),
			setFontWeight: vi.fn(),
			applyRestoreSnapshot: vi.fn(async () => {}),
			finalizeRestorePresentation: vi.fn(),
			drainWrites: vi.fn(async () => {}),
			resetBuffer: vi.fn(),
		};
		viewportInstances.push(instance);
		return instance;
	}),
}));

vi.mock("@/terminal/terminal-session-handle", () => ({
	TerminalSessionHandle: vi.fn(function TerminalSessionHandleMock(
		_slotId: number,
		callbacks: { onSummaryStateChange: (summary: unknown, previousSummary: unknown) => void },
	) {
		let latestSummary: {
			state: "idle" | "running" | "awaiting_review" | "interrupted" | "failed";
			startedAt: number | null;
			pid: number | null;
		} | null = null;
		const instance = {
			requestRestore: vi.fn(),
			sessionAgentId: nextSessionAgentId,
			sessionState: null,
			connectedTaskId: null,
			connectedProjectId: null,
			hasIoSocket: false,
			hasControlSocket: false,
			isIoOpen: false,
			restoreCompleted: false,
			ensureConnected: vi.fn(),
			reconnect: vi.fn(),
			connectToTask: vi.fn(),
			disconnectFromTask: vi.fn(() => null),
			onceConnectionReady: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			sendControl: vi.fn(),
			sendIo: vi.fn(),
			stop: vi.fn(async () => {}),
			dispose: vi.fn(),
			publishOutputText: vi.fn(),
			notifyConnectionReadyAfterRestore: vi.fn(),
			notifyInteractiveShown: vi.fn(),
			emitSummaryStateChange: (summary: {
				state: "idle" | "running" | "awaiting_review" | "interrupted" | "failed";
				startedAt: number | null;
				pid: number | null;
			}) => {
				callbacks.onSummaryStateChange(summary, latestSummary);
				latestSummary = summary;
			},
		};
		sessionInstances.push(instance);
		return instance;
	}),
}));

import { TerminalAttachmentController } from "@/terminal/terminal-attachment-controller";

function getLatestViewport() {
	const viewport = viewportInstances.at(-1);
	if (!viewport) {
		throw new Error("Expected TerminalViewport instance");
	}
	return viewport;
}

function getLatestSession() {
	const session = sessionInstances.at(-1);
	if (!session) {
		throw new Error("Expected TerminalSessionHandle instance");
	}
	return session;
}

describe("TerminalAttachmentController", () => {
	beforeEach(() => {
		viewportInstances.length = 0;
		sessionInstances.length = 0;
		nextSessionAgentId = null;
	});

	it("forces a redraw before requesting restore for Codex sessions", () => {
		nextSessionAgentId = "codex";
		const callOrder: string[] = [];
		const controller = new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const viewport = getLatestViewport();
		const session = getLatestSession();
		viewport.forceResize.mockImplementation(() => {
			callOrder.push("forceResize");
		});
		session.requestRestore.mockImplementation(() => {
			callOrder.push("requestRestore");
		});

		controller.requestRestore();

		expect(viewport.forceResize).toHaveBeenCalledOnce();
		expect(session.requestRestore).toHaveBeenCalledOnce();
		expect(callOrder).toEqual(["forceResize", "requestRestore"]);
	});

	it("keeps restore-only behavior for non-Codex sessions", () => {
		nextSessionAgentId = "claude";
		const controller = new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const viewport = getLatestViewport();
		const session = getLatestSession();

		controller.requestRestore();

		expect(viewport.forceResize).not.toHaveBeenCalled();
		expect(session.requestRestore).toHaveBeenCalledOnce();
	});

	it("reconnects sockets when the same task reports a new session instance", () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const session = getLatestSession();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });
		session.reconnect.mockClear();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 200, pid: 222 });

		expect(session.reconnect).toHaveBeenCalledWith("session_instance_changed");
	});

	it("reconnects sockets even when the IO stream is open for a new session instance", () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const session = getLatestSession();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });
		session.reconnect.mockClear();
		session.isIoOpen = true;

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 200, pid: 222 });

		expect(session.reconnect).toHaveBeenCalledWith("session_instance_changed");
	});

	it("does not reconnect sockets for processless stop summaries", () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const session = getLatestSession();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });
		session.reconnect.mockClear();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: null });

		expect(session.reconnect).not.toHaveBeenCalled();
	});

	it("reconnects when a live replacement pid appears after a processless stop summary", () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const session = getLatestSession();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });
		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: null });
		session.reconnect.mockClear();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 200, pid: 222 });

		expect(session.reconnect).toHaveBeenCalledWith("session_instance_changed");
	});

	it("does not request restore for summary updates on the same session instance", () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const session = getLatestSession();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });
		session.requestRestore.mockClear();

		session.emitSummaryStateChange({ state: "awaiting_review", startedAt: 100, pid: 111 });

		expect(session.requestRestore).not.toHaveBeenCalled();
	});
});
