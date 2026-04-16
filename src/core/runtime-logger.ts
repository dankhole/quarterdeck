/**
 * Runtime logging system.
 *
 * Provides tagged loggers that write to console AND notify registered listeners
 * (for WebSocket broadcast to the browser UI). Log calls below the current
 * threshold are no-ops with zero overhead.
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

export interface LogEntry {
	id: string;
	timestamp: number;
	level: LogLevel;
	tag: string;
	message: string;
	data?: unknown;
	source: "server" | "client";
}

export interface TaggedLogger {
	debug: (message: string, data?: unknown) => void;
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
}

type LogEntryListener = (entry: LogEntry) => void;

// ── Module state ──────────────────────────────────────────────────────────

let currentLogLevel: LogLevel = "warn";
let entryIdCounter = 0;
const listeners = new Set<LogEntryListener>();

const RING_BUFFER_CAPACITY = 200;
const DATA_MAX_CHARS = 2000;
const ringBuffer: LogEntry[] = [];

// ── Public API ────────────────────────────────────────────────────────────

export function setLogLevel(level: LogLevel): void {
	currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

/** Convenience wrapper: `true` sets level to "debug", `false` restores to "warn". */
export function setDebugLoggingEnabled(enabled: boolean): void {
	currentLogLevel = enabled ? "debug" : "warn";
}

/** Returns true when the level is below "warn" (i.e. debug or info messages will be emitted). */
export function isDebugLoggingEnabled(): boolean {
	return LOG_LEVEL_SEVERITY[currentLogLevel] < LOG_LEVEL_SEVERITY.warn;
}

export function getRecentLogEntries(): LogEntry[] {
	return [...ringBuffer];
}

export function onLogEntry(listener: LogEntryListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
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
	// Only emit entries at or above the current log level threshold.
	if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[currentLogLevel]) {
		return;
	}

	const entry: LogEntry = {
		id: String(++entryIdCounter),
		timestamp: Date.now(),
		level,
		tag,
		message,
		data: safeSerializeData(data),
		source: "server",
	};

	// Console output (always when enabled).
	const prefix = `[${new Date(entry.timestamp).toTimeString().slice(0, 8)}] [${tag}]`;
	if (data !== undefined) {
		console[level](prefix, message, data);
	} else {
		console[level](prefix, message);
	}

	// Ring buffer.
	if (ringBuffer.length >= RING_BUFFER_CAPACITY) {
		ringBuffer.shift();
	}
	ringBuffer.push(entry);

	// Notify listeners (for WebSocket broadcast).
	for (const listener of listeners) {
		try {
			listener(entry);
		} catch {
			// Listener errors must never break the logging caller.
		}
	}
}

function safeSerializeData(data: unknown): unknown {
	if (data === undefined || data === null) {
		return data;
	}
	try {
		const serialized = JSON.stringify(data);
		if (serialized.length > DATA_MAX_CHARS) {
			return JSON.parse(`${serialized.slice(0, DATA_MAX_CHARS)}`) as unknown;
		}
		return data;
	} catch {
		return String(data);
	}
}

// ── Test helpers ──────────────────────────────────────────────────────────

/** Reset all module state. Only for tests. */
export function _resetLoggerForTests(): void {
	currentLogLevel = "warn";
	entryIdCounter = 0;
	listeners.clear();
	ringBuffer.length = 0;
}
