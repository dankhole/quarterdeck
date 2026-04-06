import { useVirtualizer } from "@tanstack/react-virtual";
import { Clipboard, FileText, WrapText } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";

const LINE_HEIGHT = 20;

export function FileContentViewer({
	content,
	binary,
	truncated,
	isLoading,
	filePath,
}: {
	content: string | null;
	binary: boolean;
	truncated: boolean;
	isLoading: boolean;
	filePath: string | null;
}): React.ReactElement {
	const [wordWrap, setWordWrap] = useState(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	const lines = useMemo(() => {
		if (!content) {
			return [];
		}
		const rawLines = content.split("\n");
		if (content.endsWith("\n") && rawLines.length > 0) {
			rawLines.pop();
		}
		return rawLines;
	}, [content]);

	const gutterWidth = useMemo(() => {
		const digits = String(lines.length).length;
		return Math.max(digits * 8 + 20, 40);
	}, [lines.length]);

	const virtualizer = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => LINE_HEIGHT,
		overscan: 40,
	});

	const handleCopyPath = useCallback(() => {
		if (!filePath) {
			return;
		}
		void navigator.clipboard.writeText(filePath).then(() => {
			toast.success("Path copied to clipboard");
		});
	}, [filePath]);

	if (!filePath) {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
				<div className="flex flex-col items-center gap-3">
					<FileText size={40} />
					<span className="text-sm">Select a file to view</span>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-1">
				<Spinner size={24} />
			</div>
		);
	}

	if (binary) {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
				<div className="flex flex-col items-center gap-3">
					<FileText size={40} />
					<span className="text-sm">Binary file — cannot display</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col min-w-0 min-h-0 bg-surface-1">
			{/* Breadcrumb bar */}
			<div className="flex items-center gap-1.5 px-3 py-1 text-xs text-text-secondary border-b border-border min-h-7">
				<span className="truncate flex-1 font-mono" title={filePath}>
					{filePath}
				</span>
				<Tooltip content="Copy path">
					<button
						type="button"
						onClick={handleCopyPath}
						className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
					>
						<Clipboard size={13} />
					</button>
				</Tooltip>
				<Tooltip content={wordWrap ? "Disable word wrap" : "Enable word wrap"}>
					<button
						type="button"
						onClick={() => setWordWrap((prev) => !prev)}
						className={`shrink-0 p-0.5 rounded ${wordWrap ? "text-accent" : "text-text-tertiary hover:text-text-secondary"}`}
					>
						<WrapText size={13} />
					</button>
				</Tooltip>
			</div>
			{truncated ? (
				<div className="flex items-center gap-2 px-3 py-1 text-xs bg-status-orange text-surface-0">
					File truncated — showing first 1MB
				</div>
			) : null}
			<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto overscroll-contain">
				<div
					style={{
						height: virtualizer.getTotalSize(),
						width: "100%",
						position: "relative",
					}}
				>
					{virtualizer.getVirtualItems().map((virtualItem) => {
						const lineNumber = virtualItem.index + 1;
						const line = lines[virtualItem.index] ?? "";
						return (
							<div
								key={lineNumber}
								className="flex font-mono"
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: LINE_HEIGHT,
									transform: `translateY(${virtualItem.start}px)`,
									fontSize: 12,
									lineHeight: `${LINE_HEIGHT}px`,
								}}
							>
								<span
									className="select-none text-right text-text-tertiary shrink-0"
									style={{
										width: gutterWidth,
										paddingRight: 12,
										paddingLeft: 8,
									}}
								>
									{lineNumber}
								</span>
								<span
									className="text-text-primary pr-4"
									style={{
										whiteSpace: wordWrap ? "pre-wrap" : "pre",
										wordBreak: wordWrap ? "break-all" : undefined,
									}}
								>
									{line || " "}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
