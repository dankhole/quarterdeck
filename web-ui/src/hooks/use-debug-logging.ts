import { useCallback, useEffect, useMemo, useState } from "react";

import { setDebugLogging } from "@/runtime/runtime-config-query";
import type { RuntimeDebugLogEntry } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { registerClientLogCallback, setClientLoggingEnabled } from "@/utils/client-logger";
import { setGlobalErrorCallback } from "@/utils/global-error-capture";

export type DebugLogLevelFilter = "all" | "debug" | "info" | "warn" | "error";
export type DebugLogSourceFilter = "all" | "server" | "client";

export interface UseDebugLoggingResult {
	debugLoggingEnabled: boolean;
	isDebugLogPanelOpen: boolean;
	filteredEntries: RuntimeDebugLogEntry[];
	entryCount: number;
	levelFilter: DebugLogLevelFilter;
	sourceFilter: DebugLogSourceFilter;
	searchText: string;
	showConsoleCapture: boolean;
	isToggling: boolean;
	/** All unique tags seen in the current log entries. */
	availableTags: string[];
	/** Tags currently disabled (filtered out). */
	disabledTags: Set<string>;
	toggleDebugLogging: () => void;
	openDebugLogPanel: () => void;
	closeDebugLogPanel: () => void;
	toggleDebugLogPanel: () => void;
	stopLogging: () => void;
	clearLogEntries: () => void;
	setLevelFilter: (level: DebugLogLevelFilter) => void;
	setSourceFilter: (source: DebugLogSourceFilter) => void;
	setSearchText: (text: string) => void;
	setShowConsoleCapture: (show: boolean) => void;
	toggleTag: (tag: string) => void;
	enableAllTags: () => void;
	disableAllTags: () => void;
	addClientLogEntry: (level: RuntimeDebugLogEntry["level"], tag: string, message: string, data?: unknown) => void;
}

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let clientEntryId = 0;

function loadDisabledTags(): Set<string> {
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

function persistDisabledTags(tags: Set<string>): void {
	writeLocalStorageItem(LocalStorageKey.DebugLogDisabledTags, JSON.stringify([...tags]));
}

export function useDebugLogging({
	currentProjectId,
	debugLoggingEnabled,
	debugLogEntries,
}: {
	currentProjectId: string | null;
	debugLoggingEnabled: boolean;
	debugLogEntries: RuntimeDebugLogEntry[];
}): UseDebugLoggingResult {
	const [isDebugLogPanelOpen, setIsDebugLogPanelOpen] = useState(false);
	const [levelFilter, setLevelFilter] = useState<DebugLogLevelFilter>("all");
	const [sourceFilter, setSourceFilter] = useState<DebugLogSourceFilter>("all");
	const [searchText, setSearchText] = useState("");
	// Console-intercepted entries (React dev warnings, library noise, etc.) are hidden
	// by default. Users opt in via the "Show console" toggle in the filter bar.
	const [showConsoleCapture, setShowConsoleCapture] = useState(false);
	const [isToggling, setIsToggling] = useState(false);
	const [clientEntries, setClientEntries] = useState<RuntimeDebugLogEntry[]>([]);
	const [clearedAt, setClearedAt] = useState(0);
	const [disabledTags, setDisabledTags] = useState<Set<string>>(loadDisabledTags);

	const allEntries = useMemo(() => {
		const serverEntries = clearedAt > 0 ? debugLogEntries.filter((e) => e.timestamp > clearedAt) : debugLogEntries;
		const clientVisible = clearedAt > 0 ? clientEntries.filter((e) => e.timestamp > clearedAt) : clientEntries;
		if (clientVisible.length === 0) return serverEntries;
		return [...serverEntries, ...clientVisible].sort((a, b) => a.timestamp - b.timestamp);
	}, [debugLogEntries, clientEntries, clearedAt]);

	const availableTags = useMemo(() => {
		const tags = new Set<string>();
		for (const entry of allEntries) {
			tags.add(entry.tag);
		}
		return [...tags].sort();
	}, [allEntries]);

	const filteredEntries = useMemo(() => {
		let entries = allEntries;
		if (!showConsoleCapture) {
			entries = entries.filter((e) => e.tag !== "console");
		}
		if (disabledTags.size > 0) {
			entries = entries.filter((e) => !disabledTags.has(e.tag));
		}
		if (levelFilter !== "all") {
			const minOrder = LEVEL_ORDER[levelFilter] ?? 0;
			entries = entries.filter((e) => (LEVEL_ORDER[e.level] ?? 0) >= minOrder);
		}
		if (sourceFilter !== "all") {
			entries = entries.filter((e) => e.source === sourceFilter);
		}
		if (searchText.trim()) {
			const lower = searchText.toLowerCase();
			entries = entries.filter(
				(e) =>
					e.message.toLowerCase().includes(lower) ||
					e.tag.toLowerCase().includes(lower) ||
					(typeof e.data === "string" && e.data.toLowerCase().includes(lower)),
			);
		}
		return entries;
	}, [allEntries, showConsoleCapture, disabledTags, levelFilter, sourceFilter, searchText]);

	const toggleTag = useCallback((tag: string) => {
		setDisabledTags((prev) => {
			const next = new Set(prev);
			if (next.has(tag)) {
				next.delete(tag);
			} else {
				next.add(tag);
			}
			persistDisabledTags(next);
			return next;
		});
	}, []);

	const enableAllTags = useCallback(() => {
		setDisabledTags(new Set());
		persistDisabledTags(new Set());
	}, []);

	const disableAllTags = useCallback(() => {
		const all = new Set<string>();
		for (const entry of allEntries) {
			all.add(entry.tag);
		}
		persistDisabledTags(all);
		setDisabledTags(all);
	}, [allEntries]);

	const toggleDebugLogging = useCallback(() => {
		if (isToggling) return;
		setIsToggling(true);
		void setDebugLogging(currentProjectId, !debugLoggingEnabled)
			.catch(() => {
				// Best effort.
			})
			.finally(() => setIsToggling(false));
	}, [currentProjectId, debugLoggingEnabled, isToggling]);

	const openDebugLogPanel = useCallback(() => {
		setIsDebugLogPanelOpen(true);
		if (!debugLoggingEnabled && !isToggling) {
			setIsToggling(true);
			void setDebugLogging(currentProjectId, true)
				.catch(() => {})
				.finally(() => setIsToggling(false));
		}
	}, [currentProjectId, debugLoggingEnabled, isToggling]);

	const closeDebugLogPanel = useCallback(() => setIsDebugLogPanelOpen(false), []);

	/** Disable server-side logging and close the panel. */
	const stopLogging = useCallback(() => {
		setIsDebugLogPanelOpen(false);
		// Immediately disable client-side capture so entries don't accumulate
		// during the server round-trip.
		setClientLoggingEnabled(false);
		registerClientLogCallback(null);
		setGlobalErrorCallback(null);
		if (debugLoggingEnabled && !isToggling) {
			setIsToggling(true);
			void setDebugLogging(currentProjectId, false)
				.catch(() => {})
				.finally(() => setIsToggling(false));
		}
	}, [currentProjectId, debugLoggingEnabled, isToggling]);

	const toggleDebugLogPanel = useCallback(() => {
		setIsDebugLogPanelOpen((open) => {
			if (!open && !debugLoggingEnabled && !isToggling) {
				setIsToggling(true);
				void setDebugLogging(currentProjectId, true)
					.catch(() => {})
					.finally(() => setIsToggling(false));
			}
			return !open;
		});
	}, [currentProjectId, debugLoggingEnabled, isToggling]);

	const clearLogEntries = useCallback(() => {
		setClearedAt(Date.now());
		setClientEntries([]);
	}, []);

	const addClientLogEntry = useCallback(
		(level: RuntimeDebugLogEntry["level"], tag: string, message: string, data?: unknown) => {
			if (!debugLoggingEnabled) return;
			const entry: RuntimeDebugLogEntry = {
				id: `c${++clientEntryId}`,
				timestamp: Date.now(),
				level,
				tag,
				message,
				data,
				source: "client",
			};
			setClientEntries((prev) => [...prev, entry].slice(-500));
		},
		[debugLoggingEnabled],
	);

	// Wire the client-side logger module so it pushes entries to our state.
	useEffect(() => {
		setClientLoggingEnabled(debugLoggingEnabled);
		if (debugLoggingEnabled) {
			registerClientLogCallback(addClientLogEntry);
			setGlobalErrorCallback(addClientLogEntry);
		} else {
			registerClientLogCallback(null);
			setGlobalErrorCallback(null);
		}
		return () => {
			registerClientLogCallback(null);
			setGlobalErrorCallback(null);
			setClientLoggingEnabled(false);
		};
	}, [debugLoggingEnabled, addClientLogEntry]);

	return {
		debugLoggingEnabled,
		isDebugLogPanelOpen,
		filteredEntries,
		entryCount: allEntries.length,
		levelFilter,
		sourceFilter,
		searchText,
		showConsoleCapture,
		isToggling,
		availableTags,
		disabledTags,
		toggleDebugLogging,
		openDebugLogPanel,
		closeDebugLogPanel,
		toggleDebugLogPanel,
		stopLogging,
		clearLogEntries,
		setLevelFilter,
		setSourceFilter,
		setSearchText,
		setShowConsoleCapture,
		toggleTag,
		enableAllTags,
		disableAllTags,
		addClientLogEntry,
	};
}
