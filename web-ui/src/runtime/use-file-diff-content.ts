import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileDiffResponse, RuntimeWorkspaceChangesMode, RuntimeWorkspaceFileChange } from "@/runtime/types";

export interface UseFileDiffContentOptions {
	workspaceId: string | null;
	taskId: string | null;
	baseRef: string | null;
	mode: RuntimeWorkspaceChangesMode;
	fromRef?: string | null;
	toRef?: string | null;
	selectedFile: RuntimeWorkspaceFileChange | null;
	/** Bumped when the file list changes (e.g. generatedAt from getChanges). Triggers a refetch of the selected file. */
	changesGeneratedAt?: number | null;
}

export interface UseFileDiffContentResult {
	oldText: string | null;
	newText: string | null;
	isLoading: boolean;
}

const EMPTY_RESULT: UseFileDiffContentResult = { oldText: null, newText: null, isLoading: false };

function buildCacheKey(
	path: string,
	mode: RuntimeWorkspaceChangesMode,
	fromRef: string | null | undefined,
	toRef: string | null | undefined,
): string {
	return `${path}::${mode}::${fromRef ?? ""}::${toRef ?? ""}`;
}

export function useFileDiffContent(options: UseFileDiffContentOptions): UseFileDiffContentResult {
	const { workspaceId, taskId, baseRef, mode, fromRef, toRef, selectedFile, changesGeneratedAt } = options;

	const [result, setResult] = useState<UseFileDiffContentResult>(EMPTY_RESULT);
	const requestIdRef = useRef(0);
	const isMountedRef = useRef(true);
	const cacheRef = useRef(new Map<string, { oldText: string | null; newText: string | null }>());
	/** When true, the next fetchContent call skips the isLoading flash (stale-while-revalidate). */
	const isBackgroundRefetchRef = useRef(false);

	// Track the context key — clear cache when context changes.
	const contextKey = `${workspaceId}::${taskId}::${baseRef}::${mode}::${fromRef ?? ""}::${toRef ?? ""}`;
	const prevContextKeyRef = useRef(contextKey);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	// Clear cache on context change.
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			prevContextKeyRef.current = contextKey;
			cacheRef.current.clear();
		}
	}, [contextKey]);

	const fetchContent = useCallback(async () => {
		if (!workspaceId || !selectedFile) {
			setResult(EMPTY_RESULT);
			return;
		}

		const cacheKey = buildCacheKey(selectedFile.path, mode, fromRef, toRef);
		const cached = cacheRef.current.get(cacheKey);
		if (cached) {
			setResult({ oldText: cached.oldText, newText: cached.newText, isLoading: false });
			return;
		}

		const requestId = ++requestIdRef.current;
		// Skip loading flash during background refetches (stale-while-revalidate).
		if (!isBackgroundRefetchRef.current) {
			setResult((prev) => ({ ...prev, isLoading: true }));
		}
		isBackgroundRefetchRef.current = false;

		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const response: RuntimeFileDiffResponse = await trpcClient.workspace.getFileDiff.query({
				taskId,
				baseRef: baseRef ?? undefined,
				mode,
				path: selectedFile.path,
				previousPath: selectedFile.previousPath,
				status: selectedFile.status,
				...(fromRef ? { fromRef } : {}),
				...(toRef ? { toRef } : {}),
			});

			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return;
			}

			const content = { oldText: response.oldText, newText: response.newText };
			cacheRef.current.set(cacheKey, content);
			setResult({ ...content, isLoading: false });
		} catch {
			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return;
			}
			setResult({ oldText: null, newText: null, isLoading: false });
		}
	}, [baseRef, fromRef, mode, selectedFile, taskId, toRef, workspaceId]);

	// Fetch when selected file changes.
	useEffect(() => {
		void fetchContent();
	}, [fetchContent]);

	// Refetch selected file content when the file list is refreshed (for uncommitted mode).
	const prevGeneratedAtRef = useRef(changesGeneratedAt);
	useEffect(() => {
		if (changesGeneratedAt == null || prevGeneratedAtRef.current === changesGeneratedAt) {
			prevGeneratedAtRef.current = changesGeneratedAt;
			return;
		}
		prevGeneratedAtRef.current = changesGeneratedAt;
		if (!selectedFile) {
			return;
		}
		// Invalidate cached content for the selected file so it gets refetched.
		// Use background mode to avoid flashing the loading skeleton (stale-while-revalidate).
		const cacheKey = buildCacheKey(selectedFile.path, mode, fromRef, toRef);
		cacheRef.current.delete(cacheKey);
		isBackgroundRefetchRef.current = true;
		void fetchContent();
	}, [changesGeneratedAt, fetchContent, fromRef, mode, selectedFile, toRef]);

	if (!workspaceId || !selectedFile) {
		return EMPTY_RESULT;
	}

	return result;
}
