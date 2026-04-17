import type { RuntimeConfigState } from "../../config";
import { buildRuntimeConfigResponse } from "../../config";
import type { IRuntimeConfigProvider } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface LoadConfigDeps {
	config: Pick<IRuntimeConfigProvider, "getActiveRuntimeConfig" | "loadScopedRuntimeConfig">;
}

export async function handleLoadConfig(projectScope: RuntimeTrpcProjectScope | null, deps: LoadConfigDeps) {
	const activeRuntimeConfig = deps.config.getActiveRuntimeConfig();
	if (!projectScope && !activeRuntimeConfig) {
		throw new Error("No active runtime config provider is available.");
	}
	let scopedRuntimeConfig: RuntimeConfigState;
	if (projectScope) {
		scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(projectScope);
	} else if (activeRuntimeConfig) {
		scopedRuntimeConfig = activeRuntimeConfig;
	} else {
		throw new Error("No active runtime config provider is available.");
	}
	return buildRuntimeConfigResponse(scopedRuntimeConfig);
}
