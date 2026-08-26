import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRuntimeStateStreamTransport } from "@/runtime/runtime-state-stream-transport";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	readonly close = vi.fn();

	constructor(public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	emitOpen(): void {
		this.onopen?.(new Event("open"));
	}

	emitClose(): void {
		this.onclose?.(new CloseEvent("close"));
	}

	emitError(): void {
		this.onerror?.(new Event("error"));
	}

	emitMessage(data: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}

function setDocumentVisibilityState(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

describe("startRuntimeStateStreamTransport", () => {
	let originalWebSocket: typeof WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		vi.useFakeTimers();
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
		setDocumentVisibilityState("visible");
		vi.useRealTimers();
	});

	it("switches the websocket connection to the new project immediately", () => {
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected: vi.fn(),
			onMessage: vi.fn(),
		});

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(FakeWebSocket.instances[0]?.url).toContain("projectId=project-a");

		transport.switchProject("project-b");

		expect(FakeWebSocket.instances[0]?.close).toHaveBeenCalledTimes(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(FakeWebSocket.instances[1]?.url).toContain("projectId=project-b");

		transport.dispose();
	});

	it("does not report a connection ready until its initial snapshot is admitted", () => {
		const onConnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected,
			onDisconnected: vi.fn(),
			onMessage: vi.fn(),
		});
		const socket = FakeWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected an initial websocket.");
		}

		socket.emitOpen();
		expect(onConnected).not.toHaveBeenCalled();

		transport.acceptCurrentConnection();
		transport.acceptCurrentConnection();

		expect(onConnected).toHaveBeenCalledTimes(1);
		transport.dispose();
	});

	it("drops fanout messages that race ahead of the compatible initial snapshot", () => {
		const onMessage = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected: vi.fn(),
			onMessage,
		});
		const socket = FakeWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected an initial websocket.");
		}

		socket.emitOpen();
		socket.emitMessage({ type: "projects_updated", projects: [] });
		expect(onMessage).not.toHaveBeenCalled();

		socket.emitMessage({ type: "snapshot" });
		expect(onMessage).toHaveBeenCalledTimes(1);
		transport.acceptCurrentConnection();

		socket.emitMessage({ type: "projects_updated", projects: [] });
		expect(onMessage).toHaveBeenCalledTimes(2);
		transport.dispose();
	});

	it("rejects a queued message from a socket superseded by a project switch", () => {
		const onMessage = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected: vi.fn(),
			onMessage,
		});
		const firstSocket = FakeWebSocket.instances[0];
		const staleHandler = firstSocket?.onmessage;
		if (!firstSocket || !staleHandler) {
			throw new Error("Expected an initial websocket message handler.");
		}

		transport.switchProject("project-b");
		staleHandler(new MessageEvent("message", { data: JSON.stringify({ type: "error", message: "stale" }) }));

		expect(onMessage).not.toHaveBeenCalled();
		transport.dispose();
	});

	it("includes current document visibility in every websocket URL", () => {
		setDocumentVisibilityState("hidden");

		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected: vi.fn(),
			onMessage: vi.fn(),
		});

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(new URL(FakeWebSocket.instances[0]?.url ?? "").searchParams.get("documentVisible")).toBe("false");
		expect(new URL(FakeWebSocket.instances[0]?.url ?? "").searchParams.get("browserBuildId")).toBe("test");

		transport.dispose();
	});

	it("reconnects after the socket closes", () => {
		const onDisconnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected,
			onMessage: vi.fn(),
		});
		const firstSocket = FakeWebSocket.instances[0];
		if (!firstSocket) {
			throw new Error("Expected an initial websocket.");
		}

		firstSocket.emitClose();

		expect(onDisconnected).toHaveBeenCalledWith("Runtime stream disconnected.");
		expect(FakeWebSocket.instances).toHaveLength(1);

		vi.advanceTimersByTime(500);

		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(FakeWebSocket.instances[1]?.url).toContain("projectId=project-a");

		transport.dispose();
	});

	it("reports a transport failure once even when onerror is followed by onclose", () => {
		const onDisconnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected,
			onMessage: vi.fn(),
		});
		const firstSocket = FakeWebSocket.instances[0];
		if (!firstSocket) {
			throw new Error("Expected an initial websocket.");
		}

		firstSocket.emitError();
		firstSocket.emitClose();

		expect(onDisconnected).toHaveBeenCalledTimes(1);
		expect(onDisconnected).toHaveBeenCalledWith("Runtime stream connection failed.");

		vi.advanceTimersByTime(500);

		expect(FakeWebSocket.instances).toHaveLength(2);

		transport.dispose();
	});
});
