import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeFileContentResponse,
	RuntimeWorkdirEntryKind,
	RuntimeWorkdirEntryMutationResponse,
} from "@/runtime/types";
import {
	createWorkdirEntryCreateRequest,
	createWorkdirEntryDeleteRequest,
	createWorkdirEntryRenameRequest,
	resolveFileBrowserMutationBlockedReason,
	resolveFileBrowserScope,
} from "./file-browser-scope";
import { getLastSelectedFileBrowserPath, setLastSelectedFileBrowserPath } from "./file-browser-selection-cache";
import { useFileContentData } from "./use-file-content-data";
import { useFileTreeData } from "./use-file-tree-data";

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
	const scope = useMemo(
		() => resolveFileBrowserScope({ projectId, taskId, baseRef, ref: browseRef, enabled }),
		[baseRef, browseRef, enabled, projectId, taskId],
	);
	const contentScopeKey = scope.contentScopeKey;
	const treeData = useFileTreeData(scope);
	const contentData = useFileContentData(scope, selectedPath);
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
			setLastSelectedFileBrowserPath(key, path);
		},
		[contentScopeKey],
	);

	// Restore last selected file when the scope changes, or clear if none was remembered.
	useEffect(() => {
		const restored = getLastSelectedFileBrowserPath(contentScopeKey);
		setSelectedPathPersisted(restored);
	}, [contentScopeKey, setSelectedPathPersisted]);

	// Clear restored selection if the file no longer exists in the loaded file list.
	const files = treeData.fileListData?.files;
	useEffect(() => {
		if (selectedPath && files && !files.includes(selectedPath)) {
			setSelectedPathPersisted(null);
		}
	}, [selectedPath, files, setSelectedPathPersisted]);

	const mutationBlockedReason = resolveFileBrowserMutationBlockedReason({
		scope,
		fileListData: treeData.fileListData,
	});
	const canMutateEntries = mutationBlockedReason === null;

	const handleCloseFile = useCallback(() => {
		setSelectedPathPersisted(null);
	}, [setSelectedPathPersisted]);

	const createEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!scope.projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(scope.projectId);
			const result = await trpcClient.project.createWorkdirEntry.mutate(
				createWorkdirEntryCreateRequest(scope, path, kind),
			);
			await treeData.reloadFileListForScope(requestScopeKey);
			if (requestScopeKey === contentScopeKeyRef.current && kind === "file") {
				setSelectedPathPersisted(result.path);
			}
			return result;
		},
		[contentScopeKey, mutationBlockedReason, scope, setSelectedPathPersisted, treeData.reloadFileListForScope],
	);

	const renameEntry = useCallback(
		async (
			path: string,
			nextPath: string,
			kind: RuntimeWorkdirEntryKind,
		): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!scope.projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(scope.projectId);
			const result = await trpcClient.project.renameWorkdirEntry.mutate(
				createWorkdirEntryRenameRequest(scope, path, nextPath, kind),
			);
			await treeData.reloadFileListForScope(requestScopeKey);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			const currentPath = selectedPathRef.current;
			if (currentPath === path || (kind === "directory" && currentPath?.startsWith(`${path}/`))) {
				const renamedPath =
					currentPath === path ? result.path : `${result.path}/${currentPath.slice(path.length + 1)}`;
				setSelectedPathPersisted(renamedPath);
				contentData.clearFileContent();
			}
			return result;
		},
		[
			contentScopeKey,
			contentData.clearFileContent,
			mutationBlockedReason,
			scope,
			setSelectedPathPersisted,
			treeData.reloadFileListForScope,
		],
	);

	const deleteEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (mutationBlockedReason) throw new Error(mutationBlockedReason);
			if (!scope.projectId) throw new Error("No project selected.");
			const requestScopeKey = contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(scope.projectId);
			const result = await trpcClient.project.deleteWorkdirEntry.mutate(
				createWorkdirEntryDeleteRequest(scope, path, kind),
			);
			await treeData.reloadFileListForScope(requestScopeKey);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			if (
				selectedPathRef.current === path ||
				(kind === "directory" && selectedPathRef.current?.startsWith(`${path}/`))
			) {
				setSelectedPathPersisted(null);
				contentData.clearFileContent();
			}
			return result;
		},
		[
			contentScopeKey,
			contentData.clearFileContent,
			mutationBlockedReason,
			scope,
			setSelectedPathPersisted,
			treeData.reloadFileListForScope,
		],
	);

	return {
		files: treeData.files,
		directories: treeData.directories,
		contentScopeKey,
		searchScope: scope.searchScope,
		canMutateEntries,
		mutationBlockedReason,
		selectedPath,
		onSelectPath: setSelectedPathPersisted,
		fileContent: contentData.fileContent,
		isContentLoading: contentData.isContentLoading,
		isContentError: contentData.isContentError,
		onCloseFile: handleCloseFile,
		isReadOnly: scope.isReadOnly,
		getFileContent: contentData.getFileContent,
		reloadFileContent: contentData.reloadFileContent,
		saveFileContent: contentData.saveFileContent,
		createEntry,
		renameEntry,
		deleteEntry,
	};
}
