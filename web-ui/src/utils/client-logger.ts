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
import { setIsEmitting } from "@/utils/global-error-capture";

type DebugLogLevel = RuntimeDebugLogEntry["level"];

export interface ClientLogger {
	debug: (message: string, data?: unknown) => void;
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
}

type ClientLogEntryCallback = (level: DebugLogLevel, tag: string, message: string, data?: unknown) => void;

const LOG_LEVEL_SEVERITY: Record<DebugLogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let addEntryCallback: ClientLogEntryCallback | null = null;
let enabled = false;
let currentLogLevel: DebugLogLevel = "warn";

/** Called by useDebugLogging to wire the client logger to the panel. */
export function registerClientLogCallback(callback: ClientLogEntryCallback | null): void {
	addEntryCallback = callback;
}

/** Called by useDebugLogging when debug logging state changes. */
export function setClientLoggingEnabled(isEnabled: boolean): void {
	enabled = isEnabled;
}

/** Called by useDebugLogging when the user changes the log level. */
export function setClientLogLevel(level: DebugLogLevel): void {
	currentLogLevel = level;
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
	if (!enabled || LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[currentLogLevel]) {
		return;
	}

	const prefix = `[${tag}]`;
	// Suppress global-error-capture's console intercept while we call console[level].
	// Without this, our console.error/warn call would be re-captured by the patched
	// console method, producing a duplicate "console"-tagged entry alongside the
	// properly tagged entry from addEntryCallback below. See global-error-capture.ts
	// header comment for the full coupling explanation.
	setIsEmitting(true);
	try {
		if (data !== undefined) {
			console[level](prefix, message, data);
		} else {
			console[level](prefix, message);
		}
	} finally {
		setIsEmitting(false);
	}

	addEntryCallback?.(level, tag, message, data);
}
