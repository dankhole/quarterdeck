import { useCallback } from "react";
import { SourceEditor } from "@/components/editor/source-editor";
import { Button } from "@/components/ui/button";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const ignoreChange = (): void => {};

/** An ephemeral live-file reader, deliberately outside the editable Files workspace. */
export function CompareFilePreview({
	projectId,
	taskId,
	baseRef,
	navigation,
	onClose,
}: {
	projectId: string;
	taskId: string | null;
	baseRef: string | null;
	navigation: FileNavigation;
	onClose: () => void;
}): React.ReactElement {
	const path = navigation.codeLocation?.path ?? navigation.filePath;
	const queryKey = JSON.stringify([projectId, taskId, baseRef, navigation]);
	const queryFn = useCallback(
		async () => ({
			key: queryKey,
			content: await getRuntimeTrpcClient(projectId).project.getFileContent.query({
				taskId,
				...(baseRef ? { baseRef } : {}),
				path,
			}),
		}),
		[projectId, taskId, baseRef, path, queryKey],
	);
	const query = useTrpcQuery({ enabled: true, queryFn });
	const content = query.data?.key === queryKey ? query.data.content : null;
	return (
		<section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Read-only live file preview">
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3">
				<Button size="sm" onClick={onClose}>
					Back to comparison
				</Button>
				<span className="truncate text-xs text-text-primary">{path}</span>
				<span className="ml-auto shrink-0 text-xs text-text-secondary">Live file · Read-only</span>
			</div>
			{query.isError ? (
				<p role="alert" className="p-4 text-status-red">
					Could not read the live file: {query.error?.message}
				</p>
			) : !content ? (
				<p role="status" className="p-4 text-text-secondary">
					Loading live file…
				</p>
			) : content.binary || content.truncated ? (
				<p role="alert" className="p-4 text-text-secondary">
					This file cannot be previewed as complete text.
				</p>
			) : (
				<SourceEditor
					key={queryKey}
					path={path}
					language={content.language}
					value={content.content}
					readOnly
					wordWrap={false}
					scrollToRange={navigation.codeLocation?.range}
					scrollToLine={navigation.codeLocation ? undefined : navigation.lineNumber}
					onChange={ignoreChange}
				/>
			)}
		</section>
	);
}
