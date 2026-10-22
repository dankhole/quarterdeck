import { resolveClaudeTaskHistoryRoots } from "../conversation/claude-conversation-export";
import { type IncrementalJsonlPosition, readIncrementalJsonl } from "../conversation/incremental-jsonl-reader";
import { DEFAULT_CONVERSATION_READ_LIMITS } from "../conversation/limits";
import { isJsonObject, readString } from "../conversation/provider-record-utils";
import { ProviderConversationSourceLocator } from "../conversation/provider-source-locator";
import type { ConversationSourceHint } from "../conversation/types";
import { normalizeProviderTaskTitle } from "./provider-task-title";

/** Transcript bytes examined per session per read; a long transcript catches up over several reads. */
export const CLAUDE_CUSTOM_TITLE_SCAN_BYTES_PER_READ = 8 * 1024 * 1024;
const MAX_TITLE_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS_PER_READ = 1_000_000;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_FOLLOWED_TRANSCRIPTS = 256;
/** Lookup backoff for a session with no transcript yet; a new hook hint retries immediately. */
export const CLAUDE_MISSING_TRANSCRIPT_BACKOFF_MS = { initial: 2_000, max: 60_000 } as const;
const CUSTOM_TITLE_MARKER = Buffer.from('"custom-title"', "utf8");

export interface ClaudeCustomTitleTarget {
	sessionId: string;
	hint: ConversationSourceHint | null;
}

/** A custom title plus the identity of the record that set it, so a repeated rename is a new observation. */
export interface ClaudeCustomTitle {
	title: string;
	revision: string;
}

interface FollowedTranscript {
	canonicalPath: string;
	dev: number;
	ino: number;
	position: IncrementalJsonlPosition;
	/** Latest custom-title record read so far; title "" when it was explicitly empty. */
	latest: ClaudeCustomTitle | null;
}

interface MissingTranscript {
	attempts: number;
	retryAt: number;
	hintPath: string | null;
}

export function parseClaudeCustomTitleRecord(value: unknown, sessionId: string): string | null {
	if (!isJsonObject(value) || readString(value, "type") !== "custom-title") return null;
	if (readString(value, "sessionId")?.trim() !== sessionId) return null;
	const customTitle = readString(value, "customTitle");
	return customTitle === null ? null : normalizeProviderTaskTitle(customTitle);
}

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_FOLLOWED_TRANSCRIPTS) {
		const oldest = map.keys().next().value;
		if (typeof oldest !== "string") break;
		map.delete(oldest);
	}
}

/**
 * Follows Claude `/rename` titles (`custom-title` JSONL entries) in each
 * session's exact transcript, read-only. Each transcript is scanned forward
 * once and then only appended records are read, so an old rename is not lost
 * outside a tail window. Summaries and AI titles are deliberately ignored.
 */
export class ClaudeCustomTitleFollower {
	private readonly transcripts = new Map<string, FollowedTranscript>();
	private readonly missing = new Map<string, MissingTranscript>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Returns the latest non-empty custom title for each target whose transcript is fully read. */
	async read(
		profileRoot: string,
		targets: readonly ClaudeCustomTitleTarget[],
	): Promise<Map<string, ClaudeCustomTitle>> {
		const titles = new Map<string, ClaudeCustomTitle>();
		if (targets.length === 0) return titles;
		const locator = new ProviderConversationSourceLocator(
			"claude",
			resolveClaudeTaskHistoryRoots(profileRoot),
			DEFAULT_CONVERSATION_READ_LIMITS,
		);
		for (const target of targets) {
			const key = `${profileRoot}\0${target.sessionId}`;
			const followed = this.transcripts.get(key);
			if (!followed && this.shouldDeferLookup(key, target)) continue;
			this.transcripts.delete(key);
			const result = await this.readTarget(locator, target, followed).catch(() => null);
			if (result === "missing") {
				this.recordMissing(key, target);
				continue;
			}
			this.missing.delete(key);
			if (!result) continue;
			rememberBounded(this.transcripts, key, result.state);
			if (result.value?.title) titles.set(target.sessionId, result.value);
		}
		return titles;
	}

	/** Performance policy only: without it, a missing transcript is searched for on every read. */
	private shouldDeferLookup(key: string, target: ClaudeCustomTitleTarget): boolean {
		const missing = this.missing.get(key);
		return Boolean(missing && this.now() < missing.retryAt && (target.hint?.sourcePath ?? null) === missing.hintPath);
	}

	private recordMissing(key: string, target: ClaudeCustomTitleTarget): void {
		const attempts = (this.missing.get(key)?.attempts ?? 0) + 1;
		const delay = Math.min(
			CLAUDE_MISSING_TRANSCRIPT_BACKOFF_MS.max,
			CLAUDE_MISSING_TRANSCRIPT_BACKOFF_MS.initial * 2 ** (attempts - 1),
		);
		rememberBounded(this.missing, key, {
			attempts,
			retryAt: this.now() + delay,
			hintPath: target.hint?.sourcePath ?? null,
		});
	}

	private async readTarget(
		locator: ProviderConversationSourceLocator,
		target: ClaudeCustomTitleTarget,
		followed: FollowedTranscript | undefined,
	): Promise<{ state: FollowedTranscript; value: ClaudeCustomTitle | null } | "missing" | null> {
		const deadlineAt = Date.now() + DEFAULT_CONVERSATION_READ_LIMITS.deadlineMs;
		const lookup = await locator.locate({
			projectId: "",
			taskId: "",
			providerSessionId: target.sessionId,
			deadlineAt,
			// Lookup policy: a remembered path is revalidated like any hint before it is read.
			hint:
				target.hint ??
				(followed
					? { providerId: "claude", providerSessionId: target.sessionId, sourcePath: followed.canonicalPath }
					: null),
		});
		if (lookup.status !== "available") return "missing";
		const { source } = lookup;
		try {
			const stat = await source.fileHandle.stat();
			const state: FollowedTranscript =
				followed &&
				followed.canonicalPath === source.canonicalPath &&
				followed.dev === stat.dev &&
				followed.ino === stat.ino &&
				followed.position.offset <= source.fileSize
					? followed
					: {
							canonicalPath: source.canonicalPath,
							dev: stat.dev,
							ino: stat.ino,
							position: { offset: 0, partial: Buffer.alloc(0), discardUntilNewline: false },
							latest: null,
						};
			const scan = await readIncrementalJsonl({
				fileHandle: source.fileHandle,
				fileSize: source.fileSize,
				position: state.position,
				maxBytes: CLAUDE_CUSTOM_TITLE_SCAN_BYTES_PER_READ,
				maxRecords: MAX_RECORDS_PER_READ,
				maxRawRecordBytes: MAX_TITLE_RECORD_BYTES,
				chunkBytes: READ_CHUNK_BYTES,
				deadlineAt,
				shouldParse: (bytes) => bytes.includes(CUSTOM_TITLE_MARKER),
				onRecord: (record) => {
					if (record.kind !== "parsed") return;
					const title = parseClaudeCustomTitleRecord(record.value, target.sessionId);
					if (title !== null) state.latest = { title, revision: `${state.dev}:${state.ino}:${record.byteOffset}` };
				},
			});
			// A truncated or replaced transcript restarts from the beginning on the next read.
			if (scan.sourceChanged) return null;
			state.position = scan.position;
			// Report only once caught up, so an older rename never briefly replaces a newer one.
			const caughtUp = state.position.offset >= source.fileSize;
			return { state, value: caughtUp ? state.latest : null };
		} finally {
			await source.fileHandle.close().catch(() => undefined);
		}
	}
}
