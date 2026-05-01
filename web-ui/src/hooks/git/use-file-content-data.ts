import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createFileContentRequest, createFileSaveRequest, type FileBrowserScope } from "./file-browser-scope";

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
	const selectedPathRef = useRef(selectedPath);
	const contentScopeKeyRef = useRef(scope.contentScopeKey);
	selectedPathRef.current = selectedPath;
	contentScopeKeyRef.current = scope.contentScopeKey;

	const fileContentQueryFn = useCallback(async () => {
		if (!selectedPath || !scope.projectId) {
			throw new Error("No file selected.");
		}
		const trpcClient = getRuntimeTrpcClient(scope.projectId);
		return await trpcClient.project.getFileContent.query(createFileContentRequest(scope, selectedPath));
	}, [scope, selectedPath]);

	const fileContentQuery = useTrpcQuery<RuntimeFileContentResponse>({
		enabled: scope.canQueryRuntime && selectedPath !== null,
		queryFn: fileContentQueryFn,
	});
	const setFileContentData = fileContentQuery.setData;
	const activeContentCacheKey = useMemo(
		() => JSON.stringify({ contentScopeKey: scope.contentScopeKey, selectedPath }),
		[scope.contentScopeKey, selectedPath],
	);
	const [contentCacheKey, setContentCacheKey] = useState(activeContentCacheKey);

	useEffect(() => {
		setFileContentData(null);
		setContentCacheKey(activeContentCacheKey);
	}, [activeContentCacheKey, setFileContentData]);

	const hasActiveContentCache = contentCacheKey === activeContentCacheKey;
	const fileContent = hasActiveContentCache ? (fileContentQuery.data ?? null) : null;
	const isContentError = hasActiveContentCache && fileContentQuery.isError;
	const isContentLoading =
		scope.enabled &&
		(fileContentQuery.isLoading ||
			(scope.projectId !== null && selectedPath !== null && fileContent === null && !isContentError));

	const getFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!scope.enabled || !scope.projectId) return null;
			try {
				const trpcClient = getRuntimeTrpcClient(scope.projectId);
				return await trpcClient.project.getFileContent.query(createFileContentRequest(scope, path));
			} catch {
				return null;
			}
		},
		[scope],
	);

	const reloadFileContent = useCallback(
		async (path: string): Promise<RuntimeFileContentResponse | null> => {
			if (!scope.enabled) return null;
			const requestScopeKey = scope.contentScopeKey;
			const result = await getFileContent(path);
			if (result && path === selectedPathRef.current && requestScopeKey === contentScopeKeyRef.current) {
				setFileContentData(result);
			}
			return result;
		},
		[getFileContent, scope.contentScopeKey, scope.enabled, setFileContentData],
	);

	const saveFileContent = useCallback(
		async (path: string, content: string, expectedContentHash: string): Promise<RuntimeFileContentResponse> => {
			if (!scope.enabled) throw new Error("Files view is not active.");
			if (!scope.projectId) throw new Error("Missing project.");
			if (scope.isReadOnly) throw new Error("Branch/ref browsing is read-only.");
			const requestScopeKey = scope.contentScopeKey;
			const trpcClient = getRuntimeTrpcClient(scope.projectId);
			const result = await trpcClient.project.saveFileContent.mutate(
				createFileSaveRequest(scope, path, content, expectedContentHash),
			);
			if (path === selectedPathRef.current && requestScopeKey === contentScopeKeyRef.current) {
				setFileContentData(result);
			}
			return result;
		},
		[scope, setFileContentData],
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
