import { afterEach, describe, expect, it } from "vitest";

import { BROWSER_DIAGNOSTIC_STORAGE_KEY, BrowserDiagnosticRecordQueue } from "@/diagnostics/browser-record-queue";
import type { BrowserDiagnosticCandidate } from "@/runtime/types";

function candidate(sequence: number, level: BrowserDiagnosticCandidate["level"] = "info"): BrowserDiagnosticCandidate {
	return {
		version: 1,
		clientSequence: sequence,
		timestamp: Date.now(),
		kind: "event",
		level,
		name: `browser.test-${sequence}`,
		context: {},
		payload: {},
	};
}

describe("BrowserDiagnosticRecordQueue", () => {
	const queues: BrowserDiagnosticRecordQueue[] = [];

	afterEach(() => {
		for (const queue of queues) queue.reset();
		queues.length = 0;
		sessionStorage.clear();
	});

	function createQueue(): BrowserDiagnosticRecordQueue {
		const queue = new BrowserDiagnosticRecordQueue();
		queues.push(queue);
		return queue;
	}

	it("preserves warning evidence ahead of routine records when bounded", () => {
		const queue = createQueue();
		for (let sequence = 1; sequence <= 100; sequence += 1) {
			expect(queue.enqueue(candidate(sequence))).toBe(true);
		}
		expect(queue.enqueue(candidate(101, "warn"))).toBe(true);

		expect(queue.count).toBe(100);
		expect(queue.getRecords().some((record) => record.clientSequence === 1)).toBe(false);
		expect(queue.getRecords().some((record) => record.clientSequence === 101)).toBe(true);
		expect(queue.takeDroppedCount()).toBe(1);
	});

	it("validates and bounds an untrusted persisted reconnect tail", () => {
		sessionStorage.setItem(
			BROWSER_DIAGNOSTIC_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				storedAt: Date.now(),
				records: [
					candidate(3, "warn"),
					candidate(1),
					{ ...candidate(2), level: "not-a-level" },
					candidate(3, "error"),
				],
			}),
		);
		const queue = createQueue();
		queue.initialize();

		expect(queue.getRecords().map((record) => record.clientSequence)).toEqual([1, 3]);
		expect(queue.allocateSequence()).toBe(4);
	});
});
