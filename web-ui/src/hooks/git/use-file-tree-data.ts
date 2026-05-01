import { useCallback, useEffect, useRef, useState } from "react";

import { areListFilesResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeListFilesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createListFilesRequest, type FileBrowserScope } from "./file-browser-scope";

const FILE_LIST_POLL_INTERVAL_MS = 5_000;

export interface UseFileTreeDataResult {
	readonly files: string[] | null;
	readonly directories: string[] | null;
	readonly fileListData: RuntimeListFilesResponse | null;
	reloadFileListForScope: (requestScopeKey: string) => Promise<RuntimeListFilesResponse | null>;
}

export function useFileTreeData(scope: FileBrowserScope): UseFileTreeDataResult {
	const listFilesQueryFn = useCallback(async () => {
		if (!scope.projectId) {
			throw new Error("Missing project.");
		}
		const trpcClient = getRuntimeTrpcClient(scope.projectId);
		return await trpcClient.project.listFiles.query(createListFilesRequest(scope));
	}, [scope]);

	const fileListQuery = useTrpcQuery<RuntimeListFilesResponse>({
		enabled: scope.canQueryRuntime,
		queryFn: listFilesQueryFn,
		isDataEqual: areListFilesResponsesEqual,
	});
	const setFileListData = fileListQuery.setData;
	const [fileListCacheKey, setFileListCacheKey] = useState(scope.contentScopeKey);
	const contentScopeKeyRef = useRef(scope.contentScopeKey);
	contentScopeKeyRef.current = scope.contentScopeKey;

	useEffect(() => {
		setFileListData(null);
		setFileListCacheKey(scope.contentScopeKey);
	}, [scope.contentScopeKey, setFileListData]);

	const refetchRef = useRef(fileListQuery.refetch);
	refetchRef.current = fileListQuery.refetch;
	useEffect(() => {
		if (!scope.enabled || scope.browseRef) {
			return;
		}
		const id = setInterval(() => {
			refetchRef.current();
		}, FILE_LIST_POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [scope.browseRef, scope.enabled]);

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

	const hasActiveFileListCache = fileListCacheKey === scope.contentScopeKey;
	const fileListData = hasActiveFileListCache ? fileListQuery.data : null;

	return {
		files: fileListData?.files ?? null,
		directories: fileListData?.directories ?? null,
		fileListData,
		reloadFileListForScope,
	};
}
