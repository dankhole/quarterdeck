import { useCallback, useEffect, useMemo, useState } from "react";

import { setLogLevel as setLogLevelOnServer } from "@/runtime/runtime-config-query";
import type { RuntimeDebugLogEntry } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { registerClientLogCallback, setClientLoggingEnabled } from "@/utils/client-logger";
import { setGlobalErrorCallback } from "@/utils/global-error-capture";

export type DebugLogLevelFilter = "all" | "debug" | "info" | "warn" | "error";
export type DebugLogSourceFilter = "all" | "server" | "client";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface UseDebugLoggingResult {
	logLevel: LogLevel;
	isDebugLogPanelOpen: boolean;
	filteredEntries: RuntimeDebugLogEntry[];
	entryCount: number;
	levelFilter: DebugLogLevelFilter;
	sourceFilter: DebugLogSourceFilter;
	searchText: string;
	showConsoleCapture: boolean;
	/** All unique tags seen in the current log entries. */
	availableTags: string[];
	/** Tags currently disabled (filtered out). */
	disabledTags: Set<string>;
	setLogLevel: (level: LogLevel) => void;
	openDebugLogPanel: () => void;
	closeDebugLogPanel: () => void;
	toggleDebugLogPanel: () => void;
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
	logLevel,
	debugLogEntries,
}: {
	currentProjectId: string | null;
	logLevel: LogLevel;
	debugLogEntries: RuntimeDebugLogEntry[];
}): UseDebugLoggingResult {
	const [isDebugLogPanelOpen, setIsDebugLogPanelOpen] = useState(false);
	const [levelFilter, setLevelFilter] = useState<DebugLogLevelFilter>("all");
	const [sourceFilter, setSourceFilter] = useState<DebugLogSourceFilter>("all");
	const [searchText, setSearchText] = useState("");
	// Console-intercepted entries (React dev warnings, library noise, etc.) are hidden
	// by default. Users opt in via the "Show console" toggle in the filter bar.
	const [showConsoleCapture, setShowConsoleCapture] = useState(false);
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

	// Change the persisted log level on the server.
	const setLogLevelAction = useCallback(
		(level: LogLevel) => {
			void setLogLevelOnServer(currentProjectId, level).catch(() => {
				// Best effort.
			});
		},
		[currentProjectId],
	);

	const openDebugLogPanel = useCallback(() => setIsDebugLogPanelOpen(true), []);
	const closeDebugLogPanel = useCallback(() => setIsDebugLogPanelOpen(false), []);
	const toggleDebugLogPanel = useCallback(() => setIsDebugLogPanelOpen((open) => !open), []);

	const clearLogEntries = useCallback(() => {
		setClearedAt(Date.now());
		setClientEntries([]);
	}, []);

	const addClientLogEntry = useCallback(
		(level: RuntimeDebugLogEntry["level"], tag: string, message: string, data?: unknown) => {
			if (!isDebugLogPanelOpen) return;
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
		[isDebugLogPanelOpen],
	);

	// Wire the client-side logger module when the panel is open.
	useEffect(() => {
		if (isDebugLogPanelOpen) {
			setClientLoggingEnabled(true);
			registerClientLogCallback(addClientLogEntry);
			setGlobalErrorCallback(addClientLogEntry);
		} else {
			setClientLoggingEnabled(false);
			registerClientLogCallback(null);
			setGlobalErrorCallback(null);
		}
		return () => {
			registerClientLogCallback(null);
			setGlobalErrorCallback(null);
			setClientLoggingEnabled(false);
		};
	}, [isDebugLogPanelOpen, addClientLogEntry]);

	return {
		logLevel,
		isDebugLogPanelOpen,
		filteredEntries,
		entryCount: allEntries.length,
		levelFilter,
		sourceFilter,
		searchText,
		showConsoleCapture,
		availableTags,
		disabledTags,
		setLogLevel: setLogLevelAction,
		openDebugLogPanel,
		closeDebugLogPanel,
		toggleDebugLogPanel,
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
