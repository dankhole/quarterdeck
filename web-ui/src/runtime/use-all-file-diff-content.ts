import { useCallback, useEffect, useRef, useState } from "react";

import {
	applyFileDiff,
	areFileArraysSameReference,
	buildDiffCacheKey,
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
}

export interface FileLoadingState {
	/** Map of file path -> true when a file's diff has been fetched (or failed). */
	loaded: ReadonlySet<string>;
	/** Map of file path -> true when a file's diff is currently being fetched. */
	loading: ReadonlySet<string>;
}

export interface UseAllFileDiffContentResult {
	/** The files list enriched with oldText/newText from diff fetches. Null until the source files are available. */
	enrichedFiles: RuntimeWorkdirFileChange[] | null;
	/** Per-file loading state. */
	fileLoadingState: FileLoadingState;
}

const EMPTY_LOADING_STATE: FileLoadingState = { loaded: new Set(), loading: new Set() };

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
	return areSetsEqual(previous.loaded, next.loaded) && areSetsEqual(previous.loading, next.loading);
}

/**
 * Fetches diff content for ALL files in a project changes list, progressively.
 * Files are fetched sequentially to avoid overwhelming the server with concurrent requests.
 * Results are cached per context and incrementally merged into the file list.
 */
export function useAllFileDiffContent(options: UseAllFileDiffContentOptions): UseAllFileDiffContentResult {
	const { projectId, taskId, baseRef, mode, fromRef, toRef, diffMode, files, filesRevision = null } = options;

	const [enrichedFiles, setEnrichedFiles] = useState<RuntimeWorkdirFileChange[] | null>(null);
	const [fileLoadingState, setFileLoadingState] = useState<FileLoadingState>(EMPTY_LOADING_STATE);

	const enrichedFilesRef = useRef<RuntimeWorkdirFileChange[] | null>(null);
	const cacheRef = useRef(new Map<string, CachedDiff>());
	const abortRef = useRef<AbortController | null>(null);
	const isMountedRef = useRef(true);
	/** Whether the current fetch pass is a background refetch (stale-while-revalidate). */
	const isBackgroundRefetchRef = useRef(false);

	// Track context so we can clear cache when it changes.
	const contextKey = `${projectId}::${taskId}::${baseRef}::${mode}::${fromRef ?? ""}::${toRef ?? ""}::${diffMode ?? ""}`;
	const prevContextKeyRef = useRef(contextKey);
	const prevFileMetadataFingerprintRef = useRef<string>("");
	const prevFilesRef = useRef<RuntimeWorkdirFileChange[] | null>(null);
	const prevFilesRevisionRef = useRef<number | null>(filesRevision);

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
			abortRef.current?.abort();
			abortRef.current = null;
		}
	}, [contextKey, filesRevision]);

	const fetchAllDiffs = useCallback(
		async (filesToFetch: RuntimeWorkdirFileChange[], signal: AbortSignal, forceFetchPaths = new Set<string>()) => {
			if (!projectId) return;

			const cache = cacheRef.current;
			const isBackground = isBackgroundRefetchRef.current;
			isBackgroundRefetchRef.current = false;

			// Build the queue: files not yet cached.
			const queue: RuntimeWorkdirFileChange[] = [];
			for (const file of filesToFetch) {
				const cacheKey = buildDiffCacheKey(file.path, mode, fromRef, toRef);
				if (forceFetchPaths.has(file.path) || !cache.has(cacheKey)) {
					queue.push(file);
				}
			}

			if (queue.length === 0) return;

			// Mark queued files as loading — skip for background refetches to avoid skeleton flash.
			if (!isBackground && isMountedRef.current) {
				setFileLoadingState((prev) => {
					const loading = new Set(prev.loading);
					for (const file of queue) loading.add(file.path);
					const next = { loaded: prev.loaded, loading };
					return areLoadingStatesEqual(prev, next) ? prev : next;
				});
			}

			const trpcClient = getRuntimeTrpcClient(projectId);

			for (const file of queue) {
				if (signal.aborted || !isMountedRef.current) return;

				const cacheKey = buildDiffCacheKey(file.path, mode, fromRef, toRef);
				// Double-check cache in case a concurrent run filled it.
				if (!forceFetchPaths.has(file.path) && cache.has(cacheKey)) continue;

				let diff: CachedDiff;
				try {
					const response: RuntimeFileDiffResponse = await trpcClient.project.getFileDiff.query({
						taskId,
						baseRef: baseRef ?? undefined,
						mode,
						path: file.path,
						previousPath: file.previousPath,
						status: file.status,
						...(fromRef ? { fromRef } : {}),
						...(toRef ? { toRef } : {}),
						...(diffMode ? { diffMode } : {}),
					});
					diff = { oldText: response.oldText, newText: response.newText };
				} catch {
					const existing = cache.get(cacheKey);
					// Preserve previously loaded content during background refresh failures.
					diff = existing ?? { oldText: null, newText: null };
				}

				if (signal.aborted || !isMountedRef.current) return;

				cache.set(cacheKey, diff);

				// Update state incrementally after each file.
				setFileLoadingState((prev) => {
					const loaded = new Set(prev.loaded);
					loaded.add(file.path);
					const loading = new Set(prev.loading);
					loading.delete(file.path);
					const next = { loaded, loading };
					return areLoadingStatesEqual(prev, next) ? prev : next;
				});
				setEnrichedFiles((prevFiles) => {
					const nextFiles = applyFileDiff(prevFiles ?? enrichedFilesRef.current, file.path, diff);
					enrichedFilesRef.current = nextFiles;
					return nextFiles;
				});
			}
		},
		[projectId, taskId, baseRef, mode, fromRef, toRef, diffMode],
	);

	// Main effect: when files change, merge new metadata with cached diff content
	// and start fetching only files whose metadata or source revision changed.
	useEffect(() => {
		if (!files || files.length === 0 || !projectId) {
			if (prevFileMetadataFingerprintRef.current !== "") {
				abortRef.current?.abort();
				abortRef.current = null;
				enrichedFilesRef.current = files;
				setEnrichedFiles((prevFiles) => (prevFiles === files ? prevFiles : files));
				setFileLoadingState((prev) =>
					areLoadingStatesEqual(prev, EMPTY_LOADING_STATE) ? prev : EMPTY_LOADING_STATE,
				);
				prevFileMetadataFingerprintRef.current = "";
				prevFilesRef.current = files;
				prevFilesRevisionRef.current = filesRevision;
			}
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
		const isBackgroundRefetch = prevFileMetadataFingerprintRef.current !== "" && cache.size > 0;
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
			if (isBackgroundRefetch && forceFetchPaths.size > 0) {
				isBackgroundRefetchRef.current = true;
			}
		} else if (isBackgroundRefetch && revisionChanged && forceFetchPaths.size > 0) {
			isBackgroundRefetchRef.current = true;
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
			const next = { loaded: initial.loaded, loading: new Set<string>() };
			return areLoadingStatesEqual(prev, next) ? prev : next;
		});

		const hasUncached = files.some((file) => {
			const cacheKey = buildDiffCacheKey(file.path, mode, fromRef, toRef);
			return forceFetchPaths.has(file.path) || !cache.has(cacheKey);
		});

		if (hasUncached) {
			const controller = new AbortController();
			abortRef.current = controller;
			void fetchAllDiffs(files, controller.signal, forceFetchPaths);
		}

		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [files, filesRevision, projectId, mode, fromRef, toRef, diffMode, fetchAllDiffs]);

	return { enrichedFiles: projectId && files ? enrichedFiles : null, fileLoadingState };
}
