import { buildRuntimeConfigResponse } from "../../config/agent-registry";
import type { RuntimeConfigState } from "../../config/runtime-config";
import type { IRuntimeConfigProvider } from "../../core/service-interfaces";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface LoadConfigDeps {
	config: Pick<IRuntimeConfigProvider, "getActiveRuntimeConfig" | "loadScopedRuntimeConfig">;
}

export async function handleLoadConfig(workspaceScope: RuntimeTrpcWorkspaceScope | null, deps: LoadConfigDeps) {
	const activeRuntimeConfig = deps.config.getActiveRuntimeConfig();
	if (!workspaceScope && !activeRuntimeConfig) {
		throw new Error("No active runtime config provider is available.");
	}
	let scopedRuntimeConfig: RuntimeConfigState;
	if (workspaceScope) {
		scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(workspaceScope);
	} else if (activeRuntimeConfig) {
		scopedRuntimeConfig = activeRuntimeConfig;
	} else {
		throw new Error("No active runtime config provider is available.");
	}
	return buildRuntimeConfigResponse(scopedRuntimeConfig);
}
