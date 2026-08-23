import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	type BrowserDiagnosticsState,
	clearBrowserDiagnosticView,
	exportBrowserDiagnosticBundle,
	getBrowserDiagnosticsSnapshot,
	refreshBrowserDiagnosticData,
	setBrowserDiagnosticsLiveSubscription,
	startBrowserDeepRecording,
	stopBrowserDeepRecording,
	subscribeBrowserDiagnostics,
} from "@/diagnostics";
import {
	type DiagnosticLevelFilter,
	type DiagnosticSourceFilter,
	extractDiagnosticNames,
	filterDiagnosticTimeline,
} from "@/hooks/diagnostics/diagnostics";
import { setLogLevel as setLogLevelOnServer } from "@/runtime/runtime-config-query";
import { setClientLogLevel } from "@/utils/client-logger";

export type DiagnosticConsoleLevel = BrowserDiagnosticsState["consoleLogLevel"];

export interface UseDiagnosticsResult {
	state: BrowserDiagnosticsState;
	isPanelOpen: boolean;
	filteredEntries: BrowserDiagnosticsState["timeline"];
	entryCount: number;
	availableNames: string[];
	levelFilter: DiagnosticLevelFilter;
	sourceFilter: DiagnosticSourceFilter;
	nameFilter: string;
	searchText: string;
	isRefreshing: boolean;
	isExporting: boolean;
	isChangingRecording: boolean;
	openPanel: () => void;
	closePanel: () => void;
	togglePanel: () => void;
	clearView: () => void;
	setLevelFilter: (level: DiagnosticLevelFilter) => void;
	setSourceFilter: (source: DiagnosticSourceFilter) => void;
	setNameFilter: (name: string) => void;
	setSearchText: (text: string) => void;
	setConsoleLogLevel: (level: DiagnosticConsoleLevel) => void;
	refresh: () => Promise<void>;
	exportBundle: () => Promise<void>;
	startDeepRecording: (durationMs?: number) => Promise<void>;
	stopDeepRecording: () => Promise<void>;
}

interface OptimisticConsoleLevel {
	level: DiagnosticConsoleLevel;
	requestId: number;
}

export function useDiagnostics(currentProjectId: string | null): UseDiagnosticsResult {
	const state = useSyncExternalStore(
		subscribeBrowserDiagnostics,
		getBrowserDiagnosticsSnapshot,
		getBrowserDiagnosticsSnapshot,
	);
	const [isPanelOpen, setIsPanelOpen] = useState(false);
	const [levelFilter, setLevelFilter] = useState<DiagnosticLevelFilter>("all");
	const [sourceFilter, setSourceFilter] = useState<DiagnosticSourceFilter>("all");
	const [nameFilter, setNameFilter] = useState("");
	const [searchText, setSearchText] = useState("");
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [isChangingRecording, setIsChangingRecording] = useState(false);
	const [optimisticConsoleLevel, setOptimisticConsoleLevel] = useState<OptimisticConsoleLevel | null>(null);
	const requestIdRef = useRef(0);
	const latestServerLevelRef = useRef(state.consoleLogLevel);
	const deferredTimeline = useDeferredValue(state.timeline);
	const deferredSearchText = useDeferredValue(searchText);
	const effectiveConsoleLevel = optimisticConsoleLevel?.level ?? state.consoleLogLevel;

	const availableNames = useMemo(() => extractDiagnosticNames(deferredTimeline), [deferredTimeline]);
	const filteredEntries = useMemo(
		() =>
			filterDiagnosticTimeline(deferredTimeline, {
				level: levelFilter,
				source: sourceFilter,
				name: nameFilter,
				searchText: deferredSearchText,
			}),
		[deferredSearchText, deferredTimeline, levelFilter, nameFilter, sourceFilter],
	);

	useEffect(() => {
		latestServerLevelRef.current = state.consoleLogLevel;
		setOptimisticConsoleLevel((current) => (current && current.level === state.consoleLogLevel ? null : current));
	}, [state.consoleLogLevel]);

	useEffect(() => {
		setClientLogLevel(effectiveConsoleLevel);
	}, [effectiveConsoleLevel]);

	useEffect(() => {
		if (!isPanelOpen || !state.connected || !state.diagnosticCapabilityReady || !state.runtimeInstanceId) return;
		const subscribedRuntimeInstanceId = state.runtimeInstanceId;
		let active = true;
		void setBrowserDiagnosticsLiveSubscription(true).catch((error: unknown) => {
			if (!active) return;
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not subscribe to live diagnostics",
			});
		});
		return () => {
			active = false;
			if (getBrowserDiagnosticsSnapshot().runtimeInstanceId === subscribedRuntimeInstanceId) {
				void setBrowserDiagnosticsLiveSubscription(false).catch(() => undefined);
			}
		};
	}, [isPanelOpen, state.connected, state.diagnosticCapabilityReady, state.runtimeInstanceId]);

	const setConsoleLogLevel = useCallback(
		(level: DiagnosticConsoleLevel) => {
			const requestId = ++requestIdRef.current;
			setOptimisticConsoleLevel({ level, requestId });
			setClientLogLevel(level);
			void setLogLevelOnServer(currentProjectId, level).then(
				(response) => {
					if (requestIdRef.current !== requestId) return;
					setClientLogLevel(response.level);
					setOptimisticConsoleLevel(null);
				},
				() => {
					if (requestIdRef.current !== requestId) return;
					setClientLogLevel(latestServerLevelRef.current);
					setOptimisticConsoleLevel(null);
					showAppToast({ intent: "danger", message: "Could not update console verbosity" });
				},
			);
		},
		[currentProjectId],
	);

	const refresh = useCallback(async () => {
		setIsRefreshing(true);
		try {
			await refreshBrowserDiagnosticData();
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not refresh diagnostics",
			});
		} finally {
			setIsRefreshing(false);
		}
	}, []);

	const exportBundle = useCallback(async () => {
		setIsExporting(true);
		try {
			const result = await exportBrowserDiagnosticBundle();
			showAppToast({ intent: "success", message: `Diagnostic bundle saved to ${result.path}`, timeout: 8_000 });
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not export diagnostics",
			});
		} finally {
			setIsExporting(false);
		}
	}, []);

	const startDeepRecording = useCallback(async (durationMs = 2 * 60_000) => {
		setIsChangingRecording(true);
		try {
			await startBrowserDeepRecording(durationMs);
			showAppToast({ intent: "success", message: "Deep diagnostics enabled for 2 minutes" });
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not start deep diagnostics",
			});
		} finally {
			setIsChangingRecording(false);
		}
	}, []);

	const stopDeepRecording = useCallback(async () => {
		setIsChangingRecording(true);
		try {
			await stopBrowserDeepRecording();
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not stop deep diagnostics",
			});
		} finally {
			setIsChangingRecording(false);
		}
	}, []);

	const openPanel = useCallback(() => {
		setIsPanelOpen(true);
		if (!state.remoteData && state.connected) void refresh();
	}, [refresh, state.connected, state.remoteData]);

	return {
		state: { ...state, consoleLogLevel: effectiveConsoleLevel },
		isPanelOpen,
		filteredEntries,
		entryCount: state.timeline.length,
		availableNames,
		levelFilter,
		sourceFilter,
		nameFilter,
		searchText,
		isRefreshing,
		isExporting,
		isChangingRecording,
		openPanel,
		closePanel: () => setIsPanelOpen(false),
		togglePanel: () => setIsPanelOpen((open) => !open),
		clearView: clearBrowserDiagnosticView,
		setLevelFilter,
		setSourceFilter,
		setNameFilter,
		setSearchText,
		setConsoleLogLevel,
		refresh,
		exportBundle,
		startDeepRecording,
		stopDeepRecording,
	};
}
