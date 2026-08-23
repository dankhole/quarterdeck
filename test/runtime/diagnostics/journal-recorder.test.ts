import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticRecordEnvelope } from "../../../src/core";
import { DiagnosticJournal, DiagnosticRecorder, readDiagnosticJournal } from "../../../src/diagnostics";

function record(sequence: number, payload: unknown = {}): DiagnosticRecordEnvelope {
	return {
		version: 1,
		id: `runtime:${sequence}`,
		sequence,
		timestamp: 1_000 + sequence,
		monotonicOffsetMs: sequence,
		runtimeInstanceId: "runtime",
		source: "runtime",
		kind: "event",
		level: "info",
		name: "test.record",
		context: {},
		payload,
	};
}

describe("diagnostic journal and recorder", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-diagnostics-journal-"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await rm(directory, { recursive: true, force: true });
	});

	it("rotates bounded JSONL segments and reads them in sequence order", async () => {
		const journal = new DiagnosticJournal(directory, {
			segmentMaxBytes: 360,
			segmentCount: 2,
			flushRecordCount: 100,
			flushIntervalMs: 60_000,
		});
		for (let sequence = 1; sequence <= 8; sequence += 1) {
			expect(journal.enqueue(record(sequence, { value: "x".repeat(90) })).queued).toBe(true);
		}
		await journal.close();

		const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
		expect(files).toHaveLength(2);
		const result = await readDiagnosticJournal(directory);
		expect(result.records.length).toBeGreaterThan(0);
		expect(result.records.at(-1)?.sequence).toBe(8);
		expect(result.records.map((entry) => entry.sequence)).toEqual(
			[...result.records.map((entry) => entry.sequence)].sort((left, right) => left - right),
		);
	});

	it("evicts queued low-priority records before dropping a warning", async () => {
		const journal = new DiagnosticJournal(directory, {
			maxPendingRecords: 2,
			flushRecordCount: 100,
			flushIntervalMs: 60_000,
		});
		expect(journal.enqueue(record(1))).toEqual({ queued: true, dropped: 0 });
		expect(journal.enqueue(record(2))).toEqual({ queued: true, dropped: 0 });
		expect(journal.enqueue({ ...record(3), level: "warn" })).toEqual({ queued: true, dropped: 1 });
		await journal.close();

		const retained = await readDiagnosticJournal(directory);
		expect(retained.records.map((entry) => entry.sequence)).toEqual([2, 3]);
	});

	it("flushes multiple records with one append operation per segment", async () => {
		const journal = new DiagnosticJournal(directory, {
			segmentMaxBytes: 100_000,
			flushRecordCount: 100,
			flushIntervalMs: 60_000,
		});
		for (let sequence = 1; sequence <= 20; sequence += 1) journal.enqueue(record(sequence));
		await journal.close();

		expect(journal.getHealth().appendOperations).toBe(1);
	});

	it("salvages valid records before a partial crash tail", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 1 });
		journal.enqueue(record(1));
		await journal.flush();
		const segment = (await readdir(directory)).find((file) => file.endsWith(".jsonl"));
		expect(segment).toBeDefined();
		await appendFile(join(directory, segment ?? ""), '{"partial":', "utf8");
		await journal.close();

		const result = await readDiagnosticJournal(directory);
		expect(result.records.map((entry) => entry.sequence)).toEqual([1]);
		expect(result.warnings.some((warning) => warning.includes("partial crash tail"))).toBe(true);
	});

	it("separates always-on admission from scoped deep recording", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal });

		expect(recorder.recordLog({ level: "debug", tag: "git", message: "detail" })).toBeNull();
		expect(recorder.recordLog({ level: "warn", tag: "git", message: "failed" })).not.toBeNull();
		recorder.startRecording(60_000, { projectId: "p1", categories: ["session.start"] });
		expect(
			recorder.record({
				source: "runtime",
				kind: "event",
				level: "debug",
				name: "session.start.prepared",
				context: { projectId: "p1" },
				payload: {},
				essential: false,
			}),
		).not.toBeNull();
		expect(
			recorder.record({
				source: "runtime",
				kind: "event",
				level: "debug",
				name: "session.stop",
				context: { projectId: "p1" },
				payload: {},
				essential: false,
			}),
		).toBeNull();
		expect(
			recorder.record({
				source: "runtime",
				kind: "event",
				level: "debug",
				name: "session.start.prepared",
				context: { projectId: "p2" },
				payload: {},
				essential: false,
			}),
		).toBeNull();
		await recorder.close();
	});

	it("keeps arbitrary generic log content out of the production flight recorder", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal });
		const retained = recorder.recordLog({
			level: "error",
			tag: "git",
			message: "sentinel private task text",
			data: { arbitrary: "sentinel private diff content" },
		});

		expect(JSON.stringify(retained)).not.toContain("sentinel private");
		expect(retained?.payload).toEqual({
			tag: "git",
			messageLength: "sentinel private task text".length,
			dataSummary: { type: "object", fieldCount: 1 },
		});
		await recorder.close();
	});

	it("admits rich records automatically for the isolated synthetic lab profile", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({
			runtimeInstanceId: "runtime",
			journal,
			admissionProfile: "agent-lab",
		});

		const retained = recorder.recordLog({
			level: "debug",
			tag: "git",
			message: "synthetic detail",
			data: { fixture: "synthetic data" },
		});
		expect(retained?.payload).toMatchObject({ message: "synthetic detail", data: { fixture: "synthetic data" } });
		expect(recorder.getRecordingState()).toMatchObject({ active: true, expiresAt: null });
		expect(recorder.stopRecording()).toMatchObject({ active: true, expiresAt: null });
		await recorder.close();
	});

	it("deduplicates browser delivery sequences and rejects malformed candidates", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal });
		recorder.startRecording(60_000, { categories: ["browser"] });
		const candidate = {
			version: 1,
			clientSequence: 1,
			timestamp: Date.now(),
			kind: "event",
			level: "info",
			name: "browser.clicked",
			context: {},
			payload: { target: "button" },
		};
		const first = recorder.ingestBrowserRecords("client-1", [candidate, { invalid: true }]);
		const second = recorder.ingestBrowserRecords("client-1", [candidate]);
		expect(first).toMatchObject({ accepted: 1, rejected: 1, duplicate: 0, highestAcceptedSequence: 1 });
		expect(second).toMatchObject({ accepted: 0, rejected: 0, duplicate: 1, highestAcceptedSequence: 1 });
		expect(recorder.getHealth().rejectedBrowserRecords).toBe(1);
		const retained = recorder.getRecentRecords({ source: "browser" });
		expect(retained).toHaveLength(1);
		expect(retained[0]?.payload).toMatchObject({
			clientSequence: 1,
			clientTimestamp: candidate.timestamp,
			data: { target: "button" },
		});
		await recorder.close();
	});

	it("preserves high-priority evidence when the memory ring is saturated", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal, memoryCapacity: 2 });
		recorder.recordEvent("first.warning", {}, {}, { level: "warn", essential: true });
		recorder.recordEvent("second.warning", {}, {}, { level: "warn", essential: true });
		recorder.recordEvent("low.priority", {}, {}, { level: "info", essential: true });
		const retained = recorder.getRecentRecords();
		expect(retained.some((entry) => entry.name === "low.priority")).toBe(false);
		expect(retained.some((entry) => entry.name === "diagnostics.records_dropped")).toBe(true);
		expect(recorder.getHealth().droppedRecords).toBeGreaterThan(0);
		await recorder.close();
	});

	it("collects the persisted journal together with the bounded memory tail", async () => {
		const journal = new DiagnosticJournal(directory, { flushRecordCount: 100, flushIntervalMs: 60_000 });
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal, memoryCapacity: 2 });
		recorder.recordEvent("first", {}, { projectId: "p1" }, { level: "warn", essential: true });
		recorder.recordEvent("second", {}, { projectId: "p1" }, { level: "warn", essential: true });
		await recorder.flush();
		recorder.recordEvent("third", {}, { projectId: "p1" }, { level: "warn", essential: true });

		expect(recorder.getRecentRecords().map((entry) => entry.name)).not.toContain("first");
		const capture = await recorder.collectCaptureRecords({ projectId: "p1" });
		expect(capture.records.map((entry) => entry.name)).toEqual(["first", "second", "third"]);
		expect(capture.warnings).toEqual([]);
		await recorder.close();
	});

	it("keeps in-memory evidence when journal storage is unavailable", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const blockedPath = join(directory, "not-a-directory");
		await writeFile(blockedPath, "blocked", "utf8");
		const failures: Error[] = [];
		let recorder: DiagnosticRecorder | null = null;
		const journal = new DiagnosticJournal(join(blockedPath, "journal"), {
			flushRecordCount: 1,
			onFailure: (error) => {
				failures.push(error);
				recorder?.reportJournalFailure(error);
			},
		});
		await expect(journal.initialize()).resolves.toBeUndefined();
		recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime", journal });
		if (failures[0]) recorder.reportJournalFailure(failures[0]);
		recorder.recordEvent("runtime.degraded", {}, {}, { level: "warn", essential: true });
		await expect(recorder.flush()).resolves.toBeUndefined();

		expect(recorder.getRecentRecords().map((entry) => entry.name)).toContain("runtime.degraded");
		expect(recorder.getRecentRecords().map((entry) => entry.name)).toContain("diagnostics.journal_write_failed");
		expect(recorder.getHealth().journalHealthy).toBe(false);
		expect(failures.length).toBeGreaterThan(0);
		await expect(recorder.close()).resolves.toBeUndefined();
		stderr.mockRestore();
	});

	it("recovers journal health after a transient storage failure", async () => {
		vi.useFakeTimers();
		const blockedPath = join(directory, "temporarily-blocked");
		await writeFile(blockedPath, "blocked", "utf8");
		const journal = new DiagnosticJournal(join(blockedPath, "journal"), {
			flushRecordCount: 100,
			flushIntervalMs: 60_000,
			retryInitialMs: 10,
			retryMaxMs: 10,
		});
		journal.enqueue(record(1));
		await journal.flush();
		expect(journal.getHealth().healthy).toBe(false);

		await rm(blockedPath);
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		await vi.waitFor(() => {
			expect(journal.getHealth()).toMatchObject({ healthy: true, failureCount: 1, recoveryDroppedRecords: 0 });
		});
		expect(
			(await readDiagnosticJournal(join(blockedPath, "journal"))).records.map((entry) => entry.sequence),
		).toEqual([1]);
		await journal.close();
	});
});
