import { WebSocket } from "ws";

import type { RuntimeStateStreamMessage } from "../core";

export interface DisconnectWorkspaceClientsOptions {
	closeClientPayload?: RuntimeStateStreamMessage;
}

export interface CreateRuntimeStateClientRegistryDependencies {
	onWorkspaceClientDisconnected: (workspaceId: string) => void;
}

export class RuntimeStateClientRegistry {
	private readonly clientsByWorkspace = new Map<string, Set<WebSocket>>();
	private readonly allClients = new Set<WebSocket>();
	private readonly clientToWorkspace = new Map<WebSocket, string>();

	constructor(private readonly deps: CreateRuntimeStateClientRegistryDependencies) {}

	get hasClients(): boolean {
		return this.allClients.size > 0;
	}

	getWorkspaceClients(workspaceId: string): ReadonlySet<WebSocket> | undefined {
		return this.clientsByWorkspace.get(workspaceId);
	}

	registerGlobalClient(client: WebSocket): void {
		this.allClients.add(client);
	}

	registerWorkspaceClient(workspaceId: string, client: WebSocket): void {
		const workspaceClients = this.clientsByWorkspace.get(workspaceId) ?? new Set<WebSocket>();
		workspaceClients.add(client);
		this.clientsByWorkspace.set(workspaceId, workspaceClients);
		this.clientToWorkspace.set(client, workspaceId);
	}

	removeClient(client: WebSocket): void {
		const workspaceId = this.clientToWorkspace.get(client);
		if (workspaceId) {
			this.deps.onWorkspaceClientDisconnected(workspaceId);
			const clients = this.clientsByWorkspace.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					this.clientsByWorkspace.delete(workspaceId);
				}
			}
		}
		this.clientToWorkspace.delete(client);
		this.allClients.delete(client);
	}

	disconnectWorkspaceClients(workspaceId: string, options?: DisconnectWorkspaceClientsOptions): void {
		const workspaceClients = this.clientsByWorkspace.get(workspaceId);
		if (!workspaceClients || workspaceClients.size === 0) {
			this.clientsByWorkspace.delete(workspaceId);
			return;
		}

		for (const client of Array.from(workspaceClients)) {
			if (options?.closeClientPayload) {
				this.send(client, options.closeClientPayload);
			}
			try {
				client.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			this.removeClient(client);
		}
		this.clientsByWorkspace.delete(workspaceId);
	}

	broadcastToWorkspace(workspaceId: string, payload: RuntimeStateStreamMessage): void {
		const clients = this.clientsByWorkspace.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		for (const client of clients) {
			this.send(client, payload);
		}
	}

	broadcastToAll(payload: RuntimeStateStreamMessage): void {
		for (const client of this.allClients) {
			this.send(client, payload);
		}
	}

	terminateAllClients(): void {
		for (const client of this.allClients) {
			try {
				client.terminate();
			} catch {
				// Ignore websocket termination errors during shutdown.
			}
		}
		this.allClients.clear();
		this.clientsByWorkspace.clear();
		this.clientToWorkspace.clear();
	}

	private send(client: WebSocket, payload: RuntimeStateStreamMessage): void {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	}
}
