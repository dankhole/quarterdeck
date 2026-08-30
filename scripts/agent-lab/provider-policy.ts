import { getRuntimeLaunchSupportedAgentCatalog, type RuntimeAgentId } from "../../src/core";
import type { AgentLabLaunchAgentConfig } from "./types";

export interface AgentLabProviderPolicy {
	enabledAgentIds: readonly RuntimeAgentId[];
	blockedAgentIds: readonly RuntimeAgentId[];
}

function resolveEnabledAgentIds(agent: AgentLabLaunchAgentConfig): readonly RuntimeAgentId[] {
	switch (agent.mode) {
		case "fake":
			return ["codex", "pi"];
		case "fake-claude":
			return ["claude"];
		case "real-codex":
			return ["codex"];
		case "real-claude":
			return ["claude"];
		default: {
			const unsupportedAgent: never = agent;
			throw new Error(`Unsupported Agent Lab provider mode: ${String(unsupportedAgent)}`);
		}
	}
}

export function resolveAgentLabProviderPolicy(agent: AgentLabLaunchAgentConfig): AgentLabProviderPolicy {
	const enabledAgentIds = resolveEnabledAgentIds(agent);
	const enabledAgentIdSet = new Set(enabledAgentIds);
	return {
		enabledAgentIds,
		blockedAgentIds: getRuntimeLaunchSupportedAgentCatalog()
			.map((entry) => entry.id)
			.filter((agentId) => !enabledAgentIdSet.has(agentId)),
	};
}
