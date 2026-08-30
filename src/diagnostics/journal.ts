import { appendFile, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { type DiagnosticRecordEnvelope, diagnosticRecordEnvelopeSchema } from "../core";
import { getDiagnosticErrorClass } from "./bounded-value";
import { ensurePrivateDiagnosticDirectory } from "./private-path";

const DEFAULT_SEGMENT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEGMENT_COUNT = 4;
const DEFAULT_PENDING_RECORDS = 1_000;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_FLUSH_RECORD_COUNT = 64;
const DEFAULT_RETRY_INITIAL_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;
const JOURNAL_MANIFEST_VERSION = 1;

interface JournalSegmentMetadata {
	file: string;
	bytes: number;
	records: number;
	firstSequence: number | null;
	lastSequence: number | null;
}

interface JournalManifest {
	version: 1;
	updatedAt: string;
	segments: JournalSegmentMetadata[];
}

export interface DiagnosticJournalOptions {
	segmentMaxBytes?: number;
	segmentCount?: number;
	maxPendingRecords?: number;
	flushIntervalMs?: number;
	flushRecordCount?: number;
	retryInitialMs?: number;
	retryMaxMs?: number;
	onFailure?: (error: Error) => void;
}

export interface DiagnosticJournalHealth {
	healthy: boolean;
	pendingRecords: number;
	recoveryDroppedRecords: number;
	failureCount: number;
	lastFlushAt: number | null;
	segments: number;
	appendOperations: number;
}

export interface DiagnosticJournalReadResult {
	records: DiagnosticRecordEnvelope[];
	warnings: string[];
}

export interface DiagnosticJournalEnqueueResult {
	queued: boolean;
	dropped: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, path);
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function segmentFilename(index: number): string {
	return `records-${String(index).padStart(6, "0")}.jsonl`;
}

function isHighPriorityRecord(record: DiagnosticRecordEnvelope): boolean {
	return (
		record.level === "warn" || record.level === "error" || record.kind === "recorder_health" || record.kind === "mark"
	);
}

function retainBoundedPendingRecords(
	records: readonly DiagnosticRecordEnvelope[],
	maximum: number,
): { records: DiagnosticRecordEnvelope[]; dropped: number } {
	const retained: DiagnosticRecordEnvelope[] = [];
	let dropped = 0;
	for (const record of records) {
		if (retained.length < maximum) {
			retained.push(record);
			continue;
		}
		const replaceableIndex = isHighPriorityRecord(record)
			? retained.findIndex((candidate) => !isHighPriorityRecord(candidate))
			: -1;
		if (replaceableIndex < 0) {
			dropped += 1;
			continue;
		}
		retained.splice(replaceableIndex, 1);
		retained.push(record);
		dropped += 1;
	}
	return { records: retained, dropped };
}

export class DiagnosticJournal {
	private readonly segmentMaxBytes: number;
	private readonly segmentCount: number;
	private readonly maxPendingRecords: number;
	private readonly flushIntervalMs: number;
	private readonly flushRecordCount: number;
	private readonly retryInitialMs: number;
	private readonly retryMaxMs: number;
	private readonly onFailure: (error: Error) => void;
	private readonly pending: DiagnosticRecordEnvelope[] = [];
	private segments: JournalSegmentMetadata[] = [];
	private nextSegmentIndex = 1;
	private flushTimer: NodeJS.Timeout | null = null;
	private flushPromise: Promise<void> = Promise.resolve();
	private initialized = false;
	private closed = false;
	private failureCount = 0;
	private healthy = true;
	private recoveryDroppedRecords = 0;
	private lastFlushAt: number | null = null;
	private appendOperations = 0;
	private retryAttempt = 0;

	constructor(
		readonly directory: string,
		options: DiagnosticJournalOptions = {},
	) {
		this.segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES;
		this.segmentCount = options.segmentCount ?? DEFAULT_SEGMENT_COUNT;
		this.maxPendingRecords = options.maxPendingRecords ?? DEFAULT_PENDING_RECORDS;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.flushRecordCount = options.flushRecordCount ?? DEFAULT_FLUSH_RECORD_COUNT;
		this.retryInitialMs = options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS;
		this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
		this.onFailure = options.onFailure ?? (() => undefined);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		try {
			await ensurePrivateDiagnosticDirectory(this.directory);
			this.initialized = true;
		} catch (error) {
			this.reportFailure(error);
		}
	}

	enqueue(record: DiagnosticRecordEnvelope): DiagnosticJournalEnqueueResult {
		if (this.closed) return { queued: false, dropped: 1 };
		let dropped = 0;
		if (this.pending.length >= this.maxPendingRecords) {
			const replaceableIndex = isHighPriorityRecord(record)
				? this.pending.findIndex((candidate) => !isHighPriorityRecord(candidate))
				: -1;
			if (replaceableIndex < 0) return { queued: false, dropped: 1 };
			this.pending.splice(replaceableIndex, 1);
			dropped = 1;
		}
		this.pending.push(record);
		if (this.pending.length >= this.flushRecordCount) {
			this.scheduleFlush(0);
		} else if (!this.flushTimer) {
			this.scheduleFlush(this.flushIntervalMs);
		}
		return { queued: true, dropped };
	}

	async flush(): Promise<void> {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.flushPromise = this.flushPromise
			.then(async () => this.flushPending())
			.catch((error: unknown) => {
				this.reportFailure(error);
			});
		await this.flushPromise;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = null;
		await this.flush();
	}

	getHealth(): DiagnosticJournalHealth {
		return {
			healthy: this.healthy,
			pendingRecords: this.pending.length,
			recoveryDroppedRecords: this.recoveryDroppedRecords,
			failureCount: this.failureCount,
			lastFlushAt: this.lastFlushAt,
			segments: this.segments.length,
			appendOperations: this.appendOperations,
		};
	}

	private scheduleFlush(delayMs: number): void {
		if (this.closed) return;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(async () => {
			this.flushTimer = null;
			await this.flush();
		}, delayMs);
		this.flushTimer.unref();
	}

	private async flushPending(): Promise<void> {
		if (this.pending.length === 0) return;
		if (!this.initialized) {
			await this.initialize();
			if (!this.initialized) {
				this.scheduleRetry();
				return;
			}
		}
		const records = this.pending.splice(0);
		try {
			await this.appendRecords(records);
			await this.writeManifest();
			this.lastFlushAt = Date.now();
			this.healthy = true;
			this.retryAttempt = 0;
		} catch (error) {
			// A segment may already contain a prefix of this batch. Requeueing the
			// bounded batch is safe because readers de-duplicate canonical record
			// ids, and it preserves the best chance of recovery after a transient
			// filesystem failure.
			const recovery = retainBoundedPendingRecords([...records, ...this.pending], this.maxPendingRecords);
			this.pending.splice(0, this.pending.length, ...recovery.records);
			this.recoveryDroppedRecords += recovery.dropped;
			this.reportFailure(error);
			this.scheduleRetry();
		}
	}

	private scheduleRetry(): void {
		if (this.closed || this.pending.length === 0) return;
		const delayMs = Math.min(this.retryInitialMs * 2 ** this.retryAttempt, this.retryMaxMs);
		this.retryAttempt += 1;
		this.scheduleFlush(delayMs);
	}

	private async appendRecords(records: readonly DiagnosticRecordEnvelope[]): Promise<void> {
		let index = 0;
		while (index < records.length) {
			let segment = this.segments.at(-1);
			if (!segment || segment.bytes >= this.segmentMaxBytes) segment = await this.createSegment();
			const firstRecord = records[index];
			const firstRecordBytes = firstRecord ? Buffer.byteLength(`${JSON.stringify(firstRecord)}\n`) : 0;
			if (segment.bytes > 0 && segment.bytes + firstRecordBytes > this.segmentMaxBytes) {
				segment = await this.createSegment();
			}

			const chunk: string[] = [];
			const chunkRecords: DiagnosticRecordEnvelope[] = [];
			let chunkBytes = 0;
			while (index < records.length) {
				const record = records[index];
				if (!record) break;
				const serialized = `${JSON.stringify(record)}\n`;
				const serializedBytes = Buffer.byteLength(serialized);
				if (chunk.length > 0 && segment.bytes + chunkBytes + serializedBytes > this.segmentMaxBytes) break;
				chunk.push(serialized);
				chunkRecords.push(record);
				chunkBytes += serializedBytes;
				index += 1;
				if (segment.bytes + chunkBytes >= this.segmentMaxBytes) break;
			}

			await appendFile(join(this.directory, segment.file), chunk.join(""), { encoding: "utf8", mode: 0o600 });
			this.appendOperations += 1;
			segment.bytes += chunkBytes;
			segment.records += chunkRecords.length;
			segment.firstSequence ??= chunkRecords[0]?.sequence ?? null;
			segment.lastSequence = chunkRecords.at(-1)?.sequence ?? segment.lastSequence;
		}
	}

	private async createSegment(): Promise<JournalSegmentMetadata> {
		const segment: JournalSegmentMetadata = {
			file: segmentFilename(this.nextSegmentIndex++),
			bytes: 0,
			records: 0,
			firstSequence: null,
			lastSequence: null,
		};
		this.segments.push(segment);
		while (this.segments.length > this.segmentCount) {
			const removed = this.segments.shift();
			if (removed) await unlink(join(this.directory, removed.file)).catch(() => undefined);
		}
		return segment;
	}

	private async writeManifest(): Promise<void> {
		const manifest: JournalManifest = {
			version: JOURNAL_MANIFEST_VERSION,
			updatedAt: new Date().toISOString(),
			segments: this.segments.map((segment) => ({ ...segment })),
		};
		await writeJsonAtomic(join(this.directory, "journal.json"), manifest);
	}

	private reportFailure(error: unknown): void {
		this.healthy = false;
		this.failureCount += 1;
		this.onFailure(error instanceof Error ? error : new Error(errorMessage(error)));
	}
}

async function listJournalSegmentPaths(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /^records-\d+\.jsonl$/u.test(entry.name))
			.map((entry) => join(directory, entry.name))
			.sort((left, right) => basename(left).localeCompare(basename(right)));
	} catch {
		return [];
	}
}

export async function readDiagnosticJournal(directory: string): Promise<DiagnosticJournalReadResult> {
	const records: DiagnosticRecordEnvelope[] = [];
	const warnings: string[] = [];
	for (const path of await listJournalSegmentPaths(directory)) {
		let contents: string;
		try {
			contents = await readFile(path, "utf8");
		} catch (error) {
			warnings.push(`Could not read ${basename(path)} (${getDiagnosticErrorClass(error)}).`);
			continue;
		}
		const lines = contents.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]?.trim();
			if (!line) continue;
			try {
				const parsed = diagnosticRecordEnvelopeSchema.safeParse(JSON.parse(line) as unknown);
				if (!parsed.success) throw new Error("schema validation failed");
				records.push(parsed.data);
			} catch (error) {
				const isCrashTail = index === lines.length - 1 && !contents.endsWith("\n");
				warnings.push(
					`${basename(path)}:${index + 1} ${isCrashTail ? "contains a partial crash tail" : `was skipped (${getDiagnosticErrorClass(error)})`}`,
				);
			}
		}
	}
	const byId = new Map(records.map((record) => [record.id, record]));
	return {
		records: Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence),
		warnings,
	};
}

export async function getDiagnosticJournalSize(directory: string): Promise<number> {
	let total = 0;
	for (const path of await listJournalSegmentPaths(directory)) total += await fileSize(path);
	return total;
}
