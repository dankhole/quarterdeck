import type { RuntimeAgentId } from "./api-contract.js";

// The home sidebar agent panel is not backed by a real task card.
// We mint a synthetic home agent session id so the existing task-scoped
// runtime APIs can manage its chat and terminal lifecycle without creating
// a worktree-backed task.
export const HOME_AGENT_SESSION_PREFIX = "__home_agent__:";

function hashHomeAgentDescriptor(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(36);
}

export function buildHomeAgentSessionId(workspaceId: string, agentId: RuntimeAgentId, descriptor: string): string {
	return `${HOME_AGENT_SESSION_PREFIX}${workspaceId}:${agentId}:${hashHomeAgentDescriptor(descriptor)}`;
}

export function isHomeAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(HOME_AGENT_SESSION_PREFIX);
}

export function isHomeAgentSessionIdForWorkspace(sessionId: string, workspaceId: string): boolean {
	return sessionId.startsWith(`${HOME_AGENT_SESSION_PREFIX}${workspaceId}:`);
}
