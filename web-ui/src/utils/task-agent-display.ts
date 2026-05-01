import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";

export interface TaskAgentDisplayOption {
	id: RuntimeAgentId;
	label: string;
	binary?: string;
	command?: string;
	status?: RuntimeAgentDefinition["status"];
	statusMessage?: string | null;
	installed?: boolean | null;
}

export const TASK_AGENT_ORDER: readonly RuntimeAgentId[] = ["claude", "codex", "pi"];

const TASK_AGENT_ORDER_INDEX = new Map(TASK_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));

export function sortTaskAgentOptions<T extends { id: RuntimeAgentId }>(agents: readonly T[]): T[] {
	return [...agents].sort((left, right) => {
		const leftOrderIndex = TASK_AGENT_ORDER_INDEX.get(left.id) ?? Number.MAX_SAFE_INTEGER;
		const rightOrderIndex = TASK_AGENT_ORDER_INDEX.get(right.id) ?? Number.MAX_SAFE_INTEGER;
		return leftOrderIndex - rightOrderIndex;
	});
}

export function getTaskAgentDisplayLabel(agentId: RuntimeAgentId, options?: readonly TaskAgentDisplayOption[]): string {
	return (
		options?.find((agent) => agent.id === agentId)?.label ?? getRuntimeAgentCatalogEntry(agentId)?.label ?? agentId
	);
}

export function getTaskAgentShortLabel(agentId: RuntimeAgentId): string {
	if (agentId === "claude") {
		return "Claude";
	}
	if (agentId === "codex") {
		return "Codex";
	}
	if (agentId === "pi") {
		return "Pi";
	}
	return agentId;
}

export function normalizeTaskAgentId(value: string): RuntimeAgentId | null {
	return TASK_AGENT_ORDER.includes(value as RuntimeAgentId) ? (value as RuntimeAgentId) : null;
}

export function resolveTaskCreateAgentId({
	rememberedAgentId,
	fallbackAgentId,
	availableAgentIds,
}: {
	rememberedAgentId: RuntimeAgentId | null;
	fallbackAgentId: RuntimeAgentId;
	availableAgentIds?: readonly RuntimeAgentId[] | null;
}): RuntimeAgentId {
	if (!rememberedAgentId) {
		return fallbackAgentId;
	}
	if (availableAgentIds && !availableAgentIds.includes(rememberedAgentId)) {
		return fallbackAgentId;
	}
	return rememberedAgentId;
}

export function resolveTaskAgentFallbackId(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents"> | null | undefined,
): RuntimeAgentId {
	const selectedAgentId = config?.selectedAgentId ?? "claude";
	const selectedAgent = config?.agents.find((agent) => agent.id === selectedAgentId) ?? null;
	if (selectedAgent?.installed) {
		return selectedAgent.id;
	}
	const firstInstalledAgent = sortTaskAgentOptions(config?.agents ?? []).find((agent) => agent.installed);
	return firstInstalledAgent?.id ?? selectedAgentId;
}
