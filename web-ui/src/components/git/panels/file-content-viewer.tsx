import { useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, Clipboard, Code, Copy, FileText, WrapText, X } from "lucide-react";
import Prism from "prismjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyToClipboard } from "@/components/git/panels/context-menu-utils";
import {
	createHighlightedLineCache,
	resolvePrismGrammar,
	resolvePrismLanguage,
	resolvePrismLanguageByAlias,
} from "@/components/shared/syntax-highlighting";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

const LINE_HEIGHT = 20;
const REMARK_PLUGINS = [remarkGfm];

function isMarkdownFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

function isSelectAllKey(event: React.KeyboardEvent): boolean {
	return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";
}

function MarkdownCodeBlock({
	className,
	children,
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }): React.ReactElement {
	const match = /language-(\w+)/.exec(className ?? "");
	if (!match) {
		return <code className={className}>{children}</code>;
	}
	const language = resolvePrismLanguageByAlias(match[1]!);
	const grammar = resolvePrismGrammar(language);
	if (!grammar || !language) {
		return <code className={className}>{children}</code>;
	}
	const code = String(children ?? "").replace(/\n$/, "");
	const html = Prism.highlight(code, grammar, language);
	return <code className={cn(className, "kb-syntax")} dangerouslySetInnerHTML={{ __html: html }} />;
}

const MARKDOWN_COMPONENTS = { code: MarkdownCodeBlock };

export function FileContentViewer({
	content,
	binary,
	truncated,
	isLoading,
	isError,
	filePath,
	onClose,
	scrollToLine,
	onScrollToLineConsumed,
}: {
	content: string | null;
	binary: boolean;
	truncated: boolean;
	isLoading: boolean;
	isError: boolean;
	filePath: string | null;
	onClose?: () => void;
	scrollToLine?: number | null;
	onScrollToLineConsumed?: () => void;
}): React.ReactElement {
	const [wordWrap, setWordWrap] = useBooleanLocalStorageValue(LocalStorageKey.FileBrowserWordWrap, true);
	const toggleWordWrap = useCallback(() => setWordWrap((prev) => !prev), [setWordWrap]);

	const [markdownPreview, setMarkdownPreview] = useBooleanLocalStorageValue(
		LocalStorageKey.FileBrowserMarkdownPreview,
		true,
	);
	const toggleMarkdownPreview = useCallback(() => setMarkdownPreview((prev) => !prev), [setMarkdownPreview]);

	const isMarkdown = filePath ? isMarkdownFile(filePath) : false;
	const showRendered = isMarkdown && markdownPreview;

	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const [sourceViewportNode, setSourceViewportNode] = useState<HTMLDivElement | null>(null);
	const [sourceViewportWidth, setSourceViewportWidth] = useState(0);

	const prismLanguage = useMemo(() => (filePath ? resolvePrismLanguage(filePath) : null), [filePath]);
	const prismGrammar = useMemo(() => resolvePrismGrammar(prismLanguage), [prismLanguage]);
	const highlightCache = useMemo(
		() => createHighlightedLineCache(prismGrammar, prismLanguage),
		[content, prismGrammar, prismLanguage],
	);

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

	const maxLineLength = useMemo(() => {
		return lines.reduce((max, line) => Math.max(max, line.length), 1);
	}, [lines]);

	const virtualizer = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => LINE_HEIGHT,
		overscan: 40,
		// When word wrap is on, lines can exceed the fixed LINE_HEIGHT.
		// Use dynamic measurement so the virtualizer calculates correct positions.
		measureElement: wordWrap ? (element: Element) => element.getBoundingClientRect().height : undefined,
	});

	const setScrollContainerNode = useCallback((node: HTMLDivElement | null) => {
		scrollContainerRef.current = node;
		setSourceViewportNode(node);
		setSourceViewportWidth(node?.clientWidth ?? 0);
	}, []);

	useEffect(() => {
		const node = sourceViewportNode;
		if (!node || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? node.clientWidth;
			setSourceViewportWidth(width);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [sourceViewportNode]);

	// Clear stale row heights when wrap mode changes in either direction.
	useEffect(() => {
		virtualizer.measure();
	}, [wordWrap, virtualizer]);

	// Re-measure wrapped items when the viewport width changes so stale row
	// heights do not preserve old wrap points after panel resize.
	useEffect(() => {
		if (wordWrap) {
			virtualizer.measure();
		}
	}, [sourceViewportWidth, wordWrap, virtualizer]);

	useEffect(() => {
		if (scrollToLine == null || lines.length === 0) return;
		const index = scrollToLine - 1;
		if (index >= 0 && index < lines.length) {
			virtualizer.scrollToIndex(index, { align: "center" });
		}
		onScrollToLineConsumed?.();
	}, [scrollToLine, lines.length, virtualizer, onScrollToLineConsumed]);

	const handleCopyPath = useCallback(() => {
		if (!filePath) {
			return;
		}
		copyToClipboard(filePath, "Path");
	}, [filePath]);

	const handleCopyContent = useCallback(() => {
		if (content == null) {
			return;
		}
		copyToClipboard(content, "File contents");
	}, [content]);

	const handleSourceSelectionKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!isSelectAllKey(event)) {
			return;
		}
		event.preventDefault();
		event.currentTarget.select();
	}, []);

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

	if (isError) {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
				<div className="flex flex-col items-center gap-3">
					<FileText size={40} />
					<span className="text-sm">Failed to load file</span>
				</div>
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
				{isMarkdown ? (
					<Tooltip content={markdownPreview ? "Show source" : "Preview markdown"}>
						<button
							type="button"
							aria-label={markdownPreview ? "Show source" : "Preview markdown"}
							onClick={toggleMarkdownPreview}
							className={cn(
								"shrink-0 p-0.5 rounded",
								markdownPreview ? "text-accent" : "text-text-tertiary hover:text-text-secondary",
							)}
						>
							{markdownPreview ? <Code size={13} /> : <BookOpen size={13} />}
						</button>
					</Tooltip>
				) : null}
				<Tooltip content="Copy file contents">
					<button
						type="button"
						aria-label="Copy file contents"
						onClick={handleCopyContent}
						disabled={content == null}
						className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
					>
						<Copy size={13} />
					</button>
				</Tooltip>
				<Tooltip content="Copy path">
					<button
						type="button"
						aria-label="Copy path"
						onClick={handleCopyPath}
						className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
					>
						<Clipboard size={13} />
					</button>
				</Tooltip>
				{!showRendered ? (
					<Tooltip content={wordWrap ? "Disable word wrap" : "Enable word wrap"}>
						<button
							type="button"
							aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
							onClick={toggleWordWrap}
							className={cn(
								"shrink-0 p-0.5 rounded",
								wordWrap ? "text-accent" : "text-text-tertiary hover:text-text-secondary",
							)}
						>
							<WrapText size={13} />
						</button>
					</Tooltip>
				) : null}
				{onClose ? (
					<Tooltip content="Close file">
						<button
							type="button"
							aria-label="Close file"
							onClick={onClose}
							className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
						>
							<X size={13} />
						</button>
					</Tooltip>
				) : null}
			</div>
			{truncated ? (
				<div className="flex items-center gap-2 px-3 py-1 text-xs bg-status-orange text-surface-0">
					File truncated — showing first 1MB
				</div>
			) : null}
			{showRendered ? (
				<div className="flex-1 min-h-0 overflow-auto overscroll-contain">
					<div className="kb-markdown-rendered px-6 py-4">
						<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
							{content ?? ""}
						</Markdown>
					</div>
				</div>
			) : (
				<div ref={setScrollContainerNode} className="flex-1 min-h-0 overflow-auto overscroll-contain">
					<div
						className="kb-file-content-source-shell relative w-full"
						style={{
							height: Math.max(virtualizer.getTotalSize(), lines.length > 0 ? LINE_HEIGHT : 0),
							minWidth: wordWrap ? "100%" : `max(100%, calc(${gutterWidth}px + ${maxLineLength}ch))`,
						}}
					>
						<textarea
							aria-label={`${filePath} content`}
							className="kb-file-content-selection-layer font-mono text-xs"
							data-word-wrap={wordWrap ? "true" : "false"}
							readOnly
							spellCheck={false}
							value={content ?? ""}
							wrap={wordWrap ? "soft" : "off"}
							onKeyDown={handleSourceSelectionKeyDown}
							style={{
								left: gutterWidth,
								width: wordWrap
									? `calc(100% - ${gutterWidth}px)`
									: `max(calc(100% - ${gutterWidth}px), ${maxLineLength}ch)`,
								height: Math.max(virtualizer.getTotalSize(), lines.length > 0 ? LINE_HEIGHT : 0),
								lineHeight: `${LINE_HEIGHT}px`,
							}}
						/>
						<div className="kb-file-content-display-layer" aria-hidden="true">
							{virtualizer.getVirtualItems().map((virtualItem) => {
								const lineNumber = virtualItem.index + 1;
								const line = lines[virtualItem.index] ?? "";
								const highlightedHtml = highlightCache.get(line);
								return (
									<div
										key={virtualItem.key}
										data-index={virtualItem.index}
										ref={wordWrap ? virtualizer.measureElement : undefined}
										className="absolute top-0 left-0 w-full flex font-mono text-xs"
										style={{
											...(wordWrap ? { minHeight: LINE_HEIGHT } : { height: LINE_HEIGHT }),
											transform: `translateY(${virtualItem.start}px)`,
											lineHeight: `${LINE_HEIGHT}px`,
										}}
									>
										<span
											className="select-none text-right text-text-tertiary shrink-0 pr-3 pl-2"
											style={{ width: gutterWidth }}
										>
											{lineNumber}
										</span>
										{highlightedHtml ? (
											<span
												className={cn(
													"text-text-primary pr-4 kb-syntax min-w-0 flex-1",
													wordWrap ? "kb-file-content-wrapped-line" : "whitespace-pre",
												)}
												dangerouslySetInnerHTML={{ __html: highlightedHtml }}
											/>
										) : (
											<span
												className={cn(
													"text-text-primary pr-4 min-w-0 flex-1",
													wordWrap ? "kb-file-content-wrapped-line" : "whitespace-pre",
												)}
											>
												{line || " "}
											</span>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
