import { type DebugLogLevel, getLogLevel, setLogLevel } from "../../core/debug-logger";
import type { IRuntimeBroadcaster } from "../../core/service-interfaces";

export interface SetLogLevelDeps {
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastLogLevel">;
}

export function handleSetLogLevel(level: "debug" | "info" | "warn" | "error", deps: SetLogLevelDeps) {
	setLogLevel(level as DebugLogLevel);
	deps.broadcaster.broadcastLogLevel(level as DebugLogLevel);
	return { ok: true, level: getLogLevel() };
}
