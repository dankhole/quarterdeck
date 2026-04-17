import type { KeyboardEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkdirFileSearchMatch } from "@/runtime/types";
import { useDebouncedEffect } from "@/utils/react-use";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_RESULT_LIMIT = 50;

export interface UseFileFinderResult {
	query: string;
	setQuery: (q: string) => void;
	results: RuntimeWorkdirFileSearchMatch[];
	isLoading: boolean;
	selectedIndex: number;
	setSelectedIndex: (i: number) => void;
	handleKeyDown: (e: KeyboardEvent) => void;
	confirmSelection: () => void;
}

export function useFileFinder(options: {
	projectId: string | null;
	onSelect: (filePath: string) => void;
}): UseFileFinderResult {
	const { projectId, onSelect } = options;

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<RuntimeWorkdirFileSearchMatch[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const requestIdRef = useRef(0);

	useDebouncedEffect(
		() => {
			const trimmed = query.trim();
			if (!trimmed || !projectId) {
				requestIdRef.current += 1;
				setResults([]);
				setIsLoading(false);
				return;
			}

			const requestId = ++requestIdRef.current;
			setIsLoading(true);

			void (async () => {
				try {
					const trpcClient = getRuntimeTrpcClient(projectId);
					const payload = await trpcClient.project.searchFiles.query({
						query: trimmed,
						limit: SEARCH_RESULT_LIMIT,
					});
					if (requestId !== requestIdRef.current) {
						return;
					}
					const files = Array.isArray(payload.files) ? payload.files : [];
					setResults(files);
					setSelectedIndex(0);
				} catch {
					if (requestId === requestIdRef.current) {
						setResults([]);
					}
				} finally {
					if (requestId === requestIdRef.current) {
						setIsLoading(false);
					}
				}
			})();
		},
		SEARCH_DEBOUNCE_MS,
		[query, projectId],
	);

	const confirmSelection = useCallback(() => {
		const match = results[selectedIndex];
		if (match) {
			onSelect(match.path);
		}
	}, [results, selectedIndex, onSelect]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((prev) => (results.length === 0 ? 0 : (prev - 1 + results.length) % results.length));
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				confirmSelection();
				return;
			}
		},
		[results.length, confirmSelection],
	);

	return {
		query,
		setQuery,
		results,
		isLoading,
		selectedIndex,
		setSelectedIndex,
		handleKeyDown,
		confirmSelection,
	};
}
