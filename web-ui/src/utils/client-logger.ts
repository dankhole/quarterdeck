/**
 * Client-side logger. Console verbosity and diagnostic admission are separate.
 *
 * Every candidate is offered to the unified browser diagnostics recorder. The
 * configured level only controls browser-console output.
 *
 * Usage:
 *   const log = createClientLogger("my-component");
 *   log.debug("Something happened", { extra: "data" });
 */

import { recordBrowserLog } from "@/diagnostics";
import { setIsEmitting } from "@/utils/global-error-capture";

type ClientLogLevel = "debug" | "info" | "warn" | "error";

export interface ClientLogger {
	debug: (message: string, data?: unknown) => void;
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
}

const LOG_LEVEL_SEVERITY: Record<ClientLogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let currentLogLevel: ClientLogLevel = "warn";

/** Synchronizes browser-console verbosity with the runtime setting. */
export function setClientLogLevel(level: ClientLogLevel): void {
	currentLogLevel = level;
}

export function getClientLogLevel(): ClientLogLevel {
	return currentLogLevel;
}

export function createClientLogger(tag: string): ClientLogger {
	return {
		debug: (message, data) => emit("debug", tag, message, data),
		info: (message, data) => emit("info", tag, message, data),
		warn: (message, data) => emit("warn", tag, message, data),
		error: (message, data) => emit("error", tag, message, data),
	};
}

function emit(level: ClientLogLevel, tag: string, message: string, data: unknown): void {
	recordBrowserLog(level, tag, message, data);
	if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[currentLogLevel]) {
		return;
	}

	const prefix = `[${tag}]`;
	// Suppress global-error-capture's console intercept while we call console[level].
	// Without this, our console.error/warn call would be re-captured by the patched
	// console method, producing a duplicate "console"-tagged entry alongside the
	// properly tagged unified diagnostic record above. See global-error-capture.ts
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
}
