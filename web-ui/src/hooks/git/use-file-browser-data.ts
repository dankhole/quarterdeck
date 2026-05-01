import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorkdirSearchScope, type WorkdirSearchScope } from "@/hooks/search/search-scope";
import { areListFilesResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeFileContentResponse,
	RuntimeListFilesResponse,
	RuntimeWorkdirEntryKind,
	RuntimeWorkdirEntryMutationResponse,
} from "@/runtime/types";
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

function createContentScopeKey(input: {
	projectId: string | null;
	taskId: string | null;
	baseRef?: string;
	ref?: string | null;
}): string {
	return JSON.stringify({
		projectId: input.projectId ?? "__no_project__",
		taskId: input.taskId ?? "__home__",
		baseRef: input.baseRef ?? "__default_base__",
		ref: input.ref ?? "__live__",
	});
}

export interface UseFileBrowserDataResult {
	files: string[] | null;
	directories: string[] | null;
	contentScopeKey: string;
	searchScope: WorkdirSearchScope;
	canMutateEntries: boolean;
	mutationBlockedReason: string | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	fileContent: RuntimeFileContentResponse | null;
	isContentLoading: boolean;
	isContentError: boolean;
	onCloseFile: () => void;
	isReadOnly: boolean;
	/** Fetch file content for an arbitrary path (used by "Copy file contents" context menu action). */
	getFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
	/** Reload file content from disk without changing the active selection. */
	reloadFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
	/** Save text content for a live worktree file. Unavailable while browsing a branch/ref snapshot. */
	saveFileContent: (path: string, content: string, expectedContentHash: string) => Promise<RuntimeFileContentResponse>;
	createEntry: (path: string, kind: RuntimeWorkdirEntryKind) => Promise<RuntimeWorkdirEntryMutationResponse>;
	renameEntry: (
		path: string,
		nextPath: string,
		kind: RuntimeWorkdirEntryKind,
	) => Promise<RuntimeWorkdirEntryMutationResponse>;
	deleteEntry: (path: string, kind: RuntimeWorkdirEntryKind) => Promise<RuntimeWorkdirEntryMutationResponse>;
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
	/** Keep cheap scope state available while skipping file-list/content IO. */
	enabled?: boolean;
}): UseFileBrowserDataResult {
	const { projectId, taskId, baseRef, ref: browseRef, enabled = true } = options;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const contentScopeKey = useMemo(
		() => createContentScopeKey({ projectId, taskId, baseRef, ref: browseRef }),
		[baseRef, browseRef, projectId, taskId],
	);
	const searchScope = useMemo(
		() => createWorkdirSearchScope({ taskId, baseRef, ref: browseRef ?? undefined }),
		[baseRef, browseRef, taskId],
	);
	const selectedPathRef = useRef(selectedPath);
	const contentScopeKeyRef = useRef(contentScopeKey);
	selectedPathRef.current = selectedPath;
	contentScopeKeyRef.current = contentScopeKey;

	// Wrap setSelectedPath to also persist in the module-level cache + localStorage.
	const setSelectedPathPersisted = useCallback(
		(path: string | null) => {
			selectedPathRef.current = path;
			setSelectedPath(path);
			const key = contentScopeKey;
			if (path) {
				lastSelectedPathByScope.set(key, path);
			} else {
				lastSelectedPathByScope.delete(key);
			}
			persistCacheToStorage();
		},
		[contentScopeKey],
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
		enabled: enabled && projectId !== null,
		queryFn: listFilesQueryFn,
		isDataEqual: areListFilesResponsesEqual,
	});
	const setFileListData = fileListQuery.setData;
	const [fileListCacheKey, setFileListCacheKey] = useState(contentScopeKey);
	useEffect(() => {
		setFileListData(null);
		setFileListCacheKey(contentScopeKey);
	}, [contentScopeKey, setFileListData]);
	const hasActiveFileListCache = fileListCacheKey === contentScopeKey;
	const fileListData = hasActiveFileListCache ? fileListQuery.data : null;

	// Restore last selected file when the scope changes, or clear if none was remembered.
	useEffect(() => {
		const restored = lastSelectedPathByScope.get(contentScopeKey) ?? null;
		setSelectedPathPersisted(restored);
	}, [contentScopeKey, setSelectedPathPersisted]);

	// Clear restored selection if the file no longer exists in the loaded file list.
	const files = fileListData?.files;
	useEffect(() => {
		if (selectedPath && files && !files.includes(selectedPath)) {
			setSelectedPathPersisted(null);
		}
	}, [selectedPath, files, setSelectedPathPersisted]);

	// Poll for file list changes — but not in branch view mode (immutable tree)
	const refetchRef = useRef(fileListQuery.refetch);
	refetchRef.current = fileListQuery.refetch;
	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (browseRef) {
			return; // Branch view: ref tree is immutable, no polling needed
		}
		const id = setInterval(() => {
			refetchRef.current();
		}, FILE_LIST_POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [browseRef, enabled]);

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
		enabled: enabled && selectedPath !== null && projectId !== null,
		queryFn: fileContentQueryFn,
	});
	const setFileContentData = fileContentQuery.setData;
	const activeContentCacheKey = useMemo(
		() => JSON.stringify({ contentScopeKey, selectedPath }),
		[contentScopeKey, selectedPath],
	);
	const [contentCacheKey, setContentCacheKey] = useState(activeContentCacheKey);
	const mutationBlockedReason =
		(projectId === null
			? "No project selected."
			: !enabled
				? "Files view is not active."
				: browseRef
					? "Branch/ref browsing is read-only."
					: fileListData === null
						? "Files are still loading."
						: fileListData.mutable === false
							? (fileListData.mutationBlockedReason ?? "File operations are unavailable.")
							: null) ?? null;
	const canMutateEntries = mutationBlockedReason === null;

	// Hide content/error state from the previous file while the next selection is loading.
	useEffect(() => {
		setFileContentData(null);
		setContentCacheKey(activeContentCacheKey);
	}, [activeContentCacheKey, setFileContentData]);
	const hasActiveContentCache = contentCacheKey === activeContentCacheKey;
	const fileContent = hasActiveContentCache ? (fileContentQuery.data ?? null) : null;
	const isContentError = hasActiveContentCache && fileContentQuery.isError;
	const isContentLoading =
		enabled &&
		(fileContentQuery.isLoading ||
			(projectId !== null && selectedPath !== null && fileContent === null && !isContentError));

	const handleCloseFile = useCallback(() => {
		setSelectedPathPersisted(null);
	}, [setSelectedPathPersisted]);

	const getFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!enabled) return null;
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
		[enabled, projectId, taskId, baseRef, browseRef],
	);

	const reloadFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!enabled) return null;
			const requestScopeKey = contentScopeKey;
			const result = await getFileContent(path);
			if (result && path === selectedPathRef.current && requestScopeKey === contentScopeKeyRef.current) {
				setFileContentData(result);
			}
			return result;
		},
		[contentScopeKey, enabled, getFileContent, setFileContentData],
	);

	const saveFileContent = useCallback(
		async (path: string, content: string, expectedContentHash: string): Promise<RuntimeFileContentResponse> => {
			if (!enabled) throw new Error("Files view is not active.");
			if (!projectId) throw new Error("Missing project.");
			if (browseRef) throw new Error("Branch/ref browsing is read-only.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(projectId);
			const result = await trpcClient.project.saveFileContent.mutate({
				taskId,
				...(baseRef ? { baseRef } : {}),
				path,
				content,
				expectedContentHash,
			});
			if (path === selectedPathRef.current && requestScopeKey === contentScopeKeyRef.current) {
				setFileContentData(result);
			}
			return result;
		},
		[baseRef, browseRef, contentScopeKey, enabled, projectId, setFileContentData, taskId],
	);

	const reloadFileListForScope = useCallback(
		async (requestScopeKey: string): Promise<RuntimeListFilesResponse | null> => {
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return null;
			}
			const result = await listFilesQueryFn();
			if (requestScopeKey === contentScopeKeyRef.current) {
				setFileListData(result);
			}
			return result;
		},
		[listFilesQueryFn, setFileListData],
	);

	const createEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(projectId);
			const result = await trpcClient.project.createWorkdirEntry.mutate({
				taskId,
				...(baseRef ? { baseRef } : {}),
				path,
				kind,
			});
			await reloadFileListForScope(requestScopeKey);
			if (requestScopeKey === contentScopeKeyRef.current && kind === "file") {
				setSelectedPathPersisted(result.path);
			}
			return result;
		},
		[
			baseRef,
			contentScopeKey,
			mutationBlockedReason,
			projectId,
			reloadFileListForScope,
			setSelectedPathPersisted,
			taskId,
		],
	);

	const renameEntry = useCallback(
		async (
			path: string,
			nextPath: string,
			kind: RuntimeWorkdirEntryKind,
		): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(projectId);
			const result = await trpcClient.project.renameWorkdirEntry.mutate({
				taskId,
				...(baseRef ? { baseRef } : {}),
				path,
				nextPath,
				kind,
			});
			await reloadFileListForScope(requestScopeKey);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			const currentPath = selectedPathRef.current;
			if (currentPath === path || (kind === "directory" && currentPath?.startsWith(`${path}/`))) {
				const renamedPath =
					currentPath === path ? result.path : `${result.path}/${currentPath.slice(path.length + 1)}`;
				setSelectedPathPersisted(renamedPath);
				setFileContentData(null);
			}
			return result;
		},
		[
			baseRef,
			contentScopeKey,
			mutationBlockedReason,
			projectId,
			reloadFileListForScope,
			setFileContentData,
			setSelectedPathPersisted,
			taskId,
		],
	);

	const deleteEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(projectId);
			const result = await trpcClient.project.deleteWorkdirEntry.mutate({
				taskId,
				...(baseRef ? { baseRef } : {}),
				path,
				kind,
			});
			await reloadFileListForScope(requestScopeKey);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			if (
				selectedPathRef.current === path ||
				(kind === "directory" && selectedPathRef.current?.startsWith(`${path}/`))
			) {
				setSelectedPathPersisted(null);
				setFileContentData(null);
			}
			return result;
		},
		[
			baseRef,
			contentScopeKey,
			mutationBlockedReason,
			projectId,
			reloadFileListForScope,
			setFileContentData,
			setSelectedPathPersisted,
			taskId,
		],
	);

	return {
		files: fileListData?.files ?? null,
		directories: fileListData?.directories ?? null,
		contentScopeKey,
		searchScope,
		canMutateEntries,
		mutationBlockedReason,
		selectedPath,
		onSelectPath: setSelectedPathPersisted,
		fileContent,
		isContentLoading,
		isContentError,
		onCloseFile: handleCloseFile,
		isReadOnly: Boolean(browseRef),
		getFileContent,
		reloadFileContent,
		saveFileContent,
		createEntry,
		renameEntry,
		deleteEntry,
	};
}
