import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { SearchOverlayShell } from "@/components/search/search-overlay-shell";
import { useFileFinder } from "@/hooks/search/use-file-finder";

export interface FileFinderOverlayProps {
	projectId: string | null;
	onSelect: (filePath: string) => void;
	onDismiss: () => void;
}

export function FileFinderOverlay({ projectId, onSelect, onDismiss }: FileFinderOverlayProps): ReactElement {
	const { query, setQuery, results, isLoading, selectedIndex, setSelectedIndex, handleKeyDown } = useFileFinder({
		projectId,
		onSelect,
	});

	const inputRef = useRef<HTMLInputElement>(null);
	const selectedRowRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		selectedRowRef.current?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const showEmptyState = query.trim().length > 0 && results.length === 0 && !isLoading;

	return (
		<SearchOverlayShell onDismiss={onDismiss}>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Search files by name..."
				className="w-full bg-zinc-800 border-b border-zinc-700 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none"
			/>

			<div className="overflow-y-auto max-h-[60vh]">
				{results.map((file, index) => (
					<div
						key={file.path}
						ref={index === selectedIndex ? selectedRowRef : undefined}
						className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-zinc-800 ${
							index === selectedIndex ? "bg-zinc-700" : ""
						}`}
						onClick={() => {
							setSelectedIndex(index);
							onSelect(file.path);
						}}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<div className="flex flex-col min-w-0 flex-1">
							<span className="text-sm text-zinc-100 font-medium">{file.name}</span>
							<span className="text-xs text-zinc-400 truncate">{file.path}</span>
						</div>
						{file.changed ? <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" /> : null}
					</div>
				))}

				{showEmptyState ? <div className="px-4 py-6 text-sm text-zinc-500 text-center">No files found</div> : null}

				{isLoading ? <div className="px-4 py-6 text-sm text-zinc-500 text-center">Searching...</div> : null}
			</div>
		</SearchOverlayShell>
	);
}
