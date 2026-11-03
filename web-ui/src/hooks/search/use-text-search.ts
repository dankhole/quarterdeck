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
	ignoreComments: boolean;
	toggleIgnoreComments: () => void;
	error: string | null;
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
	const [ignoreComments, setIgnoreComments] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [results, setResults] = useState<RuntimeWorkdirTextSearchFile[]>([]);
	const [totalMatches, setTotalMatches] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(-1);
	const requestIdRef = useRef(0);
	const hasRequestedRef = useRef(false);
	const scopeKey = JSON.stringify([projectId, searchScope.taskId, searchScope.baseRef, searchScope.ref]);
	const requestKey = JSON.stringify([scopeKey, query, caseSensitive, isRegex, ignoreComments]);
	const latestKeyRef = useRef(requestKey);
	latestKeyRef.current = requestKey;

	useEffect(() => {
		requestIdRef.current += 1;
		hasRequestedRef.current = false;
		setResults([]);
		setTotalMatches(0);
		setTruncated(false);
		setIsLoading(false);
		setHasSearched(false);
		setSelectedIndex(-1);
		setError(null);
		return () => {
			requestIdRef.current += 1;
		};
	}, [scopeKey]);

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

	const selectedMatchRef = useRef<FlatMatch | undefined>(undefined);
	selectedMatchRef.current = flatMatches[selectedIndex];

	const executeSearch = useCallback(
		async (preserveSelection = false) => {
			if (query.length < 2 || !projectId) {
				return;
			}
			const previousSelection = preserveSelection ? selectedMatchRef.current : undefined;
			const requestId = ++requestIdRef.current;
			const isCurrent = () => requestId === requestIdRef.current && latestKeyRef.current === requestKey;
			hasRequestedRef.current = true;
			setIsLoading(true);
			setError(null);
			setResults([]);
			setTotalMatches(0);
			setTruncated(false);
			setSelectedIndex(-1);
			try {
				const trpcClient = getRuntimeTrpcClient(projectId);
				const response = await trpcClient.project.searchText.query({
					query,
					caseSensitive,
					isRegex,
					...(ignoreComments ? { ignoreComments: true } : {}),
					taskId: searchScope.taskId,
					...(searchScope.baseRef ? { baseRef: searchScope.baseRef } : {}),
					...(searchScope.ref ? { ref: searchScope.ref } : {}),
				});
				if (!isCurrent()) return;
				if (ignoreComments && response.ignoreComments !== true) {
					throw new Error("Ignore comments is unavailable. Upgrade the Quarterdeck runtime and try again.");
				}
				setResults(response.files);
				setTotalMatches(response.totalMatches);
				setTruncated(response.truncated);
				setHasSearched(true);
				setSelectedIndex(
					previousSelection
						? response.files
								.flatMap((file) => file.matches.map((match) => ({ path: file.path, line: match.line })))
								.findIndex(
									(match) => match.path === previousSelection.path && match.line === previousSelection.line,
								)
						: -1,
				);
			} catch (error) {
				if (!isCurrent()) return;
				setError(error instanceof Error ? error.message : "Text search failed.");
				setResults([]);
				setTotalMatches(0);
				setTruncated(false);
				setHasSearched(true);
			} finally {
				if (isCurrent()) {
					setIsLoading(false);
				}
			}
		},
		[query, projectId, caseSensitive, isRegex, ignoreComments, searchScope, requestKey],
	);

	const executeSearchRef = useRef(executeSearch);
	executeSearchRef.current = executeSearch;

	// Options also replace an in-flight request; the request key fences its eventual response.
	const queryRef = useRef(query);
	queryRef.current = query;

	useEffect(() => {
		requestIdRef.current += 1;
		setIsLoading(false);
		if (query.length < 2) {
			hasRequestedRef.current = false;
			setResults([]);
			setTotalMatches(0);
			setTruncated(false);
			setSelectedIndex(-1);
			setError(null);
			setHasSearched(false);
		}
	}, [query]);

	useEffect(() => {
		if (hasRequestedRef.current && queryRef.current.length >= 2) {
			void executeSearchRef.current(true);
		}
		// Only re-run when toggle values change, not on every render
	}, [caseSensitive, isRegex, ignoreComments]);

	const toggleIgnoreComments = useCallback(() => {
		setIgnoreComments((prev) => !prev);
	}, []);

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
		ignoreComments,
		toggleIgnoreComments,
		error,
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
