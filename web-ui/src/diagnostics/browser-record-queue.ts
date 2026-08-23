import { browserDiagnosticCandidateSchema } from "@runtime-contract";

import type { BrowserDiagnosticCandidate } from "@/runtime/types";

export const BROWSER_DIAGNOSTIC_STORAGE_KEY = "quarterdeck.diagnostics.browser-tail.v1";
const STORAGE_MAX_AGE_MS = 24 * 60 * 60_000;
const STORAGE_MAX_BYTES = 256 * 1_024;
const MAX_PENDING_RECORDS = 100;
const MAX_BROWSER_RECORD_BYTES = 8 * 1_024;
const TAIL_PERSIST_INTERVAL_MS = 250;

interface StoredTail {
	version: 1;
	storedAt: number;
	records: BrowserDiagnosticCandidate[];
}

function isHighPriorityCandidate(candidate: BrowserDiagnosticCandidate): boolean {
	return candidate.level === "warn" || candidate.level === "error" || candidate.kind === "mark";
}

export function boundBrowserCandidate(candidate: BrowserDiagnosticCandidate): BrowserDiagnosticCandidate {
	const serializedBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
	if (serializedBytes <= MAX_BROWSER_RECORD_BYTES) return candidate;
	return {
		...candidate,
		payload: { omitted: "record_size_limit", originalBytes: serializedBytes },
	};
}

export class BrowserDiagnosticRecordQueue {
	private records: BrowserDiagnosticCandidate[] = [];
	private nextClientSequence = 0;
	private droppedRecords = 0;
	private persistTimer: number | null = null;

	get count(): number {
		return this.records.length;
	}

	initialize(): void {
		this.records = this.loadStoredTail();
		this.nextClientSequence = this.records.reduce((highest, record) => Math.max(highest, record.clientSequence), 0);
	}

	allocateSequence(): number {
		this.nextClientSequence += 1;
		return this.nextClientSequence;
	}

	enqueue(rawCandidate: BrowserDiagnosticCandidate): boolean {
		const candidate = boundBrowserCandidate(rawCandidate);
		if (this.records.length >= MAX_PENDING_RECORDS) {
			const replaceableIndex = isHighPriorityCandidate(candidate)
				? this.records.findIndex((record) => !isHighPriorityCandidate(record))
				: -1;
			if (replaceableIndex < 0) {
				this.droppedRecords += 1;
				return false;
			}
			this.records.splice(replaceableIndex, 1);
			this.droppedRecords += 1;
		}
		this.records.push(candidate);
		if (isHighPriorityCandidate(candidate)) this.persistNow();
		else this.schedulePersistence();
		return true;
	}

	getRecords(): readonly BrowserDiagnosticCandidate[] {
		return this.records;
	}

	getPendingBatch(maximum: number): BrowserDiagnosticCandidate[] {
		return this.records.slice(0, maximum);
	}

	acknowledge(highestAcceptedSequence: number): void {
		if (highestAcceptedSequence > 0) {
			this.records = this.records.filter((record) => record.clientSequence > highestAcceptedSequence);
		}
		this.persistNow();
	}

	takeDroppedCount(): number {
		const dropped = this.droppedRecords;
		this.droppedRecords = 0;
		return dropped;
	}

	persistNow = (): void => {
		if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
		this.persistTimer = null;
		try {
			let storedRecords = this.records.slice(-MAX_PENDING_RECORDS);
			while (storedRecords.length > 0) {
				const serialized = JSON.stringify({
					version: 1,
					storedAt: Date.now(),
					records: storedRecords,
				} satisfies StoredTail);
				if (serialized.length * 2 <= STORAGE_MAX_BYTES) {
					sessionStorage.setItem(BROWSER_DIAGNOSTIC_STORAGE_KEY, serialized);
					return;
				}
				storedRecords = storedRecords.slice(1);
			}
			sessionStorage.removeItem(BROWSER_DIAGNOSTIC_STORAGE_KEY);
		} catch {
			// A blocked/full sessionStorage must not affect the application.
		}
	};

	reset(): void {
		if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
		this.records = [];
		this.nextClientSequence = 0;
		this.droppedRecords = 0;
		this.persistTimer = null;
	}

	private schedulePersistence(): void {
		if (this.persistTimer !== null) return;
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null;
			this.persistNow();
		}, TAIL_PERSIST_INTERVAL_MS);
	}

	private loadStoredTail(): BrowserDiagnosticCandidate[] {
		try {
			const raw = sessionStorage.getItem(BROWSER_DIAGNOSTIC_STORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw) as Partial<StoredTail>;
			if (parsed.version !== 1 || typeof parsed.storedAt !== "number" || !Array.isArray(parsed.records)) return [];
			if (Date.now() - parsed.storedAt > STORAGE_MAX_AGE_MS) return [];
			const now = Date.now();
			const candidates = parsed.records
				.flatMap((record) => {
					const candidate = browserDiagnosticCandidateSchema.safeParse(record);
					return candidate.success ? [boundBrowserCandidate(candidate.data)] : [];
				})
				.filter((record) => now - record.timestamp <= STORAGE_MAX_AGE_MS && record.timestamp <= now + 60_000)
				.sort((left, right) => left.clientSequence - right.clientSequence);
			const bySequence = new Map(candidates.map((candidate) => [candidate.clientSequence, candidate]));
			return Array.from(bySequence.values()).slice(-MAX_PENDING_RECORDS);
		} catch {
			return [];
		}
	}
}
