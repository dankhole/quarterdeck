import type { BrowserDiagnosticTimelineRecord } from "@/diagnostics";

export type DiagnosticLevelFilter = "all" | "debug" | "info" | "warn" | "error";
export type DiagnosticSourceFilter = "all" | BrowserDiagnosticTimelineRecord["source"];

export interface DiagnosticTimelineFilters {
	level: DiagnosticLevelFilter;
	source: DiagnosticSourceFilter;
	name: string;
	searchText: string;
}

const LEVEL_SEVERITY: Record<BrowserDiagnosticTimelineRecord["level"], number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

function searchablePayload(payload: unknown): string {
	if (payload === null || payload === undefined) return "";
	if (typeof payload === "string") return payload;
	try {
		return JSON.stringify(payload);
	} catch {
		return String(payload);
	}
}

export function extractDiagnosticNames(records: readonly BrowserDiagnosticTimelineRecord[]): string[] {
	return Array.from(new Set(records.map((record) => record.name))).sort((left, right) => left.localeCompare(right));
}

export function filterDiagnosticTimeline(
	records: readonly BrowserDiagnosticTimelineRecord[],
	filters: DiagnosticTimelineFilters,
): BrowserDiagnosticTimelineRecord[] {
	const search = filters.searchText.trim().toLocaleLowerCase();
	const minimumLevel = filters.level === "all" ? -1 : LEVEL_SEVERITY[filters.level];
	return records.filter((record) => {
		if (LEVEL_SEVERITY[record.level] < minimumLevel) return false;
		if (filters.source !== "all" && record.source !== filters.source) return false;
		if (filters.name && record.name !== filters.name) return false;
		if (!search) return true;
		const context = Object.values(record.context).join(" ");
		return `${record.name} ${context} ${searchablePayload(record.payload)}`.toLocaleLowerCase().includes(search);
	});
}

export function formatDiagnosticPayload(payload: unknown, maxCharacters = 4_000): string | null {
	if (payload === null || payload === undefined) return null;
	const serialized = searchablePayload(payload);
	if (serialized.length <= maxCharacters) return serialized;
	return `${serialized.slice(0, maxCharacters)}…`;
}
