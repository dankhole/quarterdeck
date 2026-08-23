import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, type ReactElement, useMemo, useRef } from "react";

import type { BrowserDiagnosticTimelineRecord } from "@/diagnostics";
import { formatDiagnosticPayload } from "@/hooks/diagnostics/diagnostics";

const ROW_HEIGHT = 42;
const ROW_OVERSCAN = 20;

const LEVEL_COLORS: Record<BrowserDiagnosticTimelineRecord["level"], string> = {
	debug: "text-text-tertiary",
	info: "text-status-blue",
	warn: "text-status-orange",
	error: "text-status-red",
};

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

const DiagnosticTimelineRow = memo(function DiagnosticTimelineRow({
	record,
}: {
	record: BrowserDiagnosticTimelineRecord;
}): ReactElement {
	const payload = useMemo(() => formatDiagnosticPayload(record.payload), [record.payload]);
	const context = useMemo(
		() =>
			Object.entries(record.context)
				.map(([key, value]) => `${key}=${value}`)
				.join(" "),
		[record.context],
	);
	return (
		<div className="border-b border-border/60 px-2 py-1 font-mono text-[11px] leading-4 hover:bg-surface-2/50">
			<div className="flex min-w-0 items-center gap-2">
				<span className="shrink-0 text-text-tertiary">{formatTimestamp(record.timestamp)}</span>
				<span className={`w-[3ch] shrink-0 uppercase ${LEVEL_COLORS[record.level]}`}>
					{record.level.slice(0, 3)}
				</span>
				<span className="w-[3.5rem] shrink-0 text-status-purple">{record.source}</span>
				<span className="min-w-0 truncate text-accent" title={record.name}>
					{record.name}
				</span>
				{record.pending ? (
					<span className="shrink-0 rounded bg-status-orange/15 px-1 text-[9px] uppercase text-status-orange">
						pending
					</span>
				) : null}
			</div>
			{context || payload ? (
				<div
					className="mt-0.5 min-w-0 truncate pl-[13.1rem] text-text-tertiary"
					title={[context, payload].filter(Boolean).join(" ")}
				>
					{context ? <span className="mr-1 text-text-secondary">{context}</span> : null}
					{payload}
				</div>
			) : null}
		</div>
	);
});

export function DiagnosticsTimeline({
	records,
	emptyMessage,
}: {
	records: readonly BrowserDiagnosticTimelineRecord[];
	emptyMessage: string;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: records.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: ROW_OVERSCAN,
		getItemKey: (index) => records[index]?.id ?? index,
		measureElement: (element) => element.getBoundingClientRect().height,
	});

	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
			{records.length === 0 ? (
				<div className="flex h-full items-center justify-center px-5 text-center text-xs text-text-tertiary">
					{emptyMessage}
				</div>
			) : (
				<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
					{virtualizer.getVirtualItems().map((item) => {
						const record = records[item.index];
						if (!record) return null;
						return (
							<div
								key={item.key}
								data-index={item.index}
								ref={virtualizer.measureElement}
								className="absolute left-0 top-0 w-full"
								style={{ transform: `translateY(${item.start}px)` }}
							>
								<DiagnosticTimelineRow record={record} />
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
