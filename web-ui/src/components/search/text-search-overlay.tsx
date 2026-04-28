import type React from "react";
import { useEffect, useMemo, useRef } from "react";

import { SearchOverlayShell } from "@/components/search/search-overlay-shell.js";
import { useTextSearch } from "@/hooks/search/use-text-search.js";
import type { RuntimeWorkdirTextSearchFile } from "@/runtime/types";

export interface TextSearchOverlayProps {
	projectId: string | null;
	onSelect: (filePath: string, lineNumber?: number) => void;
	onDismiss: () => void;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatches(content: string, query: string, isRegex: boolean, caseSensitive: boolean): React.ReactNode {
	if (!query) return content;
	try {
		const flags = caseSensitive ? "g" : "gi";
		const pattern = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
		const parts = content.split(pattern);
		const matches = content.match(pattern);
		if (!matches) return content;
		return parts.reduce<React.ReactNode[]>((acc, part, i) => {
			acc.push(<span key={`p${String(i)}`}>{part}</span>);
			if (i < matches.length) {
				acc.push(
					<span key={`m${String(i)}`} className="bg-amber-500/30 text-amber-200">
						{matches[i]}
					</span>,
				);
			}
			return acc;
		}, []);
	} catch {
		return content;
	}
}

export function TextSearchOverlay({ projectId, onSelect, onDismiss }: TextSearchOverlayProps): React.ReactElement {
	const search = useTextSearch({ projectId, onSelect });
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedRowRef = useRef<HTMLDivElement>(null);

	// Auto-focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Scroll selected row into view
	useEffect(() => {
		selectedRowRef.current?.scrollIntoView({ block: "nearest" });
	}, [search.selectedIndex]);

	const flatIndexStarts = useMemo(() => {
		const starts: number[] = [];
		let offset = 0;
		for (const file of search.results) {
			starts.push(offset);
			offset += file.matches.length;
		}
		return starts;
	}, [search.results]);

	return (
		<SearchOverlayShell onDismiss={onDismiss}>
			<div className="flex items-center gap-1 border-b border-zinc-700 bg-zinc-800 px-1">
				<input
					ref={inputRef}
					name="text-search-query"
					type="text"
					value={search.query}
					onChange={(e) => search.setQuery(e.target.value)}
					onKeyDown={search.handleKeyDown}
					placeholder="Search text in files..."
					className="flex-1 bg-transparent px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none"
				/>
				<button
					type="button"
					onClick={search.toggleCaseSensitive}
					className={`px-2 py-1 text-xs font-mono rounded ${
						search.caseSensitive ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
					}`}
					title="Case sensitive"
				>
					Aa
				</button>
				<button
					type="button"
					onClick={search.toggleIsRegex}
					className={`px-2 py-1 text-xs font-mono rounded ${
						search.isRegex ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
					}`}
					title="Use regular expression"
				>
					.*
				</button>
			</div>

			{search.totalMatches > 0 && (
				<div className="text-xs text-zinc-400 px-4 py-1">
					{search.totalMatches} match{search.totalMatches !== 1 ? "es" : ""} in {search.results.length} file
					{search.results.length !== 1 ? "s" : ""}
					{search.truncated ? " (results truncated)" : ""}
				</div>
			)}

			{search.isLoading && (
				<div className="flex items-center justify-center py-8 text-sm text-zinc-500">Searching...</div>
			)}

			{!search.isLoading && search.hasSearched && search.results.length === 0 && (
				<div className="flex items-center justify-center py-8 text-sm text-zinc-500">No results found</div>
			)}

			{!search.isLoading && search.results.length > 0 && (
				<div className="overflow-y-auto max-h-[55vh]">
					{search.results.map((file: RuntimeWorkdirTextSearchFile, fileIdx: number) => (
						<FileGroup
							key={file.path}
							file={file}
							query={search.query}
							isRegex={search.isRegex}
							caseSensitive={search.caseSensitive}
							selectedIndex={search.selectedIndex}
							flatIndexStart={flatIndexStarts[fileIdx] ?? 0}
							selectedRowRef={selectedRowRef}
							onClickMatch={(path: string, lineNumber: number) => onSelect(path, lineNumber)}
							onHoverMatch={search.setSelectedIndex}
						/>
					))}
				</div>
			)}
		</SearchOverlayShell>
	);
}

interface FileGroupProps {
	file: RuntimeWorkdirTextSearchFile;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	selectedIndex: number;
	flatIndexStart: number;
	selectedRowRef: React.RefObject<HTMLDivElement>;
	onClickMatch: (path: string, lineNumber: number) => void;
	onHoverMatch: (index: number) => void;
}

function FileGroup({
	file,
	query,
	isRegex,
	caseSensitive,
	selectedIndex,
	flatIndexStart,
	selectedRowRef,
	onClickMatch,
	onHoverMatch,
}: FileGroupProps): React.ReactElement {
	return (
		<div>
			<div className="px-4 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800/50 sticky top-0">
				{file.path}
				<span className="ml-2 text-zinc-500">({file.matches.length})</span>
			</div>
			{file.matches.map((match, matchIdx) => {
				const currentFlatIndex = flatIndexStart + matchIdx;
				const isSelected = currentFlatIndex === selectedIndex;
				return (
					<div
						key={`${String(match.line)}:${String(matchIdx)}`}
						ref={isSelected ? selectedRowRef : undefined}
						className={`flex items-center gap-3 px-4 py-1 cursor-pointer text-sm ${
							isSelected ? "bg-zinc-700" : "hover:bg-zinc-800"
						}`}
						onClick={() => onClickMatch(file.path, match.line)}
						onMouseEnter={() => onHoverMatch(currentFlatIndex)}
						onKeyDown={undefined}
					>
						<span className="text-zinc-500 font-mono text-xs w-10 text-right shrink-0">{match.line}</span>
						<span className="text-zinc-300 truncate">
							{highlightMatches(match.content, query, isRegex, caseSensitive)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
