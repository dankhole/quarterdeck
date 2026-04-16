import { getLogLevel, type LogLevel, setLogLevel } from "../../core/runtime-logger";
import type { IRuntimeBroadcaster } from "../../core/service-interfaces";

export interface SetLogLevelDeps {
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastLogLevel">;
}

export function handleSetLogLevel(level: "debug" | "info" | "warn" | "error", deps: SetLogLevelDeps) {
	setLogLevel(level as LogLevel);
	deps.broadcaster.broadcastLogLevel(level as LogLevel);
	return { ok: true, level: getLogLevel() };
}
