import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	applyFileDiff,
	areFileArraysSameReference,
	buildDiffCacheKey,
	buildDiffFetchPlan,
	buildFileMetadataFingerprint,
	type CachedDiff,
	getChangedMetadataPaths,
	haveFileContentRevisions,
	mergeFilesWithCachedDiffs,
} from "@/runtime/all-file-diff-content";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDiffMode,
	RuntimeFileDiffResponse,
	RuntimeWorkdirChangesMode,
	RuntimeWorkdirFileChange,
} from "@/runtime/types";

export interface UseAllFileDiffContentOptions {
	projectId: string | null;
	taskId: string | null;
	baseRef: string | null;
	mode: RuntimeWorkdirChangesMode;
	fromRef?: string | null;
	toRef?: string | null;
	diffMode?: RuntimeDiffMode | null;
	/** All files from the changes list. Diffs are fetched for each file progressively. */
	files: RuntimeWorkdirFileChange[] | null;
	/** Revision token from the source change list. Used to detect content refreshes when stats are unchanged. */
	filesRevision?: number | null;
	/** Paths that must be loaded for the current view, ordered by foreground priority. */
	priorityPaths?: readonly string[];
	/** Enables capped best-effort prefetch for paths outside the foreground set. Defaults to true. */
	prefetchRemaining?: boolean;
	/** Maximum number of non-priority paths to prefetch for one scheduling pass. Defaults to 4. */
	backgroundPrefetchLimit?: number;
}

export interface FileLoadingState {
	/** Paths whose diff has been fetched successfully, including empty responses. */
	loaded: ReadonlySet<string>;
	/** Paths whose diff is currently being fetched. */
	loading: ReadonlySet<string>;
	/** Latest fetch failure per path. A refresh failure may coexist with loaded, cached content. */
	errors?: ReadonlyMap<string, string>;
}

export interface UseAllFileDiffContentResult {
	/** The files list enriched with oldText/newText from diff fetches. Null until the source files are available. */
	enrichedFiles: RuntimeWorkdirFileChange[] | null;
	/** Per-file loading state. */
	fileLoadingState: FileLoadingState;
}

const EMPTY_LOADING_STATE: FileLoadingState = { loaded: new Set(), loading: new Set(), errors: new Map() };
const EMPTY_PRIORITY_PATHS: readonly string[] = [];
const DEFAULT_BACKGROUND_PREFETCH_LIMIT = 4;

function areSetsEqual(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
	if (previous.size !== next.size) {
		return false;
	}
	for (const value of previous) {
		if (!next.has(value)) {
			return false;
		}
	}
	return true;
}

function areLoadingStatesEqual(previous: FileLoadingState, next: FileLoadingState): boolean {
	return (
		areSetsEqual(previous.loaded, next.loaded) &&
		areSetsEqual(previous.loading, next.loading) &&
		(previous.errors?.size ?? 0) === (next.errors?.size ?? 0) &&
		Array.from(previous.errors ?? []).every(([path, error]) => next.errors?.get(path) === error)
	);
}

function buildDiffRequestKey({
	contextKey,
	cacheKey,
	file,
	filesRevision,
}: {
	contextKey: string;
	cacheKey: string;
	file: RuntimeWorkdirFileChange;
	filesRevision: number | null;
}): string {
	return [
		contextKey,
		cacheKey,
		file.previousPath ?? "",
		file.status,
		file.contentRevision ?? "",
		filesRevision ?? "",
	].join("\0");
}

/**
 * Fetches diff content for requested files first, then optionally prefetches a bounded number of remaining files.
 * Files are fetched sequentially to avoid overwhelming the server with concurrent requests.
 * Results are cached per context and incrementally merged into the file list.
 */
export function useAllFileDiffContent(options: UseAllFileDiffContentOptions): UseAllFileDiffContentResult {
	const {
		projectId,
		taskId,
		baseRef,
		mode,
		fromRef,
		toRef,
		diffMode,
		files,
		filesRevision = null,
		priorityPaths = EMPTY_PRIORITY_PATHS,
		prefetchRemaining = true,
		backgroundPrefetchLimit = DEFAULT_BACKGROUND_PREFETCH_LIMIT,
	} = options;

	const [enrichedFiles, setEnrichedFiles] = useState<RuntimeWorkdirFileChange[] | null>(null);
	const [fileLoadingState, setFileLoadingState] = useState<FileLoadingState>(EMPTY_LOADING_STATE);

	const enrichedFilesRef = useRef<RuntimeWorkdirFileChange[] | null>(null);
	const cacheRef = useRef(new Map<string, CachedDiff>());
	const inFlightRequestsRef = useRef(new Map<string, Promise<CachedDiff>>());
	const forceFetchPathsRef = useRef(new Set<string>());
	const abortRef = useRef<AbortController | null>(null);
	const isMountedRef = useRef(true);

	// Track context so we can clear cache when it changes.
	const contextKey = `${projectId}::${taskId}::${baseRef}::${mode}::${fromRef ?? ""}::${toRef ?? ""}::${diffMode ?? ""}`;
	const prevContextKeyRef = useRef(contextKey);
	const prevFileMetadataFingerprintRef = useRef<string>("");
	const prevFilesRef = useRef<RuntimeWorkdirFileChange[] | null>(null);
	const prevFilesRevisionRef = useRef<number | null>(filesRevision);
	const priorityPathsKey = priorityPaths.join("\0");
	const normalizedPriorityPaths = useMemo(
		() => (priorityPathsKey.length === 0 ? EMPTY_PRIORITY_PATHS : priorityPathsKey.split("\0")),
		[priorityPathsKey],
	);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	// Clear cache on context change (project/task/mode/refs changed).
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			prevContextKeyRef.current = contextKey;
			cacheRef.current.clear();
			prevFileMetadataFingerprintRef.current = "";
			prevFilesRef.current = null;
			prevFilesRevisionRef.current = filesRevision;
			enrichedFilesRef.current = null;
			inFlightRequestsRef.current.clear();
			forceFetchPathsRef.current.clear();
			setFileLoadingState(EMPTY_LOADING_STATE);
			abortRef.current?.abort();
			abortRef.current = null;
		}
	}, [contextKey, filesRevision]);

	const fetchDiffs = useCallback(
		async ({
			priorityFiles,
			prefetchFiles,
			signal,
		}: {
			priorityFiles: RuntimeWorkdirFileChange[];
			prefetchFiles: RuntimeWorkdirFileChange[];
			signal: AbortSignal;
		}) => {
			if (!projectId) return;

			const cache = cacheRef.current;
			const queue = [...priorityFiles, ...prefetchFiles];

			if (queue.length === 0) return;

			setFileLoadingState((prev) => {
				const loading = new Set<string>();
				for (const file of priorityFiles) {
					const cacheKey = buildDiffCacheKey(file.path, mode, fromRef, toRef);
					if (!cache.has(cacheKey)) {
						loading.add(file.path);
					}
				}
				const next = { loaded: prev.loaded, loading, errors: prev.errors };
				return areLoadingStatesEqual(prev, next) ? prev : next;
			});

			const trpcClient = getRuntimeTrpcClient(projectId);

			for (const file of queue) {
				if (signal.aborted || !isMountedRef.current) return;

				const cacheKey = buildDiffCacheKey(file.path, mode, fromRef, toRef);
				// Double-check cache in case a concurrent run filled it.
				if (!forceFetchPathsRef.current.has(file.path) && cache.has(cacheKey)) continue;

				let diff: CachedDiff;
				try {
					const requestKey = buildDiffRequestKey({ contextKey, cacheKey, file, filesRevision });
					let request = inFlightRequestsRef.current.get(requestKey);
					if (!request) {
						request = trpcClient.project.getFileDiff
							.query({
								taskId,
								baseRef: baseRef ?? undefined,
								mode,
								path: file.path,
								previousPath: file.previousPath,
								status: file.status,
								...(fromRef ? { fromRef } : {}),
								...(toRef ? { toRef } : {}),
								...(diffMode ? { diffMode } : {}),
							})
							.then((response: RuntimeFileDiffResponse) => ({
								oldText: response.oldText,
								newText: response.newText,
							}))
							.finally(() => {
								if (inFlightRequestsRef.current.get(requestKey) === request) {
									inFlightRequestsRef.current.delete(requestKey);
								}
							});
						inFlightRequestsRef.current.set(requestKey, request);
					}
					diff = await request;
				} catch (error) {
					if (signal.aborted || !isMountedRef.current) return;

					// Failed requests must not masquerade as empty content or replace a good snapshot.
					setFileLoadingState((prev) => {
						const errors = new Map(prev.errors);
						errors.set(file.path, error instanceof Error ? error.message : "Failed to load file diff.");
						const loading = new Set(prev.loading);
						loading.delete(file.path);
						const next = { loaded: prev.loaded, loading, errors };
						return areLoadingStatesEqual(prev, next) ? prev : next;
					});
					continue;
				}

				if (signal.aborted || !isMountedRef.current) return;

				cache.set(cacheKey, diff);
				forceFetchPathsRef.current.delete(file.path);

				// Update state incrementally after each file.
				setFileLoadingState((prev) => {
					const loaded = new Set(prev.loaded);
					loaded.add(file.path);
					const loading = new Set(prev.loading);
					loading.delete(file.path);
					const errors = new Map(prev.errors);
					errors.delete(file.path);
					const next = { loaded, loading, errors };
					return areLoadingStatesEqual(prev, next) ? prev : next;
				});
				setEnrichedFiles((prevFiles) => {
					const nextFiles = applyFileDiff(prevFiles ?? enrichedFilesRef.current, file.path, diff);
					enrichedFilesRef.current = nextFiles;
					return nextFiles;
				});
			}
		},
		[projectId, taskId, baseRef, mode, fromRef, toRef, diffMode, contextKey, filesRevision],
	);

	// Main effect: when files change, merge new metadata with cached diff content
	// and record which paths need fresh content before the fetch policy runs.
	useEffect(() => {
		if (!files || files.length === 0 || !projectId) {
			abortRef.current?.abort();
			abortRef.current = null;
			inFlightRequestsRef.current.clear();
			forceFetchPathsRef.current.clear();
			enrichedFilesRef.current = files;
			setEnrichedFiles((prevFiles) => (prevFiles === files ? prevFiles : files));
			setFileLoadingState((prev) => (areLoadingStatesEqual(prev, EMPTY_LOADING_STATE) ? prev : EMPTY_LOADING_STATE));
			prevFileMetadataFingerprintRef.current = "";
			prevFilesRef.current = files;
			prevFilesRevisionRef.current = filesRevision;
			return;
		}

		const metadataFingerprint = buildFileMetadataFingerprint(files);
		const metadataChanged = metadataFingerprint !== prevFileMetadataFingerprintRef.current;
		const revisionChanged = filesRevision !== prevFilesRevisionRef.current;
		if (!metadataChanged && !revisionChanged) {
			return;
		}

		abortRef.current?.abort();
		abortRef.current = null;

		const cache = cacheRef.current;
		const previousFiles = prevFilesRef.current;
		const hasFileContentRevisions = haveFileContentRevisions(files);
		const forceFetchPaths = metadataChanged
			? getChangedMetadataPaths(previousFiles, files)
			: revisionChanged && !hasFileContentRevisions
				? new Set(files.map((file) => file.path))
				: new Set<string>();
		prevFileMetadataFingerprintRef.current = metadataFingerprint;
		prevFilesRef.current = files;
		prevFilesRevisionRef.current = filesRevision;

		if (metadataChanged && cache.size > 0) {
			const currentPaths = new Set(files.map((f) => f.path));
			for (const key of cache.keys()) {
				const path = key.slice(0, key.indexOf("::"));
				if (!currentPaths.has(path)) {
					cache.delete(key);
				}
			}
			for (const path of Array.from(forceFetchPathsRef.current)) {
				if (!currentPaths.has(path)) {
					forceFetchPathsRef.current.delete(path);
				}
			}
		}
		for (const path of forceFetchPaths) {
			forceFetchPathsRef.current.add(path);
		}

		const initial = mergeFilesWithCachedDiffs({
			files,
			previousFiles: enrichedFilesRef.current,
			cache,
			mode,
			fromRef,
			toRef,
		});

		setEnrichedFiles((prevFiles) => {
			if (areFileArraysSameReference(prevFiles, initial.files)) {
				enrichedFilesRef.current = prevFiles;
				return prevFiles;
			}
			enrichedFilesRef.current = initial.files;
			return initial.files;
		});
		setFileLoadingState((prev) => {
			const currentPaths = new Set(files.map((file) => file.path));
			const errors = new Map(Array.from(prev.errors ?? []).filter(([path]) => currentPaths.has(path)));
			const next = { loaded: initial.loaded, loading: new Set<string>(), errors };
			return areLoadingStatesEqual(prev, next) ? prev : next;
		});
	}, [files, filesRevision, projectId, mode, fromRef, toRef, contextKey]);

	useEffect(() => {
		if (!files || files.length === 0 || !projectId) {
			return;
		}

		abortRef.current?.abort();
		abortRef.current = null;

		const plan = buildDiffFetchPlan({
			files,
			priorityPaths: normalizedPriorityPaths,
			cache: cacheRef.current,
			forceFetchPaths: forceFetchPathsRef.current,
			mode,
			fromRef,
			toRef,
			prefetchRemaining,
			backgroundPrefetchLimit,
		});

		if (plan.priorityFiles.length === 0 && plan.prefetchFiles.length === 0) {
			setFileLoadingState((prev) => {
				const next = { loaded: prev.loaded, loading: new Set<string>(), errors: prev.errors };
				return areLoadingStatesEqual(prev, next) ? prev : next;
			});
			return;
		}

		const controller = new AbortController();
		abortRef.current = controller;
		void fetchDiffs({
			priorityFiles: plan.priorityFiles,
			prefetchFiles: plan.prefetchFiles,
			signal: controller.signal,
		});

		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [
		files,
		filesRevision,
		projectId,
		mode,
		fromRef,
		toRef,
		normalizedPriorityPaths,
		prefetchRemaining,
		backgroundPrefetchLimit,
		fetchDiffs,
	]);

	return { enrichedFiles: projectId && files ? enrichedFiles : null, fileLoadingState };
}
