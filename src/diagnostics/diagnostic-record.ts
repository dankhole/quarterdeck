import type {
	DiagnosticCaptureScope,
	DiagnosticContext,
	DiagnosticLevel,
	DiagnosticRecordEnvelope,
	DiagnosticRecordKind,
	DiagnosticSource,
} from "../core";

export interface DiagnosticRecordCandidate {
	source: DiagnosticSource;
	kind: DiagnosticRecordKind;
	level: DiagnosticLevel;
	name: string;
	context?: DiagnosticContext;
	payload?: unknown;
	essential: boolean;
}

export interface DiagnosticLogCandidate {
	level: DiagnosticLevel;
	tag: string;
	message: string;
	data?: unknown;
}

export interface DiagnosticRecordFilter {
	projectId?: string;
	taskId?: string;
	sessionInstanceId?: string;
	operationId?: string;
	source?: DiagnosticSource;
	level?: DiagnosticLevel;
	name?: string;
	afterSequence?: number;
	since?: number;
	until?: number;
}

export function captureScopeFromRecordFilter(filter: DiagnosticRecordFilter = {}): DiagnosticCaptureScope {
	return {
		...(filter.projectId ? { projectId: filter.projectId } : {}),
		...(filter.taskId ? { taskId: filter.taskId } : {}),
		...(filter.sessionInstanceId ? { sessionInstanceId: filter.sessionInstanceId } : {}),
		...(filter.operationId ? { operationId: filter.operationId } : {}),
	};
}

export function matchesDiagnosticRecordFilter(
	record: DiagnosticRecordEnvelope,
	filter: DiagnosticRecordFilter,
): boolean {
	if (filter.afterSequence !== undefined && record.sequence <= filter.afterSequence) return false;
	if (filter.since !== undefined && record.timestamp < filter.since) return false;
	if (filter.until !== undefined && record.timestamp > filter.until) return false;
	if (filter.projectId && record.context.projectId !== filter.projectId) return false;
	if (filter.taskId && record.context.taskId !== filter.taskId) return false;
	if (filter.sessionInstanceId && record.context.sessionInstanceId !== filter.sessionInstanceId) return false;
	if (filter.operationId && record.context.operationId !== filter.operationId) return false;
	if (filter.source && record.source !== filter.source) return false;
	if (filter.level && record.level !== filter.level) return false;
	if (filter.name && record.name !== filter.name && !record.name.startsWith(`${filter.name}.`)) return false;
	return true;
}

/** Merge canonical record sources without making memory or disk authoritative alone. */
export function mergeDiagnosticRecordSources(
	sources: readonly (readonly DiagnosticRecordEnvelope[])[],
	filter: DiagnosticRecordFilter = {},
): DiagnosticRecordEnvelope[] {
	const byId = new Map<string, DiagnosticRecordEnvelope>();
	for (const source of sources) {
		for (const record of source) byId.set(record.id, record);
	}
	return Array.from(byId.values())
		.filter((record) => matchesDiagnosticRecordFilter(record, filter))
		.sort((left, right) => left.sequence - right.sequence)
		.map((record) => structuredClone(record));
}
