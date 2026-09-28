import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createFileContentRequest, createFileSaveRequest, type FileBrowserScope } from "./file-browser-scope";
import { getFileEditorScopeGeneration, subscribeFileEditorCache } from "./file-editor-cache";

interface ScopedFileContent {
	readonly scopeKey: string;
	readonly generation: number | undefined;
	readonly path: string;
	readonly content: RuntimeFileContentResponse;
}

export interface UseFileContentDataResult {
	readonly fileContent: RuntimeFileContentResponse | null;
	readonly isContentLoading: boolean;
	readonly isContentError: boolean;
	getFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
	reloadFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
	saveFileContent: (path: string, content: string, expectedContentHash: string) => Promise<RuntimeFileContentResponse>;
	clearFileContent: () => void;
}

export function useFileContentData(scope: FileBrowserScope, selectedPath: string | null): UseFileContentDataResult {
	const getScopeGeneration = useCallback(
		() => getFileEditorScopeGeneration(scope.contentScopeKey),
		[scope.contentScopeKey],
	);
	const scopeGeneration = useSyncExternalStore(subscribeFileEditorCache, getScopeGeneration);
	const selectedPathRef = useRef(selectedPath);
	const contentScopeKeyRef = useRef(scope.contentScopeKey);
	selectedPathRef.current = selectedPath;
	contentScopeKeyRef.current = scope.contentScopeKey;

	const fileContentQueryFn = useCallback(async () => {
		if (!selectedPath || !scope.projectId) {
			throw new Error("No file selected.");
		}
		const trpcClient = getRuntimeTrpcClient(scope.projectId);
		const content = await trpcClient.project.getFileContent.query(createFileContentRequest(scope, selectedPath));
		return { scopeKey: scope.contentScopeKey, generation: scopeGeneration, path: selectedPath, content };
	}, [scope, scopeGeneration, selectedPath]);

	const fileContentQuery = useTrpcQuery<ScopedFileContent>({
		enabled: scope.canQueryRuntime && selectedPath !== null,
		queryFn: fileContentQueryFn,
	});
	const setFileContentData = fileContentQuery.setData;
	const activeContentCacheKey = useMemo(
		() => JSON.stringify({ contentScopeKey: scope.contentScopeKey, scopeGeneration, selectedPath }),
		[scope.contentScopeKey, scopeGeneration, selectedPath],
	);
	const [contentCacheKey, setContentCacheKey] = useState(activeContentCacheKey);

	useEffect(() => {
		setFileContentData(null);
		setContentCacheKey(activeContentCacheKey);
	}, [activeContentCacheKey, setFileContentData]);

	const hasActiveContentCache = contentCacheKey === activeContentCacheKey;
	const snapshot = fileContentQuery.data;
	// Retirement can keep the same project, task, root, and path. Only content read
	// for the current cache generation may hydrate its replacement workspace.
	const fileContent =
		hasActiveContentCache &&
		snapshot?.scopeKey === scope.contentScopeKey &&
		snapshot.generation === scopeGeneration &&
		snapshot.path === selectedPath
			? snapshot.content
			: null;
	const isContentError = hasActiveContentCache && fileContentQuery.isError;
	const isContentLoading =
		scope.enabled &&
		(fileContentQuery.isLoading ||
			(scope.projectId !== null && selectedPath !== null && fileContent === null && !isContentError));

	const getFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!scope.enabled || !scope.projectId || scopeGeneration !== getScopeGeneration()) return null;
			try {
				const trpcClient = getRuntimeTrpcClient(scope.projectId);
				const content = await trpcClient.project.getFileContent.query(createFileContentRequest(scope, path));
				return scopeGeneration === getScopeGeneration() ? content : null;
			} catch {
				return null;
			}
		},
		[scope, scopeGeneration, getScopeGeneration],
	);

	const reloadFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!scope.enabled) return null;
			const requestScopeKey = scope.contentScopeKey;
			const result = await getFileContent(path);
			if (
				result &&
				path === selectedPathRef.current &&
				requestScopeKey === contentScopeKeyRef.current &&
				scopeGeneration === getScopeGeneration()
			) {
				setFileContentData({ scopeKey: requestScopeKey, generation: scopeGeneration, path, content: result });
			}
			return result;
		},
		[getFileContent, getScopeGeneration, scope.contentScopeKey, scope.enabled, scopeGeneration, setFileContentData],
	);

	const saveFileContent = useCallback(
		async (path: string, content: string, expectedContentHash: string): Promise<RuntimeFileContentResponse> => {
			if (!scope.enabled) throw new Error("Files view is not active.");
			if (!scope.projectId) throw new Error("Missing project.");
			if (scope.isReadOnly) throw new Error("Branch/ref browsing is read-only.");
			if (scopeGeneration !== getScopeGeneration()) throw new Error("The file workspace changed. Reload the file.");
			const requestScopeKey = scope.contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(scope.projectId);
			const result = await trpcClient.project.saveFileContent.mutate(
				createFileSaveRequest(scope, path, content, expectedContentHash),
			);
			if (
				path === selectedPathRef.current &&
				requestScopeKey === contentScopeKeyRef.current &&
				scopeGeneration === getScopeGeneration()
			) {
				setFileContentData({ scopeKey: requestScopeKey, generation: scopeGeneration, path, content: result });
			}
			return result;
		},
		[getScopeGeneration, scope, scopeGeneration, setFileContentData],
	);

	const clearFileContent = useCallback(() => {
		setFileContentData(null);
	}, [setFileContentData]);

	return {
		fileContent,
		isContentLoading,
		isContentError,
		getFileContent,
		reloadFileContent,
		saveFileContent,
		clearFileContent,
	};
}
