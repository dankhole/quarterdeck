import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../../config";
import { buildRuntimeConfigResponse, updateGlobalRuntimeConfig, updateRuntimeConfig } from "../../config";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core";
import { type LogLevel, parseRuntimeConfigSaveRequest, setEventLogEnabled, setLogLevel } from "../../core";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface SaveConfigDeps {
	config: IRuntimeConfigProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "setPollIntervals" | "broadcastLogLevel">;
	getActiveWorkspaceId: () => string | null;
}

export async function handleSaveConfig(
	workspaceScope: RuntimeTrpcWorkspaceScope | null,
	input: unknown,
	deps: SaveConfigDeps,
) {
	const parsed = parseRuntimeConfigSaveRequest(input);
	let nextRuntimeConfig: RuntimeConfigState;
	if (workspaceScope) {
		nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, workspaceScope.workspaceId, parsed);
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
	if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	if (!workspaceScope) {
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	if (workspaceScope) {
		deps.broadcaster.setPollIntervals(workspaceScope.workspaceId, {
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
