import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeFileContentResponse,
	RuntimeListFilesResponse,
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
import { type FileEditorScopeIdentity, getFileEditorScopeGeneration } from "./file-editor-cache";
import type { FileTreeDirectoryPages } from "./file-tree-pages";
import { useFileContentData } from "./use-file-content-data";
import { useFileTreeData } from "./use-file-tree-data";

export interface UseFileBrowserDataResult {
	files: string[] | null;
	directoryPages: FileTreeDirectoryPages;
	showExcluded: boolean;
	setShowExcluded: (show: boolean) => void;
	setExpandedDirectories: (directories: ReadonlySet<string>) => void;
	loadDirectory: (directory: string, append?: boolean) => Promise<RuntimeListFilesResponse | null>;
	directories: string[] | null;
	fileListError: Error | null;
	contentScopeKey: string;
	editorScope?: FileEditorScopeIdentity;
	searchScope: WorkdirSearchScope;
	canMutateEntries: boolean;
	mutationBlockedReason: string | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	/** Select a runtime-validated code-navigation target in the current live workspace. */
	onSelectNavigationTarget: (path: string) => void;
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
	taskCreatedAt?: number;
	rootPath?: string | null;
	baseRef?: string;
	/** Browse files at a git ref (read-only). */
	ref?: string | null;
	/** Keep cheap scope state available while skipping file-list/content IO. */
	enabled?: boolean;
}): UseFileBrowserDataResult {
	const { projectId, taskId, taskCreatedAt, rootPath, baseRef, ref: browseRef, enabled = true } = options;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const scope = useMemo(
		() => resolveFileBrowserScope({ projectId, taskId, taskCreatedAt, rootPath, baseRef, ref: browseRef, enabled }),
		[baseRef, browseRef, enabled, projectId, taskId, taskCreatedAt, rootPath],
	);
	const editorScope = useMemo(
		() => ({ projectId, taskId, taskCreatedAt, rootPath }),
		[projectId, taskId, taskCreatedAt, rootPath],
	);
	const contentScopeKey = scope.contentScopeKey;
	const treeData = useFileTreeData(scope);
	const contentData = useFileContentData(scope, selectedPath);
	// Content data subscribes to the workspace generation, so retirement also expires these admissions.
	const scopeGeneration = getFileEditorScopeGeneration(contentScopeKey);
	const [navigationTargets, setNavigationTargets] = useState<{
		scopeKey: string;
		generation: number | undefined;
		paths: ReadonlySet<string>;
	} | null>(null);
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

	const selectNavigationTarget = useCallback(
		(path: string) => {
			if (
				!scope.canQueryRuntime ||
				scope.isReadOnly ||
				contentScopeKey !== contentScopeKeyRef.current ||
				scopeGeneration !== getFileEditorScopeGeneration(contentScopeKey)
			)
				return;
			setNavigationTargets({ scopeKey: contentScopeKey, generation: scopeGeneration, paths: new Set([path]) });
			setSelectedPathPersisted(path);
		},
		[contentScopeKey, scope.canQueryRuntime, scope.isReadOnly, scopeGeneration, setSelectedPathPersisted],
	);

	// Loaded pages are never evidence of deletion; explicit retirement still expires navigation admission.
	useEffect(() => {
		if (
			selectedPath &&
			navigationTargets?.scopeKey === contentScopeKey &&
			navigationTargets.generation !== scopeGeneration &&
			navigationTargets.paths.has(selectedPath)
		)
			setSelectedPathPersisted(null);
	}, [contentScopeKey, navigationTargets, scopeGeneration, selectedPath, setSelectedPathPersisted]);

	const selectPath = useCallback(
		(path: string | null) => {
			setNavigationTargets(null);
			setSelectedPathPersisted(path);
		},
		[setSelectedPathPersisted],
	);

	const mutationBlockedReason = resolveFileBrowserMutationBlockedReason({
		scope,
		fileListData: treeData.fileListData,
		fileListError: treeData.fileListError,
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
			if (requestScopeKey === contentScopeKeyRef.current) {
				treeData.revealEntry(result.path, kind);
				if (kind === "file") setSelectedPathPersisted(result.path);
			}
			await treeData.reloadFileListForScope(requestScopeKey, [path]);
			return result;
		},
		[
			contentScopeKey,
			mutationBlockedReason,
			scope,
			setSelectedPathPersisted,
			treeData.reloadFileListForScope,
			treeData.revealEntry,
		],
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
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			treeData.revealEntry(result.path, kind, path);
			const currentPath = selectedPathRef.current;
			if (currentPath === path || (kind === "directory" && currentPath?.startsWith(`${path}/`))) {
				const renamedPath =
					currentPath === path ? result.path : `${result.path}/${currentPath.slice(path.length + 1)}`;
				setSelectedPathPersisted(renamedPath);
				contentData.clearFileContent();
			}
			await treeData.reloadFileListForScope(requestScopeKey, [path, result.path]);
			return result;
		},
		[
			contentScopeKey,
			contentData.clearFileContent,
			mutationBlockedReason,
			scope,
			setSelectedPathPersisted,
			treeData.reloadFileListForScope,
			treeData.revealEntry,
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
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			treeData.revealEntry("", kind, path);
			if (
				selectedPathRef.current === path ||
				(kind === "directory" && selectedPathRef.current?.startsWith(`${path}/`))
			) {
				setSelectedPathPersisted(null);
				contentData.clearFileContent();
			}
			await treeData.reloadFileListForScope(requestScopeKey, [path]);
			return result;
		},
		[
			contentScopeKey,
			contentData.clearFileContent,
			mutationBlockedReason,
			scope,
			setSelectedPathPersisted,
			treeData.reloadFileListForScope,
			treeData.revealEntry,
		],
	);

	return {
		editorScope,
		files: treeData.files,
		directoryPages: treeData.directoryPages,
		showExcluded: treeData.showExcluded,
		setShowExcluded: treeData.setShowExcluded,
		setExpandedDirectories: treeData.setExpandedDirectories,
		loadDirectory: treeData.loadDirectory,
		directories: treeData.directories,
		fileListError: treeData.fileListError,
		contentScopeKey,
		searchScope: scope.searchScope,
		canMutateEntries,
		mutationBlockedReason,
		selectedPath,
		onSelectPath: selectPath,
		onSelectNavigationTarget: selectNavigationTarget,
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
