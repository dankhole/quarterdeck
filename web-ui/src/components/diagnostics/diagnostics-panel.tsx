import { Activity, Download, RefreshCw, Trash2, X } from "lucide-react";
import { type ReactElement, type MouseEvent as ReactMouseEvent, useCallback, useState } from "react";

import {
	DiagnosticsCapture,
	DiagnosticsHealth,
	DiagnosticsSystem,
} from "@/components/diagnostics/diagnostics-inspection";
import { DiagnosticsTimeline } from "@/components/diagnostics/diagnostics-timeline";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { DiagnosticLevelFilter, DiagnosticSourceFilter, UseDiagnosticsResult } from "@/hooks/diagnostics";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { LocalStorageKey } from "@/storage/local-storage-store";

const MIN_WIDTH = 380;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 560;

const WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DiagnosticsPanelWidth,
	defaultValue: DEFAULT_WIDTH,
	normalize: (value) => clampBetween(value, MIN_WIDTH, MAX_WIDTH, true),
};

type DiagnosticsTab = "timeline" | "health" | "system" | "capture";

const TABS: Array<{ id: DiagnosticsTab; label: string }> = [
	{ id: "timeline", label: "Timeline" },
	{ id: "health", label: "Health" },
	{ id: "system", label: "System" },
	{ id: "capture", label: "Capture" },
];

export function DiagnosticsPanel({ diagnostics }: { diagnostics: UseDiagnosticsResult }): ReactElement {
	const [activeTab, setActiveTab] = useState<DiagnosticsTab>("timeline");
	const [panelWidth, setPanelWidth] = useState(() => loadResizePreference(WIDTH_PREFERENCE));
	const { startDrag } = useResizeDrag();
	const handleResizeMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const startX = event.clientX;
			const startWidth = panelWidth;
			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) =>
					setPanelWidth(clampBetween(startWidth + startX - pointerX, MIN_WIDTH, MAX_WIDTH, true)),
				onEnd: (pointerX) =>
					setPanelWidth(
						persistResizePreference(
							WIDTH_PREFERENCE,
							clampBetween(startWidth + startX - pointerX, MIN_WIDTH, MAX_WIDTH, true),
						),
					),
			});
		},
		[panelWidth, startDrag],
	);

	return (
		<div className="flex h-full shrink-0 overflow-hidden border-l border-border" data-testid="diagnostics-panel">
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize diagnostics panel"
				onMouseDown={handleResizeMouseDown}
			/>
			<aside className="flex h-full flex-col overflow-hidden bg-surface-0" style={{ width: panelWidth }}>
				<header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2 py-1">
					<Activity size={14} className={diagnostics.state.connected ? "text-status-green" : "text-status-red"} />
					<span className="text-xs font-medium text-text-primary">Diagnostics</span>
					<span className="text-[10px] text-text-tertiary">
						{diagnostics.state.connected ? "connected" : "offline"} · {diagnostics.entryCount} records
						{diagnostics.state.pendingCount ? ` · ${diagnostics.state.pendingCount} pending` : ""}
					</span>
					<div className="flex-1" />
					<Tooltip content="Refresh health and subsystem snapshots">
						<Button
							variant="ghost"
							size="sm"
							icon={diagnostics.isRefreshing ? <Spinner size={13} /> : <RefreshCw size={14} />}
							disabled={!diagnostics.state.connected || diagnostics.isRefreshing}
							onClick={() => void diagnostics.refresh()}
							aria-label="Refresh diagnostics"
						/>
					</Tooltip>
					<Tooltip content="Export a diagnostic bundle">
						<Button
							variant="ghost"
							size="sm"
							icon={diagnostics.isExporting ? <Spinner size={13} /> : <Download size={14} />}
							disabled={!diagnostics.state.connected || diagnostics.isExporting}
							onClick={() => void diagnostics.exportBundle()}
							aria-label="Export diagnostics"
						/>
					</Tooltip>
					<Tooltip content="Clear this view (retained evidence is not deleted)">
						<Button
							variant="ghost"
							size="sm"
							icon={<Trash2 size={14} />}
							onClick={diagnostics.clearView}
							aria-label="Clear diagnostic view"
						/>
					</Tooltip>
					<Tooltip content="Close diagnostics">
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							onClick={diagnostics.closePanel}
							aria-label="Close diagnostics"
						/>
					</Tooltip>
				</header>
				<div className="flex shrink-0 items-center border-b border-border bg-surface-1/60 px-2 pt-1">
					{TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={cn(
								"border-b-2 px-2 py-1.5 text-xs transition-colors",
								activeTab === tab.id
									? "border-accent text-text-primary"
									: "border-transparent text-text-tertiary hover:text-text-secondary",
							)}
						>
							{tab.label}
						</button>
					))}
				</div>
				{activeTab === "timeline" ? (
					<>
						<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface-1/40 p-2">
							<select
								value={diagnostics.levelFilter}
								onChange={(event) => diagnostics.setLevelFilter(event.target.value as DiagnosticLevelFilter)}
								aria-label="Diagnostic level filter"
								className="rounded border border-border bg-surface-2 px-1 py-0.5 text-xs text-text-primary"
							>
								<option value="all">All levels</option>
								<option value="debug">Debug+</option>
								<option value="info">Info+</option>
								<option value="warn">Warn+</option>
								<option value="error">Errors</option>
							</select>
							<select
								value={diagnostics.sourceFilter}
								onChange={(event) => diagnostics.setSourceFilter(event.target.value as DiagnosticSourceFilter)}
								aria-label="Diagnostic source filter"
								className="rounded border border-border bg-surface-2 px-1 py-0.5 text-xs text-text-primary"
							>
								<option value="all">All sources</option>
								<option value="runtime">Runtime</option>
								<option value="browser">Browser</option>
								<option value="agent-lab">Agent lab</option>
							</select>
							<select
								value={diagnostics.nameFilter}
								onChange={(event) => diagnostics.setNameFilter(event.target.value)}
								aria-label="Diagnostic event filter"
								className="min-w-0 max-w-44 rounded border border-border bg-surface-2 px-1 py-0.5 text-xs text-text-primary"
							>
								<option value="">All events</option>
								{diagnostics.availableNames.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
							<input
								value={diagnostics.searchText}
								onChange={(event) => diagnostics.setSearchText(event.target.value)}
								placeholder="Search metadata…"
								aria-label="Search diagnostics"
								className="min-w-24 flex-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-text-primary placeholder:text-text-tertiary"
							/>
						</div>
						<DiagnosticsTimeline
							records={diagnostics.filteredEntries}
							emptyMessage={
								diagnostics.entryCount
									? "No diagnostic records match these filters."
									: "No records yet. The bounded flight recorder is always active; deeper debug events appear during a recording window."
							}
						/>
						<div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-2 py-1">
							<span className="text-[10px] text-text-tertiary">Console verbosity:</span>
							<select
								value={diagnostics.state.consoleLogLevel}
								onChange={(event) =>
									diagnostics.setConsoleLogLevel(
										event.target.value as UseDiagnosticsResult["state"]["consoleLogLevel"],
									)
								}
								aria-label="Console verbosity"
								className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-text-primary"
							>
								<option value="debug">Debug</option>
								<option value="info">Info</option>
								<option value="warn">Warn</option>
								<option value="error">Error</option>
							</select>
							<span className="text-[10px] text-text-tertiary">
								This only changes terminal/browser console output.
							</span>
						</div>
					</>
				) : null}
				{activeTab === "health" ? <DiagnosticsHealth state={diagnostics.state} /> : null}
				{activeTab === "system" ? <DiagnosticsSystem state={diagnostics.state} /> : null}
				{activeTab === "capture" ? (
					<DiagnosticsCapture
						state={diagnostics.state}
						isExporting={diagnostics.isExporting}
						isChangingRecording={diagnostics.isChangingRecording}
						onExport={() => void diagnostics.exportBundle()}
						onStartRecording={() => void diagnostics.startDeepRecording()}
						onStopRecording={() => void diagnostics.stopDeepRecording()}
					/>
				) : null}
			</aside>
		</div>
	);
}
