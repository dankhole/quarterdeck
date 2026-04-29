import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId } from "@/runtime/types";

const viewportInstances: Array<{
	applyRestoreSnapshot: ReturnType<typeof vi.fn>;
	finalizeRestorePresentation: ReturnType<typeof vi.fn>;
	forceResize: ReturnType<typeof vi.fn>;
	stageContainer: HTMLDivElement | null;
}> = [];
const sessionInstances: Array<{
	hasIoSocket: boolean;
	notifyConnectionReadyAfterRestore: ReturnType<typeof vi.fn>;
	requestRestore: ReturnType<typeof vi.fn>;
	reconnect: ReturnType<typeof vi.fn>;
	sessionAgentId: RuntimeAgentId | null;
	isIoOpen: boolean;
	emitRestore: (snapshot: string) => Promise<void>;
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
			finalizeRestorePresentation: vi.fn(
				async (options: { hasActiveIoSocket: boolean }) => options.hasActiveIoSocket,
			),
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
		callbacks: {
			applyRestore: (snapshot: string, cols: number | null, rows: number | null) => Promise<void>;
			onSummaryStateChange: (summary: unknown, previousSummary: unknown) => void;
		},
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
			emitRestore: async (snapshot: string) => {
				await callbacks.applyRestore(snapshot, null, null);
			},
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

function createDeferred<T>() {
	let resolve: (value?: T | PromiseLike<T>) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
		reject = promiseReject;
	});
	return { promise, resolve, reject };
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

	it("reports restore readiness only after restore presentation completes", async () => {
		const order: string[] = [];
		const presentation = createDeferred<void>();
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const viewport = getLatestViewport();
		const session = getLatestSession();
		session.hasIoSocket = true;
		viewport.applyRestoreSnapshot.mockImplementation(async () => {
			order.push("apply");
		});
		viewport.finalizeRestorePresentation.mockImplementation(async (options) => {
			order.push("present-start");
			expect(options.hasActiveIoSocket).toBe(true);
			await presentation.promise;
			order.push("present-end");
			return true;
		});

		const restorePromise = session.emitRestore("snapshot");
		await Promise.resolve();

		expect(order).toEqual(["apply", "present-start"]);
		expect(session.notifyConnectionReadyAfterRestore).not.toHaveBeenCalled();

		presentation.resolve();
		await restorePromise;

		expect(order).toEqual(["apply", "present-start", "present-end"]);
		expect(session.notifyConnectionReadyAfterRestore).toHaveBeenCalledOnce();
	});

	it("does not report restore readiness when restore presentation is superseded", async () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const viewport = getLatestViewport();
		const session = getLatestSession();
		session.hasIoSocket = true;
		viewport.finalizeRestorePresentation.mockResolvedValue(false);

		await session.emitRestore("snapshot");

		expect(session.notifyConnectionReadyAfterRestore).not.toHaveBeenCalled();
	});

	it("does not report restore readiness before an IO socket exists", async () => {
		new TerminalAttachmentController(
			1,
			{ cursorColor: "cursor", terminalBackgroundColor: "background" },
			{ isDisposed: () => false },
		);
		const viewport = getLatestViewport();
		const session = getLatestSession();
		session.hasIoSocket = false;

		await session.emitRestore("snapshot");

		expect(viewport.finalizeRestorePresentation).toHaveBeenCalledWith({ hasActiveIoSocket: false });
		expect(session.notifyConnectionReadyAfterRestore).not.toHaveBeenCalled();
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
