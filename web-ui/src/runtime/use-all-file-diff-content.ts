import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDiffMode,
	RuntimeFileDiffResponse,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileChange,
} from "@/runtime/types";

export interface UseAllFileDiffContentOptions {
	workspaceId: string | null;
	taskId: string | null;
	baseRef: string | null;
	mode: RuntimeWorkspaceChangesMode;
	fromRef?: string | null;
	toRef?: string | null;
	diffMode?: RuntimeDiffMode | null;
	/** All files from the changes list. Diffs are fetched for each file progressively. */
	files: RuntimeWorkspaceFileChange[] | null;
}

export interface FileLoadingState {
	/** Map of file path -> true when a file's diff has been fetched (or failed). */
	loaded: ReadonlySet<string>;
	/** Map of file path -> true when a file's diff is currently being fetched. */
	loading: ReadonlySet<string>;
}

export interface UseAllFileDiffContentResult {
	/** The files list enriched with oldText/newText from diff fetches. Null until the source files are available. */
	enrichedFiles: RuntimeWorkspaceFileChange[] | null;
	/** Per-file loading state. */
	fileLoadingState: FileLoadingState;
}

interface CachedDiff {
	oldText: string | null;
	newText: string | null;
}

function buildCacheKey(
	path: string,
	mode: RuntimeWorkspaceChangesMode,
	fromRef: string | null | undefined,
	toRef: string | null | undefined,
): string {
	return `${path}::${mode}::${fromRef ?? ""}::${toRef ?? ""}`;
}

/** Build a stable fingerprint from the file list so we can detect actual content changes vs timestamp-only bumps. */
function buildFileListFingerprint(files: RuntimeWorkspaceFileChange[]): string {
	return files.map((f) => `${f.path}:${f.status}:${f.additions}:${f.deletions}`).join("|");
}

const EMPTY_LOADING_STATE: FileLoadingState = { loaded: new Set(), loading: new Set() };

/**
 * Fetches diff content for ALL files in a workspace changes list, progressively.
 * Files are fetched sequentially to avoid overwhelming the server with concurrent requests.
 * Results are cached per context and incrementally merged into the file list.
 */
export function useAllFileDiffContent(options: UseAllFileDiffContentOptions): UseAllFileDiffContentResult {
	const { workspaceId, taskId, baseRef, mode, fromRef, toRef, diffMode, files } = options;

	const [enrichedFiles, setEnrichedFiles] = useState<RuntimeWorkspaceFileChange[] | null>(null);
	const [fileLoadingState, setFileLoadingState] = useState<FileLoadingState>(EMPTY_LOADING_STATE);

	const cacheRef = useRef(new Map<string, CachedDiff>());
	const abortRef = useRef<AbortController | null>(null);
	const isMountedRef = useRef(true);
	/** Whether the current fetch pass is a background refetch (stale-while-revalidate). */
	const isBackgroundRefetchRef = useRef(false);

	// Track context so we can clear cache when it changes.
	const contextKey = `${workspaceId}::${taskId}::${baseRef}::${mode}::${fromRef ?? ""}::${toRef ?? ""}::${diffMode ?? ""}`;
	const prevContextKeyRef = useRef(contextKey);
	const prevFileFingerprintRef = useRef<string>("");

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	// Clear cache on context change (workspace/task/mode/refs changed).
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			prevContextKeyRef.current = contextKey;
			cacheRef.current.clear();
			prevFileFingerprintRef.current = "";
			abortRef.current?.abort();
			abortRef.current = null;
		}
	}, [contextKey]);

	const fetchAllDiffs = useCallback(
		async (filesToFetch: RuntimeWorkspaceFileChange[], signal: AbortSignal) => {
			if (!workspaceId) return;

			const cache = cacheRef.current;
			const isBackground = isBackgroundRefetchRef.current;
			isBackgroundRefetchRef.current = false;

			// Build the queue: files not yet cached.
			const queue: RuntimeWorkspaceFileChange[] = [];
			for (const file of filesToFetch) {
				const cacheKey = buildCacheKey(file.path, mode, fromRef, toRef);
				if (!cache.has(cacheKey)) {
					queue.push(file);
				}
			}

			if (queue.length === 0) return;

			// Mark queued files as loading — skip for background refetches to avoid skeleton flash.
			if (!isBackground && isMountedRef.current) {
				setFileLoadingState((prev) => {
					const loading = new Set(prev.loading);
					for (const file of queue) loading.add(file.path);
					return { loaded: prev.loaded, loading };
				});
			}

			const trpcClient = getRuntimeTrpcClient(workspaceId);

			for (const file of queue) {
				if (signal.aborted || !isMountedRef.current) return;

				const cacheKey = buildCacheKey(file.path, mode, fromRef, toRef);
				// Double-check cache in case a concurrent run filled it.
				if (cache.has(cacheKey)) continue;

				let diff: CachedDiff;
				try {
					const response: RuntimeFileDiffResponse = await trpcClient.workspace.getFileDiff.query({
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
					// On error, cache an empty diff so we don't retry in a tight loop.
					diff = { oldText: null, newText: null };
				}

				if (signal.aborted || !isMountedRef.current) return;

				cache.set(cacheKey, diff);

				// Update state incrementally after each file.
				setFileLoadingState((prev) => {
					const loaded = new Set(prev.loaded);
					loaded.add(file.path);
					const loading = new Set(prev.loading);
					loading.delete(file.path);
					return { loaded, loading };
				});
				setEnrichedFiles((prevFiles) => {
					if (!prevFiles) return prevFiles;
					return prevFiles.map((f) => {
						if (f.path !== file.path) return f;
						return { ...f, oldText: diff.oldText, newText: diff.newText };
					});
				});
			}
		},
		[workspaceId, taskId, baseRef, mode, fromRef, toRef, diffMode],
	);

	// Main effect: when files change, build enriched list from cache and start fetching uncached diffs.
	// Uses a fingerprint of file paths+statuses+counts to detect actual content changes vs. timestamp-only
	// poll bumps. When the fingerprint changes, cached diffs are invalidated and re-fetched in background
	// (stale-while-revalidate) to avoid skeleton flash on every poll cycle.
	useEffect(() => {
		// Abort any in-flight fetch sequence.
		abortRef.current?.abort();
		abortRef.current = null;

		if (!files || files.length === 0 || !workspaceId) {
			setEnrichedFiles(files);
			setFileLoadingState(EMPTY_LOADING_STATE);
			prevFileFingerprintRef.current = "";
			return;
		}

		const cache = cacheRef.current;
		const fingerprint = buildFileListFingerprint(files);
		const fingerprintChanged = fingerprint !== prevFileFingerprintRef.current;
		prevFileFingerprintRef.current = fingerprint;

		// When the file list actually changed (not just a timestamp bump), invalidate cached diffs
		// so they get re-fetched — but use background mode to avoid skeleton flash.
		if (fingerprintChanged && cache.size > 0) {
			cache.clear();
			isBackgroundRefetchRef.current = true;
		}

		const loaded = new Set<string>();

		// Build initial enriched list from cache.
		const initial = files.map((file) => {
			const cacheKey = buildCacheKey(file.path, mode, fromRef, toRef);
			const cached = cache.get(cacheKey);
			if (cached) {
				loaded.add(file.path);
				return { ...file, oldText: cached.oldText, newText: cached.newText };
			}
			return file;
		});

		setEnrichedFiles(initial);
		setFileLoadingState({ loaded, loading: new Set() });

		// Start fetching uncached diffs.
		const hasUncached = files.some((file) => {
			const cacheKey = buildCacheKey(file.path, mode, fromRef, toRef);
			return !cache.has(cacheKey);
		});

		if (hasUncached) {
			const controller = new AbortController();
			abortRef.current = controller;
			void fetchAllDiffs(files, controller.signal);
		}

		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [files, workspaceId, mode, fromRef, toRef, diffMode, fetchAllDiffs]);

	return { enrichedFiles: workspaceId && files ? enrichedFiles : null, fileLoadingState };
}
