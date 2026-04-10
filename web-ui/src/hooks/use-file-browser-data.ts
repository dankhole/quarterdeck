import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const FILE_LIST_POLL_INTERVAL_MS = 5_000;

export interface UseFileBrowserDataResult {
	files: string[] | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	fileContent: RuntimeFileContentResponse | null;
	isContentLoading: boolean;
	isContentError: boolean;
	onCloseFile: () => void;
}

/**
 * Encapsulates file list + content fetching so the tree and content viewer
 * can be rendered in separate layout areas (sidebar vs main).
 */
export function useFileBrowserData(options: {
	workspaceId: string | null;
	taskId: string | null;
	baseRef?: string;
	/** Browse files at a git ref (read-only). */
	ref?: string | null;
}): UseFileBrowserDataResult {
	const { workspaceId, taskId, baseRef, ref: browseRef } = options;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	const listFilesQueryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.listFiles.query({
			taskId,
			...(baseRef ? { baseRef } : {}),
			...(browseRef ? { ref: browseRef } : {}),
		});
	}, [workspaceId, taskId, baseRef, browseRef]);

	const fileListQuery = useTrpcQuery<RuntimeListFilesResponse>({
		enabled: workspaceId !== null,
		queryFn: listFilesQueryFn,
	});

	// Clear selected file when the scope changes (different task, different ref, etc.)
	// so the viewer doesn't show stale content from a previous scope.
	useEffect(() => {
		setSelectedPath(null);
	}, [taskId, browseRef, workspaceId]);

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
		if (!selectedPath || !workspaceId) {
			throw new Error("No file selected.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getFileContent.query({
			taskId,
			...(baseRef ? { baseRef } : {}),
			path: selectedPath,
			...(browseRef ? { ref: browseRef } : {}),
		});
	}, [workspaceId, taskId, baseRef, selectedPath, browseRef]);

	const fileContentQuery = useTrpcQuery<RuntimeFileContentResponse>({
		enabled: selectedPath !== null && workspaceId !== null,
		queryFn: fileContentQueryFn,
	});

	// Clear stale content immediately when the selected file changes
	const [prevSelectedPath, setPrevSelectedPath] = useState(selectedPath);
	if (selectedPath !== prevSelectedPath) {
		setPrevSelectedPath(selectedPath);
		fileContentQuery.setData(null);
	}

	const handleCloseFile = useCallback(() => {
		setSelectedPath(null);
	}, []);

	return {
		files: fileListQuery.data?.files ?? null,
		selectedPath,
		onSelectPath: setSelectedPath,
		fileContent: fileContentQuery.data ?? null,
		isContentLoading: fileContentQuery.isLoading,
		isContentError: fileContentQuery.isError,
		onCloseFile: handleCloseFile,
	};
}
