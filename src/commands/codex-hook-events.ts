import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findCodexRolloutFileForCwd, mapCodexRolloutActivityLine } from "./codex-rollout-parser";
import type { CodexSessionWatcherNotify } from "./codex-session-parser";
import { createCodexWatcherState, parseCodexEventLine } from "./codex-session-parser";

// ── Re-exports ──────────────────────────────────────────────────────────────────

export { resolveCodexRolloutFinalMessageForCwd } from "./codex-rollout-parser";
export type { CodexMappedHookEvent, CodexSessionWatcherNotify } from "./codex-session-parser";
export { createCodexWatcherState, parseCodexEventLine } from "./codex-session-parser";

// ── Constants ───────────────────────────────────────────────────────────────────

const CODEX_LOG_POLL_INTERVAL_MS = 200;
const CODEX_ROLLOUT_POLL_INTERVAL_MS = 1000;
const CODEX_ROLLOUT_INITIAL_BACKLOG_BYTES = 256 * 1024;

// ── Watcher options ─────────────────────────────────────────────────────────────

export interface CodexSessionWatcherOptions {
	cwd?: string;
	sessionsRoot?: string;
	rolloutPollIntervalMs?: number;
}

// ── Session watcher ─────────────────────────────────────────────────────────────

export async function startCodexSessionWatcher(
	logPath: string,
	notify: CodexSessionWatcherNotify,
	pollIntervalMs = CODEX_LOG_POLL_INTERVAL_MS,
	options: CodexSessionWatcherOptions = {},
): Promise<() => Promise<void>> {
	const state = createCodexWatcherState();
	const watcherCwd = options.cwd?.trim() ?? "";
	const sessionsRoot = options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
	const rolloutPollIntervalMs = options.rolloutPollIntervalMs ?? CODEX_ROLLOUT_POLL_INTERVAL_MS;
	const watcherStartedAtMs = Date.now();
	let rolloutLogPath = "";
	let rolloutOffset = 0;
	let rolloutRemainder = "";
	let lastRolloutPollAt = 0;

	const pollRolloutActivity = async () => {
		if (!watcherCwd) {
			return;
		}
		const now = Date.now();
		if (now - lastRolloutPollAt < rolloutPollIntervalMs) {
			return;
		}
		lastRolloutPollAt = now;

		if (!rolloutLogPath) {
			const resolvedRolloutPath = await findCodexRolloutFileForCwd(watcherCwd, watcherStartedAtMs, sessionsRoot);
			if (!resolvedRolloutPath) {
				return;
			}
			rolloutLogPath = resolvedRolloutPath;
			try {
				const initialStat = await stat(rolloutLogPath);
				rolloutOffset = Math.max(0, initialStat.size - CODEX_ROLLOUT_INITIAL_BACKLOG_BYTES);
			} catch {
				rolloutOffset = 0;
			}
		}

		let fileStat: Stats;
		try {
			fileStat = await stat(rolloutLogPath);
		} catch {
			rolloutLogPath = "";
			rolloutOffset = 0;
			rolloutRemainder = "";
			return;
		}
		if (fileStat.size < rolloutOffset) {
			rolloutOffset = 0;
			rolloutRemainder = "";
		}
		if (fileStat.size === rolloutOffset) {
			return;
		}

		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(rolloutLogPath, "r");
			const byteLength = fileStat.size - rolloutOffset;
			const buffer = Buffer.alloc(byteLength);
			await handle.read(buffer, 0, byteLength, rolloutOffset);
			rolloutOffset = fileStat.size;

			const combined = rolloutRemainder + buffer.toString("utf8");
			const lines = combined.split(/\r?\n/);
			rolloutRemainder = lines.pop() ?? "";

			for (const line of lines) {
				const mapped = mapCodexRolloutActivityLine(line);
				if (!mapped) {
					continue;
				}
				if (mapped.fingerprint === state.lastActivityFingerprint) {
					continue;
				}
				state.lastActivityFingerprint = mapped.fingerprint;
				notify(mapped.mapped);
			}
		} catch {
			// Ignore transient rollout read errors.
		} finally {
			await handle?.close();
		}
	};

	const poll = async () => {
		let fileStat: Stats;
		try {
			fileStat = await stat(logPath);
		} catch {
			await pollRolloutActivity();
			return;
		}
		if (fileStat.size < state.offset) {
			state.offset = 0;
			state.remainder = "";
		}
		if (fileStat.size !== state.offset) {
			let handle: Awaited<ReturnType<typeof open>> | null = null;
			try {
				handle = await open(logPath, "r");
				const byteLength = fileStat.size - state.offset;
				const buffer = Buffer.alloc(byteLength);
				await handle.read(buffer, 0, byteLength, state.offset);
				state.offset = fileStat.size;
				const combined = state.remainder + buffer.toString("utf8");
				const lines = combined.split(/\r?\n/);
				state.remainder = lines.pop() ?? "";
				for (const line of lines) {
					const mapped = parseCodexEventLine(line, state);
					if (mapped) {
						notify(mapped);
					}
				}
			} catch {
				// Ignore transient session log read errors.
			} finally {
				await handle?.close();
			}
		}

		await pollRolloutActivity();
	};

	let queuedPoll = Promise.resolve();
	const queuePoll = (): Promise<void> => {
		queuedPoll = queuedPoll.then(
			() => poll(),
			() => poll(),
		);
		return queuedPoll;
	};

	const flushRemainder = () => {
		const line = state.remainder.trim();
		if (!line) {
			return;
		}
		state.remainder = "";
		const mapped = parseCodexEventLine(line, state);
		if (mapped) {
			notify(mapped);
		}
	};

	const flushRolloutRemainder = () => {
		const line = rolloutRemainder.trim();
		if (!line) {
			return;
		}
		rolloutRemainder = "";
		const mapped = mapCodexRolloutActivityLine(line);
		if (!mapped) {
			return;
		}
		if (mapped.fingerprint === state.lastActivityFingerprint) {
			return;
		}
		state.lastActivityFingerprint = mapped.fingerprint;
		notify(mapped.mapped);
	};

	const timer = setInterval(() => {
		void queuePoll();
	}, pollIntervalMs);
	await queuePoll();
	return async () => {
		clearInterval(timer);
		await queuePoll();
		flushRemainder();
		flushRolloutRemainder();
	};
}
