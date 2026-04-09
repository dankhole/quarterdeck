import type { MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
	onSelectPath,
	treePanelFlex,
	contentPanelFlex,
	onTreeResizeStart,
	expandedDirs,
	onExpandedDirsChange,
	hasInitializedExpansion,
	onInitializedExpansion,
}: {
	taskId: string;
	baseRef: string;
	workspaceId: string;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	treePanelFlex: string;
	contentPanelFlex: string;
	onTreeResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
	expandedDirs: Set<string>;
	onExpandedDirsChange: (value: SetStateAction<Set<string>>) => void;
	hasInitializedExpansion: boolean;
	onInitializedExpansion: () => void;
}): React.ReactElement {
	const listFilesQueryFn = useCallback(async () => {
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.listFiles.query({ taskId, baseRef });
	}, [workspaceId, taskId, baseRef]);

	const fileListQuery = useTrpcQuery<RuntimeListFilesResponse>({
		enabled: true,
		queryFn: listFilesQueryFn,
	});

	const refetchRef = useRef(fileListQuery.refetch);
	refetchRef.current = fileListQuery.refetch;
	useEffect(() => {
		const id = setInterval(() => {
			refetchRef.current();
		}, FILE_LIST_POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

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

	// Clear stale content immediately when the selected file changes so the
	// viewer never flashes the previous file's content while the new request
	// is in flight.
	const [prevSelectedPath, setPrevSelectedPath] = useState(selectedPath);
	if (selectedPath !== prevSelectedPath) {
		setPrevSelectedPath(selectedPath);
		fileContentQuery.setData(null);
	}

	return (
		<div className="flex flex-1 min-w-0 min-h-0">
			<div className="flex min-w-0 min-h-0" style={{ flex: `0 0 ${treePanelFlex}` }}>
				<FileBrowserTreePanel
					files={fileListQuery.data?.files ?? null}
					selectedPath={selectedPath}
					onSelectPath={onSelectPath}
					panelFlex="1 1 0"
					expandedDirs={expandedDirs}
					onExpandedDirsChange={onExpandedDirsChange}
					hasInitializedExpansion={hasInitializedExpansion}
					onInitializedExpansion={onInitializedExpansion}
				/>
			</div>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize file browser panels"
				onMouseDown={onTreeResizeStart}
				className="z-10"
			/>
			<div className="flex min-w-0 min-h-0" style={{ flex: `0 0 ${contentPanelFlex}` }}>
				<FileContentViewer
					content={fileContentQuery.data?.content ?? null}
					binary={fileContentQuery.data?.binary ?? false}
					truncated={fileContentQuery.data?.truncated ?? false}
					isLoading={fileContentQuery.isLoading}
					isError={fileContentQuery.isError}
					filePath={selectedPath}
				/>
			</div>
		</div>
	);
}
