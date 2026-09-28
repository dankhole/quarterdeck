import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../../config";
import {
	buildRuntimeConfigResponse,
	toGlobalRuntimeConfigState,
	updateGlobalRuntimeConfig,
	updateRuntimeConfig,
} from "../../config";
import { GLOBAL_CONFIG_FIELDS } from "../../config/global-config-fields";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider, RuntimeCapabilities } from "../../core";
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
	runtimeCapabilities: RuntimeCapabilities;
	onCodeNavigationConfigChanged: () => Promise<void>;
}

export async function handleSaveConfig(
	projectScope: RuntimeTrpcProjectScope | null,
	input: unknown,
	deps: SaveConfigDeps,
) {
	const parsed = parseRuntimeConfigSaveRequest(input);
	let codeNavigationChanged = false;
	const onUpdated = (previous: RuntimeConfigState, next: RuntimeConfigState) => {
		codeNavigationChanged =
			previous.codeNavigationEnabled !== next.codeNavigationEnabled ||
			!GLOBAL_CONFIG_FIELDS.lspServers.equals(previous.lspServers, next.lspServers);
	};
	let nextRuntimeConfig: RuntimeConfigState;
	if (projectScope) {
		nextRuntimeConfig = await updateRuntimeConfig(projectScope.projectId, parsed, onUpdated);
	} else {
		const activeRuntimeConfig = deps.config.getActiveRuntimeConfig();
		if (!activeRuntimeConfig) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No active runtime config is available.",
			});
		}
		nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed, onUpdated);
	}
	if (projectScope && projectScope.projectId === deps.getActiveProjectId()) {
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	if (!projectScope) {
		// A project save or selection change may have completed while the global
		// save waited for its lock. Keep the config owner's current project fields.
		const active = deps.config.getActiveRuntimeConfig();
		nextRuntimeConfig = deps.getActiveProjectId()
			? {
					...nextRuntimeConfig,
					projectConfigPath: active.projectConfigPath,
					shortcuts: active.shortcuts,
					pinnedBranches: active.pinnedBranches,
					defaultBaseRef: active.defaultBaseRef,
					worktreeSetupScript: active.worktreeSetupScript,
				}
			: toGlobalRuntimeConfigState(nextRuntimeConfig);
		deps.config.setActiveRuntimeConfig(nextRuntimeConfig);
	}
	// The config is committed. Retire old sessions before fallible presentation
	// work; an unchanged retry cannot recover a skipped reset.
	if (codeNavigationChanged) await deps.onCodeNavigationConfigChanged();
	const effects: RuntimeMutationEffect[] = [];
	setLogLevel(nextRuntimeConfig.logLevel as LogLevel);
	effects.push(...createLogLevelBroadcastEffects(nextRuntimeConfig.logLevel as LogLevel));
	await applyRuntimeMutationEffects(deps.broadcaster, effects);
	return await buildRuntimeConfigResponse(nextRuntimeConfig, deps.runtimeCapabilities);
}
