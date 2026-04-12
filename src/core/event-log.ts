// Structured JSONL event log for developer debugging and production diagnostics.
// Writes one JSON object per line to ~/.quarterdeck/logs/events.jsonl with 10MB
// file rotation. Gated behind the `eventLogEnabled` config toggle (default off)
// so users don't accumulate log files they don't need.
//
// This is separate from the debug logger (core/debug-logger.ts) — the debug
// logger is an ephemeral 200-entry ring buffer for live UI inspection, while
// this writes persistent, greppable JSONL to disk for post-mortem analysis.
//
// ── How to emit events ──────────────────────────────────────────────────────
//
//   import { emitSessionEvent } from "../core/event-log";
//   emitSessionEvent(taskId, "hook.received", { key: "value" });
//
//   import { emitEvent } from "../core/event-log";
//   emitEvent("system.startup", { version: "1.0" });
//
// Both are fire-and-forget — they never throw or block the caller.
// Use emitSessionEvent for task-scoped events (taskId in top-level field).
// Use emitEvent for system-wide events (taskId is null).
//
// ── How to add a new event ──────────────────────────────────────────────────
//
// 1. Pick a namespaced event name (e.g. "hook.received", "session.exited",
//    "reconciliation.sweep"). Use dot-separated hierarchy.
// 2. Call emitSessionEvent or emitEvent at the relevant code point.
// 3. Include enough data to reconstruct what happened without reading other
//    log lines. Timestamps, state before/after, IDs, and error messages.
// 4. Document the event in docs/forge/2026-04-12-session-lifecycle-refactor/
//    observability-plan.md (event table) if it's a session lifecycle event.
//
// ── How to analyze the log ──────────────────────────────────────────────────
//
//   # All events for a task
//   jq 'select(.taskId == "task-id")' ~/.quarterdeck/logs/events.jsonl
//
//   # Stuck sessions: running with no hooks for >60s
//   jq 'select(.event == "health.snapshot" and .data.state == "running"
//        and .data.msSinceLastHook > 60000)' ~/.quarterdeck/logs/events.jsonl
//
//   # User-flagged moments (debug button on task cards)
//   jq 'select(.event == "user.flagged")' ~/.quarterdeck/logs/events.jsonl

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EventLogEntry {
	timestamp: number;
	taskId: string | null;
	event: string;
	data: Record<string, unknown>;
}

const LOG_DIR = join(homedir(), ".quarterdeck", "logs");
const LOG_FILE = join(LOG_DIR, "events.jsonl");
const ROTATED_FILE = join(LOG_DIR, "events.1.jsonl");
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

let enabled = false;
let initialized = false;
let rotating = false;
// Track approximate size to avoid stat() on every emit.
let approximateFileSize = 0;
// Batch writes with a micro-queue to avoid overlapping appendFile calls.
let writeQueue: Promise<void> = Promise.resolve();

async function ensureLogDir(): Promise<void> {
	if (initialized) {
		return;
	}
	try {
		await mkdir(LOG_DIR, { recursive: true });
		try {
			const info = await stat(LOG_FILE);
			approximateFileSize = info.size;
		} catch {
			approximateFileSize = 0;
		}
	} catch {
		// If we can't create the directory, emit will silently fail.
	}
	initialized = true;
}

async function rotateIfNeeded(): Promise<void> {
	if (rotating || approximateFileSize < MAX_FILE_SIZE_BYTES) {
		return;
	}
	rotating = true;
	try {
		await rename(LOG_FILE, ROTATED_FILE);
		approximateFileSize = 0;
	} catch {
		// Rotation failure is non-critical — keep writing to the current file.
	} finally {
		rotating = false;
	}
}

export function setEventLogEnabled(value: boolean): void {
	enabled = value;
}

export function isEventLogEnabled(): boolean {
	return enabled;
}

/**
 * Ensures the log directory exists. Called during server startup so the
 * directory is ready before any events are emitted.
 */
export async function initEventLog(): Promise<void> {
	await ensureLogDir();
}

function writeEntry(entry: EventLogEntry): void {
	if (!enabled) {
		return;
	}
	const line = `${JSON.stringify(entry)}\n`;
	const lineSize = Buffer.byteLength(line, "utf8");

	writeQueue = writeQueue.then(async () => {
		try {
			await ensureLogDir();
			await rotateIfNeeded();
			await appendFile(LOG_FILE, line, "utf8");
			approximateFileSize += lineSize;
		} catch {
			// Logging failure is never worth crashing the runtime.
		}
	});
}

/**
 * Emit a structured event to the JSONL log. Not scoped to a session.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function emitEvent(event: string, data: Record<string, unknown> = {}): void {
	writeEntry({
		timestamp: Date.now(),
		taskId: null,
		event,
		data,
	});
}

/**
 * Emit a structured session lifecycle event to the JSONL log.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function emitSessionEvent(taskId: string, event: string, data: Record<string, unknown> = {}): void {
	writeEntry({
		timestamp: Date.now(),
		taskId,
		event,
		data,
	});
}
