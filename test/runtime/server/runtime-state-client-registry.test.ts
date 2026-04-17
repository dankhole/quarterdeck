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
	it("disconnects workspace clients with an optional final payload and cleanup callback", () => {
		const onWorkspaceClientDisconnected = vi.fn();
		const registry = new RuntimeStateClientRegistry({ onWorkspaceClientDisconnected });
		const clientA = createFakeSocket();
		const clientB = createFakeSocket();

		registry.registerGlobalClient(clientA.socket);
		registry.registerGlobalClient(clientB.socket);
		registry.registerWorkspaceClient("workspace-1", clientA.socket);
		registry.registerWorkspaceClient("workspace-1", clientB.socket);

		registry.disconnectWorkspaceClients("workspace-1", {
			closeClientPayload: { type: "error", message: "workspace removed" },
		});

		expect(clientA.sent).toEqual([JSON.stringify({ type: "error", message: "workspace removed" })]);
		expect(clientB.sent).toEqual([JSON.stringify({ type: "error", message: "workspace removed" })]);
		expect(clientA.socket.close).toHaveBeenCalledOnce();
		expect(clientB.socket.close).toHaveBeenCalledOnce();
		expect(onWorkspaceClientDisconnected).toHaveBeenCalledTimes(2);
		expect(onWorkspaceClientDisconnected).toHaveBeenNthCalledWith(1, "workspace-1");
		expect(onWorkspaceClientDisconnected).toHaveBeenNthCalledWith(2, "workspace-1");
		expect(registry.getWorkspaceClients("workspace-1")).toBeUndefined();
		expect(registry.hasClients).toBe(false);
	});

	it("broadcasts workspace messages only to registered workspace clients", () => {
		const registry = new RuntimeStateClientRegistry({
			onWorkspaceClientDisconnected: vi.fn(),
		});
		const workspaceClient = createFakeSocket();
		const otherClient = createFakeSocket();

		registry.registerGlobalClient(workspaceClient.socket);
		registry.registerGlobalClient(otherClient.socket);
		registry.registerWorkspaceClient("workspace-1", workspaceClient.socket);

		registry.broadcastToWorkspace("workspace-1", { type: "error", message: "workspace only" });
		registry.broadcastToAll({ type: "error", message: "everyone" });

		expect(workspaceClient.sent).toEqual([
			JSON.stringify({ type: "error", message: "workspace only" }),
			JSON.stringify({ type: "error", message: "everyone" }),
		]);
		expect(otherClient.sent).toEqual([JSON.stringify({ type: "error", message: "everyone" })]);
	});
});
