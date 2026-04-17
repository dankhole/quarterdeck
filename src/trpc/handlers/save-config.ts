import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../../config";
import { buildRuntimeConfigResponse, updateGlobalRuntimeConfig, updateRuntimeConfig } from "../../config";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core";
import { type LogLevel, parseRuntimeConfigSaveRequest, setEventLogEnabled, setLogLevel } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface SaveConfigDeps {
	config: IRuntimeConfigProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "setPollIntervals" | "broadcastLogLevel">;
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
		nextRuntimeConfig = await updateRuntimeConfig(projectScope.projectPath, projectScope.projectId, parsed);
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
	if (projectScope) {
		deps.broadcaster.setPollIntervals(projectScope.projectId, {
			focusedTaskPollMs: nextRuntimeConfig.focusedTaskPollMs,
			backgroundTaskPollMs: nextRuntimeConfig.backgroundTaskPollMs,
			homeRepoPollMs: nextRuntimeConfig.homeRepoPollMs,
		});
	}
	setEventLogEnabled(nextRuntimeConfig.eventLogEnabled);
	setLogLevel(nextRuntimeConfig.logLevel as LogLevel);
	deps.broadcaster.broadcastLogLevel(nextRuntimeConfig.logLevel as LogLevel);
	return buildRuntimeConfigResponse(nextRuntimeConfig);
}
