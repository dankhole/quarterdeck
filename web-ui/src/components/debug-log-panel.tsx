import { Bug, Trash2, X } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type { DebugLogLevelFilter, DebugLogSourceFilter } from "@/hooks/use-debug-logging";
import type { RuntimeDebugLogEntry } from "@/runtime/types";

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

export function DebugLogPanel({
	entries,
	entryCount,
	levelFilter,
	sourceFilter,
	searchText,
	onSetLevelFilter,
	onSetSourceFilter,
	onSetSearchText,
	onClear,
	onClose,
}: {
	entries: RuntimeDebugLogEntry[];
	entryCount: number;
	levelFilter: DebugLogLevelFilter;
	sourceFilter: DebugLogSourceFilter;
	searchText: string;
	onSetLevelFilter: (level: DebugLogLevelFilter) => void;
	onSetSourceFilter: (source: DebugLogSourceFilter) => void;
	onSetSearchText: (text: string) => void;
	onClear: () => void;
	onClose: () => void;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);

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

	return (
		<div
			className="flex flex-col border-t border-border bg-surface-0 min-w-0 overflow-hidden"
			style={{ height: 220 }}
		>
			{/* Header */}
			<div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-surface-1 shrink-0">
				<Bug size={14} className="text-text-secondary" />
				<span className="text-xs font-medium text-text-primary">Debug Log</span>
				<span className="text-xs text-text-tertiary">({entryCount})</span>

				<select
					value={levelFilter}
					onChange={(e) => onSetLevelFilter(e.target.value as DebugLogLevelFilter)}
					className="ml-2 text-xs bg-surface-2 border border-border rounded px-1 py-0.5 text-text-primary"
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
					className="text-xs bg-surface-2 border border-border rounded px-1.5 py-0.5 text-text-primary placeholder:text-text-tertiary w-32"
				/>

				<div className="flex-1" />

				<Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={onClear} aria-label="Clear logs" />
				<Button variant="ghost" size="sm" icon={<X size={14} />} onClick={onClose} aria-label="Close debug panel" />
			</div>

			{/* Log entries */}
			<div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
				{entries.length === 0 ? (
					<div className="flex items-center justify-center h-full text-xs text-text-tertiary">
						No log entries. Debug logging is active — entries will appear here.
					</div>
				) : (
					entries.map((entry) => <LogEntry key={entry.id} entry={entry} />)
				)}
			</div>
		</div>
	);
}
