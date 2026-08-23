import { performance } from "node:perf_hooks";

import {
	type BrowserDiagnosticCandidate,
	browserDiagnosticCandidateSchema,
	type DiagnosticContext,
	type DiagnosticRecordEnvelope,
	type DiagnosticRecorderHealth,
	type DiagnosticRecordingScope,
	type DiagnosticRecordingState,
	type DiagnosticTruncationSummary,
	diagnosticContextSchema,
} from "../core";
import {
	type DiagnosticPathAliases,
	getDiagnosticErrorClass,
	sanitizeDiagnosticText,
	sanitizeDiagnosticValue,
} from "./bounded-value";
import {
	type DiagnosticLogCandidate,
	type DiagnosticRecordCandidate,
	type DiagnosticRecordFilter,
	matchesDiagnosticRecordFilter,
	mergeDiagnosticRecordSources,
} from "./diagnostic-record";
import { type DiagnosticJournal, readDiagnosticJournal } from "./journal";
import { type DiagnosticAdmissionProfile, DiagnosticRecordingPolicy } from "./recording-policy";

const DEFAULT_MEMORY_RECORDS = 2_000;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1_024;
const RAW_WARNING_INTERVAL_MS = 60_000;

export interface DiagnosticRecorderOptions {
	runtimeInstanceId: string;
	journal: DiagnosticJournal;
	memoryCapacity?: number;
	maxRecordBytes?: number;
	pathAliases?: DiagnosticPathAliases;
	admissionProfile?: DiagnosticAdmissionProfile;
}

export interface BrowserDiagnosticIngestResult {
	accepted: number;
	rejected: number;
	duplicate: number;
	highestAcceptedSequence: number;
}

export interface DiagnosticRecordCollectionResult {
	records: DiagnosticRecordEnvelope[];
	warnings: string[];
}

interface SafeDiagnosticLogDataSummary {
	type: "array" | "bigint" | "boolean" | "error" | "function" | "null" | "number" | "object" | "string" | "symbol";
	entryCount?: number;
	fieldCount?: number;
	errorClass?: string;
}

function summarizeDiagnosticLogData(value: unknown): SafeDiagnosticLogDataSummary | undefined {
	if (value === undefined) return undefined;
	if (value === null) return { type: "null" };
	if (value instanceof Error) return { type: "error", errorClass: getDiagnosticErrorClass(value) };
	if (Array.isArray(value)) return { type: "array", entryCount: value.length };
	if (typeof value === "object") {
		let fieldCount = 0;
		try {
			fieldCount = Object.keys(value).length;
		} catch {
			// Proxies and host objects can reject reflection; the type is still useful.
		}
		return { type: "object", fieldCount };
	}
	if (typeof value === "string") return { type: "string" };
	if (typeof value === "number") return { type: "number" };
	if (typeof value === "bigint") return { type: "bigint" };
	if (typeof value === "boolean") return { type: "boolean" };
	if (typeof value === "symbol") return { type: "symbol" };
	return { type: "function" };
}

function combineTruncation(
	...summaries: Array<DiagnosticTruncationSummary | undefined>
): DiagnosticTruncationSummary | undefined {
	const present = summaries.filter((summary): summary is DiagnosticTruncationSummary => summary !== undefined);
	if (present.length === 0) return undefined;
	return present.reduce<DiagnosticTruncationSummary>(
		(combined, summary) => ({
			strings: combined.strings + summary.strings,
			arrays: combined.arrays + summary.arrays,
			objects: combined.objects + summary.objects,
			depth: combined.depth + summary.depth,
			redacted: combined.redacted + summary.redacted,
			totalBytes: Math.max(combined.totalBytes ?? 0, summary.totalBytes ?? 0) || undefined,
		}),
		{ strings: 0, arrays: 0, objects: 0, depth: 0, redacted: 0 },
	);
}

function normalizeContext(
	context: DiagnosticContext | undefined,
	pathAliases: DiagnosticPathAliases | undefined,
): { value: DiagnosticContext; truncation: DiagnosticTruncationSummary | undefined } {
	const sanitized = sanitizeDiagnosticValue(context ?? {}, { pathAliases });
	const parsed = diagnosticContextSchema.safeParse(sanitized.value);
	return {
		value: parsed.success ? parsed.data : {},
		truncation: sanitized.truncation,
	};
}

function isHighPriority(record: DiagnosticRecordEnvelope): boolean {
	return record.level === "warn" || record.level === "error" || record.kind === "recorder_health";
}

export class DiagnosticRecorder {
	readonly runtimeInstanceId: string;
	private readonly journal: DiagnosticJournal;
	private readonly memoryCapacity: number;
	private readonly maxRecordBytes: number;
	private readonly pathAliases: DiagnosticPathAliases | undefined;
	private readonly startedAtMonotonic = performance.now();
	private readonly policy: DiagnosticRecordingPolicy;
	private readonly includeSyntheticLogContent: boolean;
	private readonly records: DiagnosticRecordEnvelope[] = [];
	private readonly listeners = new Set<(record: DiagnosticRecordEnvelope) => void>();
	private readonly recordingListeners = new Set<(state: DiagnosticRecordingState) => void>();
	private readonly highestBrowserSequenceByClient = new Map<string, number>();
	private sequence = 0;
	private droppedRecords = 0;
	private droppedSinceReport = 0;
	private rejectedBrowserRecords = 0;
	private isReportingDrops = false;
	private lastRawWarningAt = 0;
	private previousRecordingState: DiagnosticRecordingState;

	constructor(options: DiagnosticRecorderOptions) {
		this.runtimeInstanceId = options.runtimeInstanceId;
		this.journal = options.journal;
		this.memoryCapacity = options.memoryCapacity ?? DEFAULT_MEMORY_RECORDS;
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
		this.pathAliases = options.pathAliases;
		this.policy = new DiagnosticRecordingPolicy(options.admissionProfile);
		this.includeSyntheticLogContent = options.admissionProfile === "agent-lab";
		this.previousRecordingState = this.policy.getState();
		this.policy.onChange((state) => this.handleRecordingStateChange(state));
	}

	record(candidate: DiagnosticRecordCandidate): DiagnosticRecordEnvelope | null {
		return this.recordCandidate(candidate, true);
	}

	private recordCandidate(
		candidate: DiagnosticRecordCandidate,
		persistToJournal: boolean,
	): DiagnosticRecordEnvelope | null {
		if (!this.policy.shouldAdmit(candidate)) return null;
		const timestamp = Date.now();
		const name = sanitizeDiagnosticText(candidate.name, { pathAliases: this.pathAliases });
		const context = normalizeContext(candidate.context, this.pathAliases);
		const payload = sanitizeDiagnosticValue(candidate.payload ?? {}, { pathAliases: this.pathAliases });
		const record: DiagnosticRecordEnvelope = {
			version: 1,
			id: `${this.runtimeInstanceId}:${++this.sequence}`,
			sequence: this.sequence,
			timestamp,
			monotonicOffsetMs: Math.max(0, performance.now() - this.startedAtMonotonic),
			runtimeInstanceId: this.runtimeInstanceId,
			source: candidate.source,
			kind: candidate.kind,
			level: candidate.level,
			name: name.value.slice(0, 256) || "diagnostics.unnamed",
			context: context.value,
			payload: payload.value,
			truncation: combineTruncation(name.truncation, context.truncation, payload.truncation),
		};
		this.enforceRecordSize(record);
		this.retain(record);
		if (persistToJournal) {
			const journalAdmission = this.journal.enqueue(record);
			this.droppedRecords += journalAdmission.dropped;
			this.droppedSinceReport += journalAdmission.dropped;
			if (journalAdmission.queued) this.maybeReportDrops();
		}
		for (const listener of this.listeners) {
			try {
				listener(record);
			} catch {
				// A slow or broken diagnostics consumer cannot affect the app.
			}
		}
		return record;
	}

	recordEvent(
		name: string,
		payload: unknown,
		context: DiagnosticContext,
		options: {
			level?: DiagnosticRecordCandidate["level"];
			essential: boolean;
			source?: DiagnosticRecordCandidate["source"];
		},
	): DiagnosticRecordEnvelope | null {
		return this.record({
			source: options.source ?? "runtime",
			kind: "event",
			level: options.level ?? "info",
			name,
			context,
			payload,
			essential: options.essential,
		});
	}

	recordLog(candidate: DiagnosticLogCandidate): DiagnosticRecordEnvelope | null {
		const payload = this.includeSyntheticLogContent
			? { tag: candidate.tag, message: candidate.message, data: candidate.data }
			: {
					tag: candidate.tag,
					messageLength: candidate.message.length,
					dataSummary: summarizeDiagnosticLogData(candidate.data),
				};
		return this.record({
			source: "runtime",
			kind: "log",
			level: candidate.level,
			name: `log.${candidate.tag}`,
			payload,
			essential: false,
		});
	}

	ingestBrowserRecords(clientId: string, candidates: readonly unknown[]): BrowserDiagnosticIngestResult {
		let highest = this.highestBrowserSequenceByClient.get(clientId) ?? 0;
		let accepted = 0;
		let rejected = 0;
		let duplicate = 0;
		for (const candidate of candidates) {
			const parsed = browserDiagnosticCandidateSchema.safeParse(candidate);
			if (!parsed.success) {
				rejected += 1;
				continue;
			}
			if (parsed.data.clientSequence <= highest) {
				duplicate += 1;
				continue;
			}
			highest = parsed.data.clientSequence;
			const record = this.recordBrowserCandidate(clientId, parsed.data);
			if (record) accepted += 1;
		}
		this.highestBrowserSequenceByClient.set(clientId, highest);
		this.rejectedBrowserRecords += rejected;
		if (rejected > 0) {
			this.record({
				source: "runtime",
				kind: "recorder_health",
				level: "warn",
				name: "diagnostics.browser_batch_rejected",
				context: { clientId },
				payload: { rejected },
				essential: true,
			});
		}
		return { accepted, rejected, duplicate, highestAcceptedSequence: highest };
	}

	getRecentRecords(filter: DiagnosticRecordFilter = {}): DiagnosticRecordEnvelope[] {
		return this.records
			.filter((record) => matchesDiagnosticRecordFilter(record, filter))
			.map((record) => structuredClone(record));
	}

	getRecentRecordTail(limit: number, filter: DiagnosticRecordFilter = {}): DiagnosticRecordEnvelope[] {
		return this.records
			.filter((record) => matchesDiagnosticRecordFilter(record, filter))
			.slice(-Math.max(0, Math.floor(limit)))
			.map((record) => structuredClone(record));
	}

	async collectCaptureRecords(filter: DiagnosticRecordFilter = {}): Promise<DiagnosticRecordCollectionResult> {
		await this.journal.flush();
		const persisted = await readDiagnosticJournal(this.journal.directory);
		const health = this.journal.getHealth();
		return {
			records: mergeDiagnosticRecordSources([persisted.records, this.records], filter),
			warnings: [
				...persisted.warnings,
				...(health.healthy
					? []
					: ["The diagnostic journal is degraded; the in-memory tail was included as fallback."]),
			],
		};
	}

	onRecord(listener: (record: DiagnosticRecordEnvelope) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	startRecording(durationMs: number, scope: DiagnosticRecordingScope): DiagnosticRecordingState {
		return this.policy.start(durationMs, scope);
	}

	stopRecording(): DiagnosticRecordingState {
		return this.policy.stop();
	}

	getRecordingState(): DiagnosticRecordingState {
		return this.policy.getState();
	}

	onRecordingStateChange(listener: (state: DiagnosticRecordingState) => void): () => void {
		this.recordingListeners.add(listener);
		return () => this.recordingListeners.delete(listener);
	}

	getHealth(): DiagnosticRecorderHealth {
		const journalHealth = this.journal.getHealth();
		return {
			runtimeInstanceId: this.runtimeInstanceId,
			recordCount: this.records.length,
			pendingJournalRecords: journalHealth.pendingRecords,
			droppedRecords: this.droppedRecords + journalHealth.recoveryDroppedRecords,
			rejectedBrowserRecords: this.rejectedBrowserRecords,
			journalHealthy: journalHealth.healthy,
			journalFailureCount: journalHealth.failureCount,
			lastJournalFlushAt: journalHealth.lastFlushAt,
			recording: this.policy.getState(),
		};
	}

	async flush(): Promise<void> {
		await this.journal.flush();
	}

	async close(): Promise<void> {
		this.policy.dispose();
		this.listeners.clear();
		this.recordingListeners.clear();
		await this.journal.close();
	}

	reportJournalFailure(error: Error): void {
		const now = Date.now();
		if (now - this.lastRawWarningAt < RAW_WARNING_INTERVAL_MS) return;
		this.lastRawWarningAt = now;
		this.recordCandidate(
			{
				source: "runtime",
				kind: "recorder_health",
				level: "warn",
				name: "diagnostics.journal_write_failed",
				payload: { errorClass: getDiagnosticErrorClass(error) },
				essential: true,
			},
			false,
		);
		process.stderr.write(`[quarterdeck] diagnostic journal degraded: ${error.message.slice(0, 500)}\n`);
	}

	private recordBrowserCandidate(
		clientId: string,
		candidate: BrowserDiagnosticCandidate,
	): DiagnosticRecordEnvelope | null {
		const receivedAt = Date.now();
		return this.record({
			source: "browser",
			kind: candidate.kind,
			level: candidate.level,
			name: candidate.name,
			context: { ...candidate.context, clientId },
			payload: {
				clientSequence: candidate.clientSequence,
				clientTimestamp: candidate.timestamp,
				transportDelayMs: Math.max(0, receivedAt - candidate.timestamp),
				data: candidate.payload,
			},
			essential: candidate.level === "warn" || candidate.level === "error",
		});
	}

	private enforceRecordSize(record: DiagnosticRecordEnvelope): void {
		const initialBytes = Buffer.byteLength(JSON.stringify(record));
		if (initialBytes <= this.maxRecordBytes) return;
		record.payload = {
			omitted: "record_size_limit",
			originalBytes: initialBytes,
		};
		record.truncation = combineTruncation(record.truncation, {
			strings: 0,
			arrays: 0,
			objects: 1,
			depth: 0,
			redacted: 0,
			totalBytes: initialBytes,
		});
	}

	private retain(record: DiagnosticRecordEnvelope): void {
		if (this.records.length < this.memoryCapacity) {
			this.records.push(record);
			return;
		}
		const lowPriorityIndex = this.records.findIndex((candidate) => !isHighPriority(candidate));
		if (!isHighPriority(record) && lowPriorityIndex < 0) {
			this.droppedRecords += 1;
			this.droppedSinceReport += 1;
			return;
		}
		this.records.splice(lowPriorityIndex >= 0 ? lowPriorityIndex : 0, 1);
		this.records.push(record);
	}

	private maybeReportDrops(): void {
		if (this.droppedSinceReport === 0 || this.isReportingDrops) return;
		const dropped = this.droppedSinceReport;
		this.droppedSinceReport = 0;
		this.isReportingDrops = true;
		try {
			this.record({
				source: "runtime",
				kind: "recorder_health",
				level: "warn",
				name: "diagnostics.records_dropped",
				payload: { dropped },
				essential: true,
			});
		} finally {
			this.isReportingDrops = false;
		}
	}

	private handleRecordingStateChange(state: DiagnosticRecordingState): void {
		const previous = this.previousRecordingState;
		this.previousRecordingState = state;
		if (!previous.active && state.active) {
			this.recordEvent("diagnostics.recording_started", state, {}, { level: "info", essential: true });
		} else if (previous.active && !state.active) {
			const expired = previous.expiresAt !== null && previous.expiresAt <= Date.now();
			this.recordEvent(
				expired ? "diagnostics.recording_expired" : "diagnostics.recording_stopped",
				{},
				{},
				{
					level: "info",
					essential: true,
				},
			);
		}
		for (const listener of this.recordingListeners) {
			try {
				listener(state);
			} catch {
				// Diagnostics UI listeners cannot affect policy.
			}
		}
	}
}
