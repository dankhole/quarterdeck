import { Bug, Monitor, Trash2, X } from "lucide-react";
import { type ReactElement, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { DebugLogLevelFilter, DebugLogSourceFilter, LogLevel } from "@/hooks/use-debug-logging";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeDebugLogEntry } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { dumpTerminalDebugInfo } from "@/terminal/terminal-pool";

const MIN_WIDTH = 280;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 420;

const DEBUG_LOG_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DebugLogPanelWidth,
	defaultValue: DEFAULT_WIDTH,
	normalize: (value) => clampBetween(value, MIN_WIDTH, MAX_WIDTH, true),
};

const LEVEL_COLORS: Record<string, string> = {
	debug: "text-text-tertiary",
	info: "text-status-blue",
	warn: "text-status-orange",
	error: "text-status-red",
};

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${h}:${m}:${s}.${ms}`;
}

function LogEntry({ entry }: { entry: RuntimeDebugLogEntry }): ReactElement {
	const levelColor = LEVEL_COLORS[entry.level] ?? "text-text-primary";
	const sourceLabel = entry.source === "client" ? "ui" : "";
	return (
		<div className="flex gap-2 px-2 py-0.5 text-xs font-mono leading-relaxed hover:bg-surface-2/50 min-w-0">
			<span className="text-text-tertiary shrink-0">{formatTimestamp(entry.timestamp)}</span>
			<span className={`shrink-0 uppercase w-[3ch] ${levelColor}`}>{entry.level.slice(0, 3)}</span>
			<span className="text-accent shrink-0">[{entry.tag}]</span>
			{sourceLabel ? <span className="text-status-purple shrink-0">{sourceLabel}</span> : null}
			<span className="text-text-primary min-w-0 break-words">
				{entry.message}
				{entry.data !== undefined && entry.data !== null ? (
					<span className="text-text-tertiary ml-1">
						{typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}
					</span>
				) : null}
			</span>
		</div>
	);
}

function TagFilterChip({
	tag,
	disabled,
	onToggle,
}: {
	tag: string;
	disabled: boolean;
	onToggle: (tag: string) => void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={() => onToggle(tag)}
			className={cn(
				"px-1.5 py-0 rounded text-[10px] font-mono leading-relaxed border transition-colors shrink-0",
				disabled
					? "bg-surface-1 text-text-tertiary border-border line-through opacity-50"
					: "bg-surface-2 text-accent border-border-bright hover:bg-surface-3",
			)}
		>
			{tag}
		</button>
	);
}

export function DebugLogPanel({
	entries,
	entryCount,
	logLevel,
	levelFilter,
	sourceFilter,
	searchText,
	showConsoleCapture,
	availableTags,
	disabledTags,
	onSetLogLevel,
	onSetLevelFilter,
	onSetSourceFilter,
	onSetSearchText,
	onSetShowConsoleCapture,
	onToggleTag,
	onEnableAllTags,
	onDisableAllTags,
	onClear,
	onClose,
}: {
	entries: RuntimeDebugLogEntry[];
	entryCount: number;
	logLevel: LogLevel;
	levelFilter: DebugLogLevelFilter;
	sourceFilter: DebugLogSourceFilter;
	searchText: string;
	showConsoleCapture: boolean;
	availableTags: string[];
	disabledTags: Set<string>;
	onSetLogLevel: (level: LogLevel) => void;
	onSetLevelFilter: (level: DebugLogLevelFilter) => void;
	onSetSourceFilter: (source: DebugLogSourceFilter) => void;
	onSetSearchText: (text: string) => void;
	onSetShowConsoleCapture: (show: boolean) => void;
	onToggleTag: (tag: string) => void;
	onEnableAllTags: () => void;
	onDisableAllTags: () => void;
	onClear: () => void;
	onClose: () => void;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);
	const [panelWidth, setPanelWidth] = useState(() => loadResizePreference(DEBUG_LOG_WIDTH_PREFERENCE));
	const { startDrag } = useResizeDrag();

	const handleResizeMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const startX = event.clientX;
			const startWidth = panelWidth;
			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					// Dragging left increases width (panel is on the right edge)
					const delta = startX - pointerX;
					const nextWidth = clampBetween(startWidth + delta, MIN_WIDTH, MAX_WIDTH, true);
					setPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const delta = startX - pointerX;
					const nextWidth = clampBetween(startWidth + delta, MIN_WIDTH, MAX_WIDTH, true);
					setPanelWidth(persistResizePreference(DEBUG_LOG_WIDTH_PREFERENCE, nextWidth));
				},
			});
		},
		[panelWidth, startDrag],
	);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const handleScroll = () => {
			isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
		};
		el.addEventListener("scroll", handleScroll);
		return () => el.removeEventListener("scroll", handleScroll);
	}, []);

	useEffect(() => {
		if (isAtBottomRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [entries]);

	const hasAnyDisabled = disabledTags.size > 0;

	return (
		<div className="flex shrink-0 h-full overflow-hidden">
			<ResizeHandle orientation="vertical" ariaLabel="Resize debug log panel" onMouseDown={handleResizeMouseDown} />
			<div className="flex flex-col bg-surface-0 h-full overflow-hidden" style={{ width: panelWidth }}>
				{/* Header */}
				<div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-surface-1 shrink-0">
					<Bug size={14} className="text-text-secondary" />
					<span className="text-xs font-medium text-text-primary whitespace-nowrap">Log</span>
					<span className="text-xs text-text-tertiary">({entryCount})</span>

					<span className="text-[10px] text-text-tertiary ml-1">capture:</span>
					<select
						value={logLevel}
						onChange={(e) => onSetLogLevel(e.target.value as LogLevel)}
						className="text-[11px] bg-surface-2 border border-border rounded px-1 py-0.5 text-text-primary"
						aria-label="Server log level"
					>
						<option value="debug">Debug</option>
						<option value="info">Info</option>
						<option value="warn">Warn</option>
						<option value="error">Error</option>
					</select>

					<div className="flex-1" />

					<Tooltip content="Dump terminal buffer state">
						<Button
							variant="ghost"
							size="sm"
							icon={<Monitor size={14} />}
							onClick={dumpTerminalDebugInfo}
							aria-label="Dump terminal buffer state"
						/>
					</Tooltip>
					<Tooltip content="Clear logs">
						<Button
							variant="ghost"
							size="sm"
							icon={<Trash2 size={14} />}
							onClick={onClear}
							aria-label="Clear logs"
						/>
					</Tooltip>
					<Tooltip content="Close panel">
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							onClick={onClose}
							aria-label="Close debug panel"
						/>
					</Tooltip>
				</div>

				{/* Filters */}
				<div className="flex items-center gap-1.5 px-2 py-1 border-b border-border bg-surface-1/50 shrink-0">
					<span className="text-[10px] text-text-tertiary">show:</span>
					<select
						value={levelFilter}
						onChange={(e) => onSetLevelFilter(e.target.value as DebugLogLevelFilter)}
						className="text-xs bg-surface-2 border border-border rounded px-1 py-0.5 text-text-primary"
					>
						<option value="all">All levels</option>
						<option value="debug">Debug+</option>
						<option value="info">Info+</option>
						<option value="warn">Warn+</option>
						<option value="error">Error</option>
					</select>

					<select
						value={sourceFilter}
						onChange={(e) => onSetSourceFilter(e.target.value as DebugLogSourceFilter)}
						className="text-xs bg-surface-2 border border-border rounded px-1 py-0.5 text-text-primary"
					>
						<option value="all">All sources</option>
						<option value="server">Server</option>
						<option value="client">Client</option>
					</select>

					<input
						type="text"
						placeholder="Filter..."
						value={searchText}
						onChange={(e) => onSetSearchText(e.target.value)}
						className="flex-1 text-xs bg-surface-2 border border-border rounded px-1.5 py-0.5 text-text-primary placeholder:text-text-tertiary min-w-0"
					/>

					<Tooltip content="Show intercepted console.warn/error from libraries and React">
						<label className="flex items-center gap-1 text-xs text-text-secondary cursor-pointer whitespace-nowrap select-none">
							<input
								type="checkbox"
								checked={showConsoleCapture}
								onChange={(e) => onSetShowConsoleCapture(e.target.checked)}
								className="accent-accent"
							/>
							Console
						</label>
					</Tooltip>
				</div>

				{/* Tag filter chips */}
				{availableTags.length > 0 ? (
					<div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-surface-1/30 shrink-0 flex-wrap">
						<span className="text-[10px] text-text-tertiary mr-0.5 shrink-0">Tags:</span>
						{availableTags.map((tag) => (
							<TagFilterChip key={tag} tag={tag} disabled={disabledTags.has(tag)} onToggle={onToggleTag} />
						))}
						{hasAnyDisabled ? (
							<button
								type="button"
								onClick={onEnableAllTags}
								className="text-[10px] text-accent hover:text-accent-hover ml-1 shrink-0"
							>
								show all
							</button>
						) : (
							<button
								type="button"
								onClick={onDisableAllTags}
								className="text-[10px] text-text-tertiary hover:text-text-secondary ml-1 shrink-0"
							>
								hide all
							</button>
						)}
					</div>
				) : null}

				{/* Log entries */}
				<div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
					{entries.length === 0 ? (
						<div className="flex items-center justify-center h-full text-xs text-text-tertiary">
							No log entries yet. Set a lower log level to capture more.
						</div>
					) : (
						entries.map((entry) => <LogEntry key={entry.id} entry={entry} />)
					)}
				</div>
			</div>
		</div>
	);
}
