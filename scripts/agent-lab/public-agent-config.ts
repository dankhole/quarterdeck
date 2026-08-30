import type { AgentLabLaunchAgentConfig, AgentLabPublicAgentConfig } from "./types";

export function toPublicAgentConfig(agent: AgentLabLaunchAgentConfig): AgentLabPublicAgentConfig {
	switch (agent.mode) {
		case "fake":
		case "fake-claude":
			return agent;
		case "real-claude":
			return {
				mode: agent.mode,
				model: agent.model,
				modelProvider: agent.modelProvider,
				authentication: agent.authentication,
				profileSource: agent.profileSource,
				credentialBoundary: agent.credentialBoundary,
				permissionMode: agent.permissionMode,
				settingsSources: agent.settingsSources,
				managedSettings: agent.managedSettings,
				historyPersistence: agent.historyPersistence,
				externalIntegrations: agent.externalIntegrations,
				profileHooks: agent.profileHooks,
				telemetry: agent.telemetry,
				budgetLimit: agent.budgetLimit,
			};
		case "real-codex":
			return {
				mode: agent.mode,
				model: agent.model,
				modelProvider: agent.modelProvider,
				reasoningEffort: agent.reasoningEffort,
				authentication: agent.authentication,
				profileSource: agent.profileSource,
				sandbox: agent.sandbox,
				approvalPolicy: agent.approvalPolicy,
				serviceTier: agent.serviceTier,
				historyPersistence: agent.historyPersistence,
				webSearch: agent.webSearch,
				externalIntegrations: agent.externalIntegrations,
				profileHooks: agent.profileHooks,
				telemetry: agent.telemetry,
			};
		default: {
			const unsupportedAgent: never = agent;
			throw new Error(`Unsupported Agent Lab provider mode: ${String(unsupportedAgent)}`);
		}
	}
}
