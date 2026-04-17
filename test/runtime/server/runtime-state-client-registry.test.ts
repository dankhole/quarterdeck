import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { RuntimeStateClientRegistry } from "../../../src/server/runtime-state-client-registry";

function createFakeSocket() {
	const sent: string[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
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
		registry.registerProjectClient("project-1", clientA.socket);
		registry.registerProjectClient("project-1", clientB.socket);

		registry.disconnectProjectClients("project-1", {
			closeClientPayload: { type: "error", message: "project removed" },
		});

		expect(clientA.sent).toEqual([JSON.stringify({ type: "error", message: "project removed" })]);
		expect(clientB.sent).toEqual([JSON.stringify({ type: "error", message: "project removed" })]);
		expect(clientA.socket.close).toHaveBeenCalledOnce();
		expect(clientB.socket.close).toHaveBeenCalledOnce();
		expect(onProjectClientDisconnected).toHaveBeenCalledTimes(2);
		expect(onProjectClientDisconnected).toHaveBeenNthCalledWith(1, "project-1");
		expect(onProjectClientDisconnected).toHaveBeenNthCalledWith(2, "project-1");
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
		registry.registerProjectClient("project-1", projectClient.socket);

		registry.broadcastToProject("project-1", { type: "error", message: "project only" });
		registry.broadcastToAll({ type: "error", message: "everyone" });

		expect(projectClient.sent).toEqual([
			JSON.stringify({ type: "error", message: "project only" }),
			JSON.stringify({ type: "error", message: "everyone" }),
		]);
		expect(otherClient.sent).toEqual([JSON.stringify({ type: "error", message: "everyone" })]);
	});
});
