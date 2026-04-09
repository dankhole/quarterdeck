/**
 * Client-side debug logger. Mirrors the server-side API from src/core/debug-logger.ts.
 *
 * Writes to browser console AND notifies a registered callback so entries can
 * appear in the debug log panel alongside server-side entries.
 *
 * Usage:
 *   const log = createClientLogger("my-component");
 *   log.debug("Something happened", { extra: "data" });
 */

import type { RuntimeDebugLogEntry } from "@/runtime/types";

type DebugLogLevel = RuntimeDebugLogEntry["level"];

export interface ClientLogger {
	debug: (message: string, data?: unknown) => void;
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
}

type ClientLogEntryCallback = (level: DebugLogLevel, tag: string, message: string, data?: unknown) => void;

let addEntryCallback: ClientLogEntryCallback | null = null;
let enabled = false;

/** Called by useDebugLogging to wire the client logger to the panel. */
export function registerClientLogCallback(callback: ClientLogEntryCallback | null): void {
	addEntryCallback = callback;
}

/** Called by useDebugLogging when debug logging state changes. */
export function setClientLoggingEnabled(isEnabled: boolean): void {
	enabled = isEnabled;
}

export function createClientLogger(tag: string): ClientLogger {
	return {
		debug: (message, data) => emit("debug", tag, message, data),
		info: (message, data) => emit("info", tag, message, data),
		warn: (message, data) => emit("warn", tag, message, data),
		error: (message, data) => emit("error", tag, message, data),
	};
}

function emit(level: DebugLogLevel, tag: string, message: string, data: unknown): void {
	if (!enabled) {
		return;
	}

	const prefix = `[${tag}]`;
	if (data !== undefined) {
		console[level](prefix, message, data);
	} else {
		console[level](prefix, message);
	}

	addEntryCallback?.(level, tag, message, data);
}
