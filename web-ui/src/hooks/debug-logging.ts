import type { RuntimeDebugLogEntry } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export type DebugLogLevelFilter = "all" | "debug" | "info" | "warn" | "error";
export type DebugLogSourceFilter = "all" | "server" | "client";
export type LogLevel = "debug" | "info" | "warn" | "error";

export const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function loadDisabledTags(): Set<string> {
	const raw = readLocalStorageItem(LocalStorageKey.DebugLogDisabledTags);
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return new Set(parsed.filter((t): t is string => typeof t === "string"));
	} catch {
		// Ignore malformed data.
	}
	return new Set();
}

export function persistDisabledTags(tags: Set<string>): void {
	writeLocalStorageItem(LocalStorageKey.DebugLogDisabledTags, JSON.stringify([...tags]));
}

export function mergeLogEntries(
	serverEntries: RuntimeDebugLogEntry[],
	clientEntries: RuntimeDebugLogEntry[],
	clearedAt: number,
): RuntimeDebugLogEntry[] {
	const server = clearedAt > 0 ? serverEntries.filter((e) => e.timestamp > clearedAt) : serverEntries;
	const client = clearedAt > 0 ? clientEntries.filter((e) => e.timestamp > clearedAt) : clientEntries;
	if (client.length === 0) return server;
	return [...server, ...client].sort((a, b) => a.timestamp - b.timestamp);
}

export function extractAvailableTags(entries: RuntimeDebugLogEntry[]): string[] {
	const tags = new Set<string>();
	for (const entry of entries) {
		tags.add(entry.tag);
	}
	return [...tags].sort();
}

export function filterLogEntries(
	entries: RuntimeDebugLogEntry[],
	options: {
		showConsoleCapture: boolean;
		disabledTags: Set<string>;
		levelFilter: DebugLogLevelFilter;
		sourceFilter: DebugLogSourceFilter;
		searchText: string;
	},
): RuntimeDebugLogEntry[] {
	let filtered = entries;
	if (!options.showConsoleCapture) {
		filtered = filtered.filter((e) => e.tag !== "console");
	}
	if (options.disabledTags.size > 0) {
		filtered = filtered.filter((e) => !options.disabledTags.has(e.tag));
	}
	if (options.levelFilter !== "all") {
		const minOrder = LEVEL_ORDER[options.levelFilter] ?? 0;
		filtered = filtered.filter((e) => (LEVEL_ORDER[e.level] ?? 0) >= minOrder);
	}
	if (options.sourceFilter !== "all") {
		filtered = filtered.filter((e) => e.source === options.sourceFilter);
	}
	if (options.searchText.trim()) {
		const lower = options.searchText.toLowerCase();
		filtered = filtered.filter(
			(e) =>
				e.message.toLowerCase().includes(lower) ||
				e.tag.toLowerCase().includes(lower) ||
				(typeof e.data === "string" && e.data.toLowerCase().includes(lower)),
		);
	}
	return filtered;
}
