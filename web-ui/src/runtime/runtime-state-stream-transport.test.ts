import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	observeRuntimeAdmissionResponse,
	RUNTIME_ADMISSION_REQUIRED_MESSAGE,
} from "@/runtime/runtime-client-admission";
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
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
		setDocumentVisibilityState("visible");
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("uses the pinned desktop endpoint and encodes the project without exposing bootstrap metadata", () => {
		vi.stubGlobal("window", {
			location: { protocol: "app:", host: "quarterdeck" },
			setTimeout: window.setTimeout.bind(window),
			clearTimeout: window.clearTimeout.bind(window),
			quarterdeckDesktop: {
				version: 1,
				bootstrap: {
					runtimeOrigin: "http://127.0.0.1:54321",
					runtimeGeneration: "generation-1",
					capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
				},
			},
		});
		const transport = startRuntimeStateStreamTransport("project ü /&?#", {
			onConnected: vi.fn(),
			onDisconnected: vi.fn(),
			onMessage: vi.fn(),
		});
		const url = new URL(FakeWebSocket.instances[0]?.url ?? "");
		expect(url.origin).toBe("ws://127.0.0.1:54321");
		expect(url.pathname).toBe("/api/runtime/ws");
		expect(url.searchParams.get("projectId")).toBe("project ü /&?#");
		expect(url.searchParams.get("browserBuildId")).toBe("test");
		expect([...url.searchParams.keys()].sort()).toEqual([
			"browserBuildId",
			"clientId",
			"documentVisible",
			"projectId",
		]);
		expect(url.username).toBe("");
		expect(url.password).toBe("");
		expect(url.hash).toBe("");
		transport.dispose();
	});

	it("reports invalid desktop bootstrap without opening a socket or falling back to the page host", () => {
		vi.stubGlobal("window", {
			location: { protocol: "app:", host: "quarterdeck" },
			setTimeout: window.setTimeout.bind(window),
			clearTimeout: window.clearTimeout.bind(window),
			quarterdeckDesktop: { version: 99 },
		});
		const onDisconnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected,
			onMessage: vi.fn(),
		});
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(onDisconnected).toHaveBeenCalledWith(
			"Desktop runtime bootstrap is invalid or unsupported. Restart Quarterdeck.",
		);
		transport.dispose();
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

	it("reconnects after the socket closes", async () => {
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

		await vi.advanceTimersByTimeAsync(500);

		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(FakeWebSocket.instances[1]?.url).toContain("projectId=project-a");

		transport.dispose();
	});

	it("reports a transport failure once even when onerror is followed by onclose", async () => {
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

		await vi.advanceTimersByTimeAsync(500);

		expect(FakeWebSocket.instances).toHaveLength(2);

		transport.dispose();
	});
	it.each(["browser session expiry", "runtime generation restart"])(
		"stops reconnecting after %s requires fresh admission",
		async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }), { status: 401 }),
				),
			);
			const onDisconnected = vi.fn();
			const transport = startRuntimeStateStreamTransport("project-a", {
				onConnected: vi.fn(),
				onDisconnected,
				onMessage: vi.fn(),
			});
			FakeWebSocket.instances[0]?.emitClose();
			await vi.advanceTimersByTimeAsync(500);
			expect(onDisconnected).toHaveBeenLastCalledWith(RUNTIME_ADMISSION_REQUIRED_MESSAGE);
			expect(fetch).toHaveBeenCalledOnce();
			expect(fetch).toHaveBeenCalledWith(
				"/api/trpc/runtime.getConfig",
				expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
			);
			await vi.advanceTimersByTimeAsync(30_000);
			transport.switchProject("project-b");
			expect(FakeWebSocket.instances).toHaveLength(1);
			transport.dispose();
		},
	);

	it("uses ordinary API admission failures to stop an existing stream immediately", async () => {
		const onDisconnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected,
			onMessage: vi.fn(),
		});
		await observeRuntimeAdmissionResponse(
			new Response(JSON.stringify({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }), { status: 401 }),
		);
		expect(onDisconnected).toHaveBeenLastCalledWith(RUNTIME_ADMISSION_REQUIRED_MESSAGE);
		expect(FakeWebSocket.instances[0]?.close).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetch).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(1);
		transport.dispose();
	});

	it("keeps retrying an offline runtime and ignores a late probe after disposal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
		const onDisconnected = vi.fn();
		const transport = startRuntimeStateStreamTransport("project-a", {
			onConnected: vi.fn(),
			onDisconnected,
			onMessage: vi.fn(),
		});
		FakeWebSocket.instances[0]?.emitClose();
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(onDisconnected).not.toHaveBeenCalledWith(RUNTIME_ADMISSION_REQUIRED_MESSAGE);
		let resolveProbe: (value: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						resolveProbe = resolve;
					}),
			),
		);
		FakeWebSocket.instances[1]?.emitClose();
		await vi.advanceTimersByTimeAsync(1_000);
		transport.dispose();
		resolveProbe(new Response(JSON.stringify({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }), { status: 401 }));
		await Promise.resolve();
		expect(onDisconnected).not.toHaveBeenCalledWith(RUNTIME_ADMISSION_REQUIRED_MESSAGE);
	});
});
