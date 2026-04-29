import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../../config";
import { buildRuntimeConfigResponse, updateGlobalRuntimeConfig, updateRuntimeConfig } from "../../config";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core";
import { type LogLevel, parseRuntimeConfigSaveRequest, setLogLevel } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";
import {
	applyRuntimeMutationEffects,
	createLogLevelBroadcastEffects,
	type RuntimeMutationEffect,
} from "../runtime-mutation-effects";

export interface SaveConfigDeps {
	config: IRuntimeConfigProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastLogLevel">;
	getActiveProjectId: () => string | null;
}

export async function handleSaveConfig(
	projectScope: RuntimeTrpcProjectScope | null,
	input: unknown,
	deps: SaveConfigDeps,
) {
	const parsed = parseRuntimeConfigSaveRequest(input);
	let nextRuntimeConfig: RuntimeConfigState;
	if (projectScope) {
		nextRuntimeConfig = await updateRuntimeConfig(projectScope.projectId, parsed);
	} else {
		const activeRuntimeConfig = deps.config.getActiveRuntimeConfig();
		if (!activeRuntimeConfig) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No active runtime config is available.",
			});
		}
		nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
	}
	if (projectScope && projectScope.projectId === deps.getActiveProjectId()) {
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	if (!projectScope) {
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	const effects: RuntimeMutationEffect[] = [];
	setLogLevel(nextRuntimeConfig.logLevel as LogLevel);
	effects.push(...createLogLevelBroadcastEffects(nextRuntimeConfig.logLevel as LogLevel));
	await applyRuntimeMutationEffects(deps.broadcaster, effects);
	return await buildRuntimeConfigResponse(nextRuntimeConfig);
}
