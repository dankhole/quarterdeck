import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client.js";
import type { RuntimeWorkdirTextSearchFile } from "@/runtime/types";
import type { WorkdirSearchScope } from "./search-scope";

export interface FlatMatch {
	path: string;
	line: number;
	content: string;
}

export interface UseTextSearchResult {
	query: string;
	setQuery: (q: string) => void;
	caseSensitive: boolean;
	toggleCaseSensitive: () => void;
	isRegex: boolean;
	toggleIsRegex: () => void;
	results: RuntimeWorkdirTextSearchFile[];
	totalMatches: number;
	truncated: boolean;
	isLoading: boolean;
	hasSearched: boolean;
	selectedIndex: number;
	setSelectedIndex: (i: number) => void;
	flatMatches: FlatMatch[];
	handleKeyDown: (e: React.KeyboardEvent) => void;
	confirmSelection: () => void;
	executeSearch: () => void;
}

interface UseTextSearchOptions {
	projectId: string | null;
	searchScope: WorkdirSearchScope;
	onSelect: (filePath: string, lineNumber?: number) => void;
}

export function useTextSearch({ projectId, searchScope, onSelect }: UseTextSearchOptions): UseTextSearchResult {
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [isRegex, setIsRegex] = useState(false);
	const [results, setResults] = useState<RuntimeWorkdirTextSearchFile[]>([]);
	const [totalMatches, setTotalMatches] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(-1);
	const requestIdRef = useRef(0);

	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;

	const flatMatches = useMemo<FlatMatch[]>(() => {
		const flat: FlatMatch[] = [];
		for (const file of results) {
			for (const match of file.matches) {
				flat.push({ path: file.path, line: match.line, content: match.content });
			}
		}
		return flat;
	}, [results]);

	const executeSearch = useCallback(async () => {
		if (query.length < 2 || !projectId) {
			return;
		}
		const requestId = ++requestIdRef.current;
		setIsLoading(true);
		try {
			const trpcClient = getRuntimeTrpcClient(projectId);
			const response = await trpcClient.project.searchText.query({
				query,
				caseSensitive,
				isRegex,
				taskId: searchScope.taskId,
				...(searchScope.baseRef ? { baseRef: searchScope.baseRef } : {}),
				...(searchScope.ref ? { ref: searchScope.ref } : {}),
			});
			if (requestId !== requestIdRef.current) return;
			setResults(response.files);
			setTotalMatches(response.totalMatches);
			setTruncated(response.truncated);
			setHasSearched(true);
			setSelectedIndex(-1);
		} catch {
			if (requestId !== requestIdRef.current) return;
			setResults([]);
			setTotalMatches(0);
			setTruncated(false);
			setHasSearched(true);
		} finally {
			if (requestId === requestIdRef.current) {
				setIsLoading(false);
			}
		}
	}, [query, projectId, caseSensitive, isRegex, searchScope]);

	const executeSearchRef = useRef(executeSearch);
	executeSearchRef.current = executeSearch;

	// Re-execute search when caseSensitive or isRegex toggles change (if already searched)
	const hasSearchedRef = useRef(hasSearched);
	hasSearchedRef.current = hasSearched;
	const queryRef = useRef(query);
	queryRef.current = query;

	useEffect(() => {
		if (hasSearchedRef.current && queryRef.current.length >= 2) {
			void executeSearchRef.current();
		}
		// Only re-run when toggle values change, not on every render
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [caseSensitive, isRegex]);

	const toggleCaseSensitive = useCallback(() => {
		setCaseSensitive((prev) => !prev);
	}, []);

	const toggleIsRegex = useCallback(() => {
		setIsRegex((prev) => !prev);
	}, []);

	const confirmSelection = useCallback(() => {
		if (selectedIndex >= 0 && selectedIndex < flatMatches.length) {
			const match = flatMatches[selectedIndex];
			if (match) {
				onSelectRef.current(match.path, match.line);
			}
		}
	}, [selectedIndex, flatMatches]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((prev) => Math.min(prev + 1, flatMatches.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((prev) => Math.max(prev - 1, -1));
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (selectedIndex >= 0 && flatMatches[selectedIndex]) {
					confirmSelection();
				} else {
					void executeSearch();
				}
			}
		},
		[flatMatches, selectedIndex, confirmSelection, executeSearch],
	);

	return {
		query,
		setQuery,
		caseSensitive,
		toggleCaseSensitive,
		isRegex,
		toggleIsRegex,
		results,
		totalMatches,
		truncated,
		isLoading,
		hasSearched,
		selectedIndex,
		setSelectedIndex,
		flatMatches,
		handleKeyDown,
		confirmSelection,
		executeSearch,
	};
}
