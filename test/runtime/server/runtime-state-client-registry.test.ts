import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { RuntimeStateClientRegistry } from "../../../src/server/runtime-state-client-registry";

function createFakeSocket(bufferedAmount = 0) {
	const sent: string[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		bufferedAmount,
		send: vi.fn((payload: string) => {
			sent.push(payload);
		}),
		close: vi.fn(),
		terminate: vi.fn(),
	} as unknown as WebSocket;

	return { socket, sent };
}

describe("RuntimeStateClientRegistry", () => {
	it("disconnects project clients with an optional final payload and cleanup callback", () => {
		const onProjectClientDisconnected = vi.fn();
		const registry = new RuntimeStateClientRegistry({ onProjectClientDisconnected });
		const clientA = createFakeSocket();
		const clientB = createFakeSocket();

		registry.registerGlobalClient(clientA.socket);
		registry.registerGlobalClient(clientB.socket);
		registry.registerProjectClient("project-1", clientA.socket, "client-a");
		registry.registerProjectClient("project-1", clientB.socket, "client-b");

		registry.disconnectProjectClients("project-1", {
			closeClientPayload: { type: "error", message: "project removed" },
		});

		expect(clientA.sent).toEqual([JSON.stringify({ type: "error", message: "project removed" })]);
		expect(clientB.sent).toEqual([JSON.stringify({ type: "error", message: "project removed" })]);
		expect(clientA.socket.close).toHaveBeenCalledOnce();
		expect(clientB.socket.close).toHaveBeenCalledOnce();
		expect(onProjectClientDisconnected).toHaveBeenCalledTimes(2);
		expect(onProjectClientDisconnected).toHaveBeenNthCalledWith(1, "project-1", "client-a");
		expect(onProjectClientDisconnected).toHaveBeenNthCalledWith(2, "project-1", "client-b");
		expect(registry.getProjectClients("project-1")).toBeUndefined();
		expect(registry.hasClients).toBe(false);
	});

	it("broadcasts project messages only to registered project clients", () => {
		const registry = new RuntimeStateClientRegistry({
			onProjectClientDisconnected: vi.fn(),
		});
		const projectClient = createFakeSocket();
		const otherClient = createFakeSocket();

		registry.registerGlobalClient(projectClient.socket);
		registry.registerGlobalClient(otherClient.socket);
		registry.registerProjectClient("project-1", projectClient.socket, "client-a");

		registry.broadcastToProject("project-1", { type: "error", message: "project only" });
		registry.broadcastToAll({ type: "error", message: "everyone" });

		expect(projectClient.sent).toEqual([
			JSON.stringify({ type: "error", message: "project only" }),
			JSON.stringify({ type: "error", message: "everyone" }),
		]);
		expect(otherClient.sent).toEqual([JSON.stringify({ type: "error", message: "everyone" })]);
	});

	it("serializes a broadcast payload once for all connected clients", () => {
		const registry = new RuntimeStateClientRegistry({
			onProjectClientDisconnected: vi.fn(),
		});
		const clientA = createFakeSocket();
		const clientB = createFakeSocket();
		registry.registerGlobalClient(clientA.socket);
		registry.registerGlobalClient(clientB.socket);
		const stringify = vi.spyOn(JSON, "stringify");

		registry.broadcastToAll({ type: "error", message: "everyone" });

		expect(stringify).toHaveBeenCalledOnce();
		expect(clientA.sent).toEqual(['{"type":"error","message":"everyone"}']);
		expect(clientB.sent).toEqual(['{"type":"error","message":"everyone"}']);
		stringify.mockRestore();
	});

	it("drops only best-effort diagnostic batches when a socket is backpressured", () => {
		const registry = new RuntimeStateClientRegistry({ onProjectClientDisconnected: vi.fn() });
		const client = createFakeSocket(600 * 1024);
		const healthyClient = createFakeSocket();
		registry.registerGlobalClient(client.socket);
		registry.registerGlobalClient(healthyClient.socket);
		registry.registerProjectClient("project-1", client.socket, "client-1");
		registry.registerProjectClient("project-2", healthyClient.socket, "client-2");

		expect(registry.sendDiagnosticToClient(client.socket, { type: "diagnostic_record_batch", records: [] })).toBe(
			false,
		);
		registry.sendToClient(client.socket, { type: "error", message: "primary state remains deliverable" });

		expect(client.sent).toEqual([JSON.stringify({ type: "error", message: "primary state remains deliverable" })]);
		expect(registry.getDiagnosticSnapshot().diagnosticBackpressureDrops).toBe(1);
		expect(registry.getDiagnosticSnapshot({ projectId: "project-1", taskId: "task-1" })).toMatchObject({
			globalClientCount: 1,
			projectClientCount: 1,
			diagnosticBackpressureDrops: 1,
		});
		expect(registry.getDiagnosticSnapshot({ projectId: "project-2" }).diagnosticBackpressureDrops).toBe(0);
		expect(registry.getDiagnosticSnapshot({ taskId: "task-1" })).toMatchObject({
			globalClientCount: 0,
			projectClientCount: 0,
			diagnosticBackpressureDrops: 0,
		});
	});
});
