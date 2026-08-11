import { WebSocket } from "ws";

import type { RuntimeStateStreamMessage } from "../core";

export interface DisconnectProjectClientsOptions {
	closeClientPayload?: RuntimeStateStreamMessage;
}

export interface CreateRuntimeStateClientRegistryDependencies {
	onProjectClientDisconnected: (projectId: string, clientId: string) => void;
}

interface RuntimeStateProjectClient {
	projectId: string;
	clientId: string;
}

export class RuntimeStateClientRegistry {
	private readonly clientsByProject = new Map<string, Set<WebSocket>>();
	private readonly allClients = new Set<WebSocket>();
	private readonly clientToProject = new Map<WebSocket, RuntimeStateProjectClient>();

	constructor(private readonly deps: CreateRuntimeStateClientRegistryDependencies) {}

	get hasClients(): boolean {
		return this.allClients.size > 0;
	}

	getProjectClients(projectId: string): ReadonlySet<WebSocket> | undefined {
		return this.clientsByProject.get(projectId);
	}

	registerGlobalClient(client: WebSocket): void {
		this.allClients.add(client);
	}

	registerProjectClient(projectId: string, client: WebSocket, clientId: string): void {
		const projectClients = this.clientsByProject.get(projectId) ?? new Set<WebSocket>();
		projectClients.add(client);
		this.clientsByProject.set(projectId, projectClients);
		this.clientToProject.set(client, { projectId, clientId });
	}

	removeClient(client: WebSocket): void {
		const projectClient = this.clientToProject.get(client);
		if (projectClient) {
			this.deps.onProjectClientDisconnected(projectClient.projectId, projectClient.clientId);
			const clients = this.clientsByProject.get(projectClient.projectId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					this.clientsByProject.delete(projectClient.projectId);
				}
			}
		}
		this.clientToProject.delete(client);
		this.allClients.delete(client);
	}

	disconnectProjectClients(projectId: string, options?: DisconnectProjectClientsOptions): void {
		const projectClients = this.clientsByProject.get(projectId);
		if (!projectClients || projectClients.size === 0) {
			this.clientsByProject.delete(projectId);
			return;
		}
		const closeClientPayload = options?.closeClientPayload ? this.serialize(options.closeClientPayload) : null;

		for (const client of Array.from(projectClients)) {
			if (closeClientPayload !== null) {
				this.send(client, closeClientPayload);
			}
			try {
				client.close();
			} catch {
				// Ignore close failures while disposing removed project clients.
			}
			this.removeClient(client);
		}
		this.clientsByProject.delete(projectId);
	}

	broadcastToProject(projectId: string, payload: RuntimeStateStreamMessage): void {
		const clients = this.clientsByProject.get(projectId);
		if (!clients || clients.size === 0) {
			return;
		}
		const message = this.serialize(payload);
		if (message === null) {
			return;
		}
		for (const client of clients) {
			this.send(client, message);
		}
	}

	broadcastToAll(payload: RuntimeStateStreamMessage): void {
		if (this.allClients.size === 0) {
			return;
		}
		const message = this.serialize(payload);
		if (message === null) {
			return;
		}
		for (const client of this.allClients) {
			this.send(client, message);
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
		this.clientsByProject.clear();
		this.clientToProject.clear();
	}

	private serialize(payload: RuntimeStateStreamMessage): string | null {
		try {
			return JSON.stringify(payload);
		} catch {
			return null;
		}
	}

	private send(client: WebSocket, payload: string): void {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(payload);
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	}
}
