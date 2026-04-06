import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { FileBrowserTreePanel } from "@/components/detail-panels/file-browser-tree-panel";
import { FileContentViewer } from "@/components/detail-panels/file-content-viewer";
import { ResizeHandle } from "@/resize/resize-handle";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const FILE_LIST_POLL_INTERVAL_MS = 5_000;

export function FileBrowserPanel({
	taskId,
	baseRef,
	workspaceId,
	selectedPath,
	onSelectedPathChange,
	treePanelFlex,
	contentPanelFlex,
	onTreeResizeStart,
}: {
	taskId: string;
	baseRef: string;
	workspaceId: string;
	selectedPath: string | null;
	onSelectedPathChange: (path: string | null) => void;
	treePanelFlex: string;
	contentPanelFlex: string;
	onTreeResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
}): React.ReactElement {
	const listFilesQueryFn = useCallback(async () => {
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.listFiles.query({ taskId, baseRef });
	}, [workspaceId, taskId, baseRef]);

	const fileListQuery = useTrpcQuery<RuntimeListFilesResponse>({
		enabled: true,
		queryFn: listFilesQueryFn,
	});

	const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		pollTimerRef.current = setInterval(() => {
			fileListQuery.refetch();
		}, FILE_LIST_POLL_INTERVAL_MS);
		return () => {
			if (pollTimerRef.current) {
				clearInterval(pollTimerRef.current);
			}
		};
	}, [fileListQuery.refetch]);

	const fileContentQueryFn = useCallback(async () => {
		if (!selectedPath) {
			throw new Error("No file selected.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getFileContent.query({ taskId, baseRef, path: selectedPath });
	}, [workspaceId, taskId, baseRef, selectedPath]);

	const fileContentQuery = useTrpcQuery<RuntimeFileContentResponse>({
		enabled: selectedPath !== null,
		queryFn: fileContentQueryFn,
	});

	return (
		<div className="flex flex-1 min-w-0 min-h-0">
			<div
				style={{
					display: "flex",
					flex: `0 0 ${treePanelFlex}`,
					minWidth: 0,
					minHeight: 0,
				}}
			>
				<FileBrowserTreePanel
					files={fileListQuery.data?.files ?? null}
					selectedPath={selectedPath}
					onSelectPath={onSelectedPathChange}
					panelFlex="1 1 0"
				/>
			</div>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize file browser panels"
				onMouseDown={onTreeResizeStart}
				className="z-10"
			/>
			<div
				style={{
					display: "flex",
					flex: `0 0 ${contentPanelFlex}`,
					minWidth: 0,
					minHeight: 0,
				}}
			>
				<FileContentViewer
					content={fileContentQuery.data?.content ?? null}
					binary={fileContentQuery.data?.binary ?? false}
					truncated={fileContentQuery.data?.truncated ?? false}
					isLoading={fileContentQuery.isLoading}
					filePath={selectedPath}
				/>
			</div>
		</div>
	);
}
