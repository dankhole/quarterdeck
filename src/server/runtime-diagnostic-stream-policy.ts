import type { DiagnosticRecordEnvelope } from "../core";

export const MAX_PENDING_DIAGNOSTIC_STREAM_RECORDS = 64;

export function isHighPriorityDiagnosticRecord(record: DiagnosticRecordEnvelope): boolean {
	return (
		record.level === "warn" || record.level === "error" || record.kind === "recorder_health" || record.kind === "mark"
	);
}
