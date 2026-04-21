import type { IRuntimeBroadcaster } from "../../core";
import { getLogLevel, type LogLevel, setLogLevel } from "../../core";
import { applyRuntimeMutationEffects, createLogLevelBroadcastEffects } from "../runtime-mutation-effects";

export interface SetLogLevelDeps {
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastLogLevel">;
}

export async function handleSetLogLevel(level: "debug" | "info" | "warn" | "error", deps: SetLogLevelDeps) {
	setLogLevel(level as LogLevel);
	await applyRuntimeMutationEffects(deps.broadcaster, createLogLevelBroadcastEffects(level as LogLevel));
	return { ok: true, level: getLogLevel() };
}
