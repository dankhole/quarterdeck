import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import type { RuntimeTaskSessionSummary, RuntimeTerminalWsServerMessage } from "../../../src/core";
import type { TerminalRestoreSnapshot, TerminalSessionListener, TerminalSessionService } from "../../../src/terminal";
import { createTerminalWebSocketBridge, type TerminalWebSocketBridge } from "../../../src/terminal";

const TASK_ID = "task-1";
const PROJECT_ID = "project-1";

function createSummary(taskId = TASK_ID): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		projectPath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

function rawDataToBuffer(data: RawData): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data.map((part) => rawDataToBuffer(part)));
	}
	return Buffer.from(data);
}

class FakeTerminalManager implements TerminalSessionService {
	private readonly listenersByTaskId = new Map<string, Set<TerminalSessionListener>>();
	readonly eventLog: string[] = [];

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const listeners = this.listenersByTaskId.get(taskId) ?? new Set<TerminalSessionListener>();
		this.listenersByTaskId.set(taskId, listeners);
		listeners.add(listener);
		listener.onState?.(createSummary(taskId));
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.listenersByTaskId.delete(taskId);
			}
		};
	}

	getRestoreSnapshot = vi.fn(async (): Promise<TerminalRestoreSnapshot> => {
		this.eventLog.push("snapshot");
		return {
			snapshot: "",
			cols: 80,
			rows: 24,
		};
	});
	recoverStaleSession = vi.fn((taskId: string) => {
		this.eventLog.push(`recover:${taskId}`);
		return createSummary(taskId);
	});
	writeInput = vi.fn(() => createSummary());
	resize = vi.fn((taskId: string, cols: number, rows: number) => {
		this.eventLog.push(`resize:${taskId}:${cols}x${rows}`);
		return true;
	});
	pauseOutput = vi.fn(() => true);
	resumeOutput = vi.fn(() => true);
	stopTaskSession = vi.fn(() => createSummary());

	emitOutput(taskId: string, data: string): void {
		for (const listener of this.listenersByTaskId.get(taskId) ?? []) {
			listener.onOutput?.(Buffer.from(data, "utf8"));
		}
	}

	getOutputListenerCount(taskId: string): number {
		return [...(this.listenersByTaskId.get(taskId) ?? [])].filter((listener) => listener.onOutput).length;
	}
}

interface QueuedWebSocket {
	socket: WebSocket;
	queue: RawData[];
	events: EventEmitter;
}

async function openQueuedWebSocket(url: string): Promise<QueuedWebSocket> {
	const socket = new WebSocket(url);
	const queue: RawData[] = [];
	const events = new EventEmitter();
	socket.on("message", (message) => {
		queue.push(message);
		events.emit("message");
	});
	await new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(() => reject(new Error(`Timed out connecting websocket: ${url}`)), 2_000);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			reject(error);
		});
	});
	return { socket, queue, events };
}

async function waitForControlMessage(
	queuedSocket: QueuedWebSocket,
	predicate: (message: RuntimeTerminalWsServerMessage) => boolean,
	timeoutMs = 2_000,
): Promise<RuntimeTerminalWsServerMessage> {
	return await new Promise((resolve, reject) => {
		const tryResolve = () => {
			const index = queuedSocket.queue.findIndex((rawData) => {
				const message = JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage;
				return predicate(message);
			});
			if (index < 0) {
				return;
			}
			const [rawData] = queuedSocket.queue.splice(index, 1);
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			resolve(JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage);
		};
		const timeoutId = setTimeout(() => {
			queuedSocket.events.removeListener("message", tryResolve);
			reject(new Error("Timed out waiting for terminal control message."));
		}, timeoutMs);
		queuedSocket.events.on("message", tryResolve);
		tryResolve();
		queuedSocket.socket.once("error", (error) => {
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			reject(error);
		});
	});
}

async function waitForIoMessage(queuedSocket: QueuedWebSocket, timeoutMs = 2_000): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const tryResolve = () => {
			const rawData = queuedSocket.queue.shift();
			if (!rawData) {
				return;
			}
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			resolve(rawDataToBuffer(rawData));
		};
		const timeoutId = setTimeout(() => {
			queuedSocket.events.removeListener("message", tryResolve);
			reject(new Error("Timed out waiting for terminal output."));
		}, timeoutMs);
		queuedSocket.events.on("message", tryResolve);
		tryResolve();
		queuedSocket.socket.once("error", (error) => {
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			reject(error);
		});
	});
}

async function expectNoQueuedMessage(queuedSocket: QueuedWebSocket, timeoutMs = 125): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onMessage = () => {
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", onMessage);
			reject(new Error("Expected websocket to stay quiet."));
		};
		const timeoutId = setTimeout(() => {
			queuedSocket.events.removeListener("message", onMessage);
			resolve();
		}, timeoutMs);
		queuedSocket.events.on("message", onMessage);
	});
}

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
		return;
	}
	socket.close();
	await once(socket, "close");
}

async function waitForAssertion(assertion: () => void, timeoutMs = 250): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (lastError) {
		throw lastError;
	}
	assertion();
}

describe("createTerminalWebSocketBridge", () => {
	let server: Server;
	let bridge: TerminalWebSocketBridge;
	let terminalManager: FakeTerminalManager;
	let runtimeUrl: string;

	beforeEach(async () => {
		terminalManager = new FakeTerminalManager();
		server = createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		bridge = createTerminalWebSocketBridge({
			server,
			resolveTerminalManager: (projectId) => (projectId === PROJECT_ID ? terminalManager : null),
			isTerminalIoWebSocketPath: (pathname) => pathname === "/api/terminal/io",
			isTerminalControlWebSocketPath: (pathname) => pathname === "/api/terminal/control",
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as AddressInfo | null;
		if (!address) {
			throw new Error("Expected websocket server address.");
		}
		runtimeUrl = `ws://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await bridge.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	});

	it("broadcasts one PTY session to multiple viewers", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));

		terminalManager.emitOutput(TASK_ID, "hello");

		await expect(waitForIoMessage(ioSocketA)).resolves.toEqual(Buffer.from("hello", "utf8"));
		await expect(waitForIoMessage(ioSocketB)).resolves.toEqual(Buffer.from("hello", "utf8"));

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);

		terminalManager.emitOutput(TASK_ID, "world");

		await expect(waitForIoMessage(ioSocketB)).resolves.toEqual(Buffer.from("world", "utf8"));

		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
	});

	it("requests the initial restore snapshot after the first resize when one arrives promptly", async () => {
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlSocket = await openQueuedWebSocket(controlUrl);

		controlSocket.socket.send(
			JSON.stringify({
				type: "resize",
				cols: 132,
				rows: 41,
				pixelWidth: 1320,
				pixelHeight: 820,
				force: true,
			}),
		);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");

		expect(terminalManager.resize).toHaveBeenCalledWith(TASK_ID, 132, 41, 1320, 820, true);
		expect(terminalManager.getRestoreSnapshot).toHaveBeenCalledTimes(1);
		expect(terminalManager.eventLog).toContain(`recover:${TASK_ID}`);
		expect(terminalManager.eventLog.indexOf(`resize:${TASK_ID}:132x41`)).toBeLessThan(
			terminalManager.eventLog.indexOf("snapshot"),
		);

		await closeSocket(controlSocket.socket);
	});

	it("still sends the initial restore snapshot after the timeout when no resize arrives", async () => {
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");

		expect(terminalManager.resize).not.toHaveBeenCalled();
		expect(terminalManager.getRestoreSnapshot).toHaveBeenCalledTimes(1);

		await closeSocket(controlSocket.socket);
	});

	it("buffers live output during restore and flushes it after restore_complete", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		terminalManager.emitOutput(TASK_ID, "buffered-before-restore");

		await expectNoQueuedMessage(ioSocket);

		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));
		await expect(waitForIoMessage(ioSocket)).resolves.toEqual(Buffer.from("buffered-before-restore", "utf8"));

		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("does not accumulate restore-gap output while a viewer has no io socket", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		await closeSocket(ioSocket.socket);
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminalManager.emitOutput(TASK_ID, "lost-during-gap");

		const replacementIoSocket = await openQueuedWebSocket(ioUrl);
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		await expectNoQueuedMessage(replacementIoSocket);

		await closeSocket(replacementIoSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("replaces io sockets for the same clientId without evicting the viewer", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const firstIoSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);
		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		const firstClose = once(firstIoSocket.socket, "close");
		const replacementIoSocket = await openQueuedWebSocket(ioUrl);
		await firstClose;

		terminalManager.emitOutput(TASK_ID, "from-replacement");

		await expect(waitForIoMessage(replacementIoSocket)).resolves.toEqual(Buffer.from("from-replacement", "utf8"));
		expect(terminalManager.getOutputListenerCount(TASK_ID)).toBe(1);

		await closeSocket(replacementIoSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("replaces control sockets for the same clientId and keeps restore ownership on the newer socket", async () => {
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const firstControlSocket = await openQueuedWebSocket(controlUrl);

		const firstClose = once(firstControlSocket.socket, "close");
		const replacementControlSocket = await openQueuedWebSocket(controlUrl);
		await firstClose;

		await waitForControlMessage(replacementControlSocket, (message) => message.type === "restore");
		await expectNoQueuedMessage(replacementControlSocket);
		expect(terminalManager.getRestoreSnapshot).toHaveBeenCalledTimes(1);

		await closeSocket(replacementControlSocket.socket);
	});

	it("keeps the PTY paused until every backpressured viewer drains", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));

		const output = "x".repeat(120_000);
		terminalManager.emitOutput(TASK_ID, output);

		const outputA = await waitForIoMessage(ioSocketA);
		const outputB = await waitForIoMessage(ioSocketB);
		expect(outputA.byteLength).toBe(Buffer.byteLength(output));
		expect(outputB.byteLength).toBe(Buffer.byteLength(output));
		expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);

		controlSocketA.socket.send(JSON.stringify({ type: "output_ack", bytes: outputA.byteLength }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

		controlSocketB.socket.send(JSON.stringify({ type: "output_ack", bytes: outputB.byteLength }));
		await waitForAssertion(() => {
			expect(terminalManager.resumeOutput).toHaveBeenCalledTimes(1);
		});

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);
		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
	});

	it("resumes the PTY when the last backpressured viewer disconnects before acknowledging", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));

		const output = "x".repeat(120_000);
		terminalManager.emitOutput(TASK_ID, output);

		const outputA = await waitForIoMessage(ioSocketA);
		await waitForIoMessage(ioSocketB);
		expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);

		controlSocketA.socket.send(JSON.stringify({ type: "output_ack", bytes: outputA.byteLength }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
		await waitForAssertion(() => {
			expect(terminalManager.resumeOutput).toHaveBeenCalledTimes(1);
		});

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);
	});

	it("returns an error for invalid control payloads without destabilizing sibling viewers", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&projectId=${PROJECT_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send("not-json");
		const errorMessage = await waitForControlMessage(
			controlSocketA,
			(message) => message.type === "error" && message.message === "Invalid terminal control payload.",
		);
		expect(errorMessage.type).toBe("error");

		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));
		terminalManager.emitOutput(TASK_ID, "still-broadcasting");

		await expect(waitForIoMessage(ioSocketA)).resolves.toEqual(Buffer.from("still-broadcasting", "utf8"));
		await expect(waitForIoMessage(ioSocketB)).resolves.toEqual(Buffer.from("still-broadcasting", "utf8"));

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);
		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
	});
});
