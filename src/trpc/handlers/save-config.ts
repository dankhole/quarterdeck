import { TRPCError } from "@trpc/server";
import { buildRuntimeConfigResponse } from "../../config/agent-registry";
import type { RuntimeConfigState } from "../../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../../config/runtime-config";
import { parseRuntimeConfigSaveRequest } from "../../core/api-validation";
import { type DebugLogLevel, setLogLevel } from "../../core/debug-logger";
import { setEventLogEnabled } from "../../core/event-log";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core/service-interfaces";
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
	setLogLevel(nextRuntimeConfig.logLevel as DebugLogLevel);
	deps.broadcaster.broadcastLogLevel(nextRuntimeConfig.logLevel as DebugLogLevel);
	return buildRuntimeConfigResponse(nextRuntimeConfig);
}
