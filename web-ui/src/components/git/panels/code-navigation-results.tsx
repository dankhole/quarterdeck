import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, FileCode2, ListTree, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import {
	CODE_NAVIGATION_LABELS,
	type CodeNavigationReferencesOptions,
	type CodeNavigationResult,
	groupCodeNavigationLocations,
} from "@/hooks/git/code-navigation";
import type { CodeNavigationLocation } from "@/runtime/types";
import { type CodeNavigationFileReader, CodeNavigationPreview } from "./code-navigation-preview";

export function CodeNavigationResults({
	result,
	onDismiss,
	onNavigate,
	readFile,
	onRestoreFocus,
	referencesOptions,
}: {
	result: CodeNavigationResult;
	referencesOptions?: CodeNavigationReferencesOptions;
	onDismiss: () => void;
	onNavigate: (location: CodeNavigationLocation) => void;
	readFile?: CodeNavigationFileReader;
	/** Restore the invoking editor/diff, even when a context-menu item originally held focus. */
	onRestoreFocus?: () => void;
}): React.ReactElement {
	const [invoker] = useState(() => document.activeElement);
	const navigatingRef = useRef(false);
	const contentRef = useRef<HTMLDivElement>(null);
	const groups = useMemo(
		() => groupCodeNavigationLocations(result.status === "locations" ? result.locations : []),
		[result],
	);
	const locations = useMemo(() => Array.from(groups.values()).flat(), [groups]);
	const [selection, setSelection] = useState<CodeNavigationLocation | null>(null);
	const selectedIndex = Math.max(
		0,
		locations.findIndex(
			(location) =>
				location.path === selection?.path &&
				location.range.start.line === selection.range.start.line &&
				location.range.start.character === selection.range.start.character &&
				location.range.end.line === selection.range.end.line &&
				location.range.end.character === selection.range.end.character,
		),
	);
	const toggleRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const selected = locations[selectedIndex];
	const resultId = useId();
	const listRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
	useEffect(() => {
		// A busy response can become a result list without remounting the popup.
		if (
			locations.length &&
			contentRef.current?.contains(document.activeElement) &&
			document.activeElement !== toggleRef.current
		)
			listRef.current?.focus({ preventScroll: true });
	}, [locations]);
	const openLocation = (location: CodeNavigationLocation) => {
		navigatingRef.current = true;
		onDismiss();
		onNavigate(location);
	};
	const select = (index: number) => {
		if (!locations.length) return;
		const next = Math.max(0, Math.min(locations.length - 1, index));
		setSelection(locations[next]!);
		rowRefs.current[next]?.scrollIntoView?.({ block: "nearest" });
	};
	const title =
		result.operation === "references"
			? "Find Usages"
			: result.operation === "definition"
				? "Choose Definition"
				: CODE_NAVIGATION_LABELS[result.operation];
	let rowIndex = 0;
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onDismiss()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
				<Dialog.Content
					ref={contentRef}
					aria-label="Code navigation results"
					aria-describedby={undefined}
					className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 text-xs shadow-2xl outline-none"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						(listRef.current ?? closeRef.current)?.focus({ preventScroll: true });
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						// Navigation owns destination focus; don't steal it back on unmount.
						if (navigatingRef.current) return;
						if (onRestoreFocus) onRestoreFocus();
						else if (invoker instanceof HTMLElement && invoker.isConnected)
							invoker.focus({ preventScroll: true });
					}}
					onEscapeKeyDown={(event) => {
						event.stopPropagation();
						if (event.isComposing) event.preventDefault();
					}}
				>
					<div className="flex min-h-9 items-center gap-2 border-b border-border px-3">
						<ListTree size={14} className="shrink-0 text-accent" />
						<Dialog.Title className="shrink-0 font-medium text-text-primary">{title}</Dialog.Title>
						{result.status === "locations" ? (
							<span className="min-w-0 flex-1 truncate text-text-secondary" title={result.sourcePath}>
								{locations.length}
								{result.truncated ? "+" : ""} {result.operation === "references" ? "usages" : "targets"} in{" "}
								{groups.size} {groups.size === 1 ? "file" : "files"} · {result.sourcePath}
							</span>
						) : (
							<span className="flex-1" />
						)}
						{result.operation === "references" && referencesOptions ? (
							<button
								ref={toggleRef}
								type="button"
								aria-pressed={referencesOptions.ignoreComments}
								disabled={referencesOptions.disabled}
								onClick={referencesOptions.onToggle}
								title={
									referencesOptions.disabled
										? "The original source has changed. Run Find Usages again to filter comments."
										: "Ignore usages in recognized comment syntax. Unknown languages are retained."
								}
								className={cn(
									"shrink-0 rounded px-2 py-1 text-text-secondary hover:bg-surface-3 disabled:opacity-40",
									referencesOptions.ignoreComments && "bg-accent/20 text-text-primary",
								)}
							>
								Ignore comments
							</button>
						) : null}
						{locations.length > 1 ? (
							<>
								<button
									type="button"
									aria-label="Previous usage"
									title="Previous usage (↑)"
									disabled={selectedIndex === 0}
									onClick={() => select(selectedIndex - 1)}
									className="rounded p-1 text-text-secondary hover:bg-surface-3 disabled:opacity-30"
								>
									<ArrowUp size={14} />
								</button>
								<button
									type="button"
									aria-label="Next usage"
									title="Next usage (↓)"
									disabled={selectedIndex === locations.length - 1}
									onClick={() => select(selectedIndex + 1)}
									className="rounded p-1 text-text-secondary hover:bg-surface-3 disabled:opacity-30"
								>
									<ArrowDown size={14} />
								</button>
							</>
						) : null}
						<button
							type="button"
							ref={closeRef}
							aria-label="Close code navigation results"
							title="Close (Esc)"
							onClick={onDismiss}
							className="rounded p-1 text-text-secondary hover:bg-surface-3"
						>
							<X size={14} />
						</button>
					</div>
					{result.status === "busy" ? (
						<p role="status" className="flex items-center gap-2 p-3 text-text-secondary">
							<Spinner size={14} />
							Searching symbols… First use may take longer while the language server starts.
						</p>
					) : null}
					{result.status === "error" || result.status === "unavailable" ? (
						<p role="status" className="m-0 p-3 text-text-secondary">
							{result.message}
						</p>
					) : null}
					{result.status === "hover" ? (
						<pre className="m-0 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-text-primary">
							{result.contents || "No type information found at this position."}
						</pre>
					) : null}
					{result.status === "locations" ? (
						<>
							{locations.length === 0 ? (
								<p role="status" className="m-0 p-3 text-text-secondary">
									{result.operation === "definition"
										? "No definition found at this position."
										: "No references found at this position."}
								</p>
							) : (
								<div className="flex h-[min(60dvh,28rem)] min-h-0 flex-col sm:flex-row">
									<div
										ref={listRef}
										role="listbox"
										aria-label={result.operation === "references" ? "Usages" : "Definitions"}
										aria-activedescendant={`${resultId}-${selectedIndex}`}
										tabIndex={0}
										className={cn(
											"min-w-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-focus",
											readFile ? "max-h-1/2 w-full shrink-0 sm:max-h-none sm:w-2/5" : "flex-1",
										)}
										onKeyDown={(event) => {
											if (event.defaultPrevented || event.nativeEvent.isComposing) return;
											if (
												event.key === "ArrowDown" ||
												event.key === "ArrowUp" ||
												event.key === "Home" ||
												event.key === "End"
											) {
												event.preventDefault();
												event.stopPropagation();
												select(
													event.key === "Home"
														? 0
														: event.key === "End"
															? locations.length - 1
															: selectedIndex + (event.key === "ArrowDown" ? 1 : -1),
												);
											} else if (event.key === "Enter" && selected) {
												event.preventDefault();
												event.stopPropagation();
												openLocation(selected);
											}
										}}
									>
										{Array.from(groups, ([path, fileLocations]) => (
											<div role="group" aria-label={path} key={path} className="py-1">
												<div className="sticky top-0 flex items-center gap-2 bg-surface-1 px-3 py-1 text-text-secondary">
													<FileCode2 size={13} className="shrink-0" />
													<span className="min-w-0 flex-1 truncate font-mono" title={path}>
														{path}
													</span>
													<span className="text-text-tertiary">{fileLocations.length}</span>
												</div>
												{fileLocations.map((location) => {
													const index = rowIndex++;
													return (
														<button
															type="button"
															role="option"
															aria-selected={index === selectedIndex}
															id={`${resultId}-${index}`}
															tabIndex={-1}
															ref={(node) => {
																rowRefs.current[index] = node;
															}}
															key={`${location.range.start.line}:${location.range.start.character}:${index}`}
															onClick={() => {
																select(index);
																openLocation(location);
															}}
															className={cn(
																"flex w-full items-center gap-2 py-1.5 pl-8 pr-3 text-left font-mono",
																index === selectedIndex
																	? "bg-accent/20 text-text-primary"
																	: "text-text-secondary hover:bg-surface-2",
															)}
														>
															<span className="text-accent">
																{location.range.start.line + 1}:{location.range.start.character + 1}
															</span>
															<span className="truncate text-[11px]">{path.split("/").pop()}</span>
														</button>
													);
												})}
											</div>
										))}
									</div>
									{selected && readFile ? (
										<CodeNavigationPreview location={selected} readFile={readFile} />
									) : null}
								</div>
							)}
							{locations.length > 0 ? (
								<div className="flex items-center justify-between border-t border-border px-3 py-1 text-[10px] text-text-tertiary">
									<span>↑ ↓ Select · Enter Open · Esc Close</span>
									<span>
										{selectedIndex + 1} / {locations.length}
									</span>
								</div>
							) : null}
							{result.truncated ? (
								<p role="status" className="m-0 px-3 py-1 text-text-tertiary">
									The language server returned more results than can be shown.
								</p>
							) : null}
						</>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
