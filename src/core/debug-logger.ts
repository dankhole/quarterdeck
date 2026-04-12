/**
 * Runtime-togglable debug logging system.
 *
 * Provides tagged loggers that write to console AND notify registered listeners
 * (for WebSocket broadcast to the browser UI). When debug logging is disabled,
 * log calls are no-ops with zero overhead.
 *
 * Usage:
 *   import { createTaggedLogger } from "../core/debug-logger";
 *   const log = createTaggedLogger("my-tag");
 *   log.debug("Something happened", { extra: "data" });
 */

export type DebugLogLevel = "debug" | "info" | "warn" | "error";

export interface DebugLogEntry {
	id: string;
	timestamp: number;
	level: DebugLogLevel;
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

type DebugLogEntryListener = (entry: DebugLogEntry) => void;

// ── Module state ──────────────────────────────────────────────────────────

let debugLoggingEnabled = false;
let entryIdCounter = 0;
const listeners = new Set<DebugLogEntryListener>();

const RING_BUFFER_CAPACITY = 200;
const DATA_MAX_CHARS = 2000;
const ringBuffer: DebugLogEntry[] = [];

// ── Public API ────────────────────────────────────────────────────────────

export function setDebugLoggingEnabled(enabled: boolean): void {
	debugLoggingEnabled = enabled;
}

export function isDebugLoggingEnabled(): boolean {
	return debugLoggingEnabled;
}

export function getRecentDebugLogEntries(): DebugLogEntry[] {
	return [...ringBuffer];
}

export function onDebugLogEntry(listener: DebugLogEntryListener): () => void {
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

function emit(level: DebugLogLevel, tag: string, message: string, data: unknown): void {
	// warn and error always log — they represent problems worth capturing.
	// debug and info are gated behind the debug toggle to avoid noise.
	if (!debugLoggingEnabled && (level === "debug" || level === "info")) {
		return;
	}

	const entry: DebugLogEntry = {
		id: String(++entryIdCounter),
		timestamp: Date.now(),
		level,
		tag,
		message,
		data: safeSerializeData(data),
		source: "server",
	};

	// Console output (always when enabled).
	const prefix = `[${tag}]`;
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
export function _resetDebugLoggerForTests(): void {
	debugLoggingEnabled = false;
	entryIdCounter = 0;
	listeners.clear();
	ringBuffer.length = 0;
}
