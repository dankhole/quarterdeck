import { describe, expect, it } from "vitest";

import type { BrowserDiagnosticTimelineRecord } from "@/diagnostics";
import {
	extractDiagnosticNames,
	filterDiagnosticTimeline,
	formatDiagnosticPayload,
} from "@/hooks/diagnostics/diagnostics";

function record(id: string, overrides: Partial<BrowserDiagnosticTimelineRecord> = {}): BrowserDiagnosticTimelineRecord {
	return {
		id,
		timestamp: Number(id),
		level: "info",
		source: "runtime",
		kind: "event",
		name: "session.started",
		context: {},
		payload: {},
		pending: false,
		...overrides,
	};
}

describe("diagnostic timeline domain", () => {
	it("filters by severity threshold, source, exact event name, and metadata search", () => {
		const records = [
			record("1", { level: "debug", source: "runtime", name: "session.started" }),
			record("2", {
				level: "warn",
				source: "browser",
				name: "terminal.restore_failed",
				context: { taskId: "task-2" },
				payload: { errorClass: "TimeoutError" },
			}),
			record("3", { level: "error", source: "runtime", name: "terminal.restore_failed" }),
		];
		expect(
			filterDiagnosticTimeline(records, {
				level: "warn",
				source: "browser",
				name: "terminal.restore_failed",
				searchText: "timeout",
			}),
		).toEqual([records[1]]);
	});

	it("extracts stable names and bounds rendered payloads", () => {
		const records = [record("1", { name: "z" }), record("2", { name: "a" }), record("3", { name: "z" })];
		expect(extractDiagnosticNames(records)).toEqual(["a", "z"]);
		expect(formatDiagnosticPayload({ value: "x".repeat(100) }, 20)).toHaveLength(21);
		expect(formatDiagnosticPayload(null)).toBeNull();
	});
});
