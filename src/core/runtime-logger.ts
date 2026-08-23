/**
 * Runtime logging system.
 *
 * Provides tagged loggers that write to console and offer every candidate to
 * the unified diagnostic recorder. Console verbosity and flight-recorder
 * admission are intentionally separate policies.
 *
 * The threshold defaults to "warn" — only warn and error are emitted.
 * Setting the level to "info" adds informational messages (e.g. orphan cleanup),
 * and "debug" enables full verbose output.
 *
 * Usage:
 *   import { createTaggedLogger } from "../core/runtime-logger";
 *   const log = createTaggedLogger("my-tag");
 *   log.debug("Something happened", { extra: "data" });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface TaggedLogger {
	debug: (message: string, data?: unknown) => void;
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
}

export interface RuntimeDiagnosticLogSink {
	recordLog: (candidate: { level: LogLevel; tag: string; message: string; data?: unknown }) => unknown;
}

// ── Module state ──────────────────────────────────────────────────────────

let currentLogLevel: LogLevel = "warn";
let diagnosticSink: RuntimeDiagnosticLogSink | null = null;

// ── Public API ────────────────────────────────────────────────────────────

export function setLogLevel(level: LogLevel): void {
	currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

export function setRuntimeDiagnosticLogSink(sink: RuntimeDiagnosticLogSink | null): void {
	diagnosticSink = sink;
}

export function createTaggedLogger(tag: string): TaggedLogger {
	return {
		debug: (message, data) => emit("debug", tag, message, data),
		info: (message, data) => emit("info", tag, message, data),
		warn: (message, data) => emit("warn", tag, message, data),
		error: (message, data) => emit("error", tag, message, data),
	};
}

// ── Internals ─────────────────────────────────────────────────────────────

function emit(level: LogLevel, tag: string, message: string, data: unknown): void {
	if (diagnosticSink) {
		try {
			diagnosticSink.recordLog({ level, tag, message, data });
		} catch {
			// Diagnostics must never break the logging caller.
		}
	}

	if (LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[currentLogLevel]) {
		const prefix = `[${new Date().toTimeString().slice(0, 8)}] [${tag}]`;
		if (data !== undefined) {
			console[level](prefix, message, data);
		} else {
			console[level](prefix, message);
		}
	}
}

// ── Test helpers ──────────────────────────────────────────────────────────

/** Reset all module state. Only for tests. */
export function _resetLoggerForTests(): void {
	currentLogLevel = "warn";
	diagnosticSink = null;
}
