import { useCallback, useEffect, useRef, useState } from "react";
import { areListFilesResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

const FILE_LIST_POLL_INTERVAL_MS = 5_000;

/** Module-level cache of the last viewed file per scope key (taskId or "home"). */
const lastSelectedPathByScope = new Map<string, string>();

/** Hydrate the in-memory cache from localStorage once at module load. */
(function hydrateCache(): void {
	const raw = readLocalStorageItem(LocalStorageKey.FileBrowserLastSelectedPath);
	if (!raw) return;
	try {
		const parsed: Record<string, string> = JSON.parse(raw);
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				lastSelectedPathByScope.set(key, value);
			}
		}
	} catch {
		// Ignore corrupt data.
	}
})();

function persistCacheToStorage(): void {
	writeLocalStorageItem(
		LocalStorageKey.FileBrowserLastSelectedPath,
		JSON.stringify(Object.fromEntries(lastSelectedPathByScope)),
	);
}

function scopeKey(taskId: string | null): string {
	return taskId ?? "__home__";
}

export interface UseFileBrowserDataResult {
	files: string[] | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	fileContent: RuntimeFileContentResponse | null;
	isContentLoading: boolean;
	isContentError: boolean;
	onCloseFile: () => void;
	/** Fetch file content for an arbitrary path (used by "Copy file contents" context menu action). */
	getFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
}

/**
 * Encapsulates file list + content fetching so the tree and content viewer
 * can be rendered in separate layout areas (sidebar vs main).
 */
export function useFileBrowserData(options: {
	projectId: string | null;
	taskId: string | null;
	baseRef?: string;
	/** Browse files at a git ref (read-only). */
	ref?: string | null;
}): UseFileBrowserDataResult {
	const { projectId, taskId, baseRef, ref: browseRef } = options;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	// Wrap setSelectedPath to also persist in the module-level cache + localStorage.
	const setSelectedPathPersisted = useCallback(
		(path: string | null) => {
			setSelectedPath(path);
			const key = scopeKey(taskId);
			if (path) {
				lastSelectedPathByScope.set(key, path);
			} else {
				lastSelectedPathByScope.delete(key);
			}
			persistCacheToStorage();
		},
		[taskId],
	);

	const listFilesQueryFn = useCallback(async () => {
		if (!projectId) {
			throw new Error("Missing project.");
		}
		const trpcClient = getRuntimeTrpcClient(projectId);
		return await trpcClient.project.listFiles.query({
			taskId,
			...(baseRef ? { baseRef } : {}),
			...(browseRef ? { ref: browseRef } : {}),
		});
	}, [projectId, taskId, baseRef, browseRef]);

	const fileListQuery = useTrpcQuery<RuntimeListFilesResponse>({
		enabled: projectId !== null,
		queryFn: listFilesQueryFn,
		isDataEqual: areListFilesResponsesEqual,
	});

	// Restore last selected file when the scope changes, or clear if none was remembered.
	useEffect(() => {
		const restored = lastSelectedPathByScope.get(scopeKey(taskId)) ?? null;
		setSelectedPathPersisted(restored);
	}, [taskId, browseRef, projectId, setSelectedPathPersisted]);

	// Clear restored selection if the file no longer exists in the loaded file list.
	const files = fileListQuery.data?.files;
	useEffect(() => {
		if (selectedPath && files && !files.includes(selectedPath)) {
			setSelectedPathPersisted(null);
		}
	}, [selectedPath, files, setSelectedPathPersisted]);

	// Poll for file list changes — but not in branch view mode (immutable tree)
	const refetchRef = useRef(fileListQuery.refetch);
	refetchRef.current = fileListQuery.refetch;
	useEffect(() => {
		if (browseRef) {
			return; // Branch view: ref tree is immutable, no polling needed
		}
		const id = setInterval(() => {
			refetchRef.current();
		}, FILE_LIST_POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [browseRef]);

	const fileContentQueryFn = useCallback(async () => {
		if (!selectedPath || !projectId) {
			throw new Error("No file selected.");
		}
		const trpcClient = getRuntimeTrpcClient(projectId);
		return await trpcClient.project.getFileContent.query({
			taskId,
			...(baseRef ? { baseRef } : {}),
			path: selectedPath,
			...(browseRef ? { ref: browseRef } : {}),
		});
	}, [projectId, taskId, baseRef, selectedPath, browseRef]);

	const fileContentQuery = useTrpcQuery<RuntimeFileContentResponse>({
		enabled: selectedPath !== null && projectId !== null,
		queryFn: fileContentQueryFn,
	});

	// Clear stale content immediately when the selected file changes
	const [prevSelectedPath, setPrevSelectedPath] = useState(selectedPath);
	if (selectedPath !== prevSelectedPath) {
		setPrevSelectedPath(selectedPath);
		fileContentQuery.setData(null);
	}

	const handleCloseFile = useCallback(() => {
		setSelectedPathPersisted(null);
	}, [setSelectedPathPersisted]);

	const getFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!projectId) return null;
			try {
				const trpcClient = getRuntimeTrpcClient(projectId);
				return await trpcClient.project.getFileContent.query({
					taskId,
					...(baseRef ? { baseRef } : {}),
					path,
					...(browseRef ? { ref: browseRef } : {}),
				});
			} catch {
				return null;
			}
		},
		[projectId, taskId, baseRef, browseRef],
	);

	return {
		files: fileListQuery.data?.files ?? null,
		selectedPath,
		onSelectPath: setSelectedPathPersisted,
		fileContent: fileContentQuery.data ?? null,
		isContentLoading: fileContentQuery.isLoading,
		isContentError: fileContentQuery.isError,
		onCloseFile: handleCloseFile,
		getFileContent,
	};
}
