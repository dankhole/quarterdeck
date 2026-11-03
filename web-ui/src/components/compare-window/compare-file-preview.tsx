import * as Dialog from "@radix-ui/react-dialog";
import { useCallback } from "react";
import { SourceEditor } from "@/components/editor/source-editor";
import { Button } from "@/components/ui/button";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const ignoreChange = (): void => {};

/** Floating live-file reader; the underlying review remains mounted and keeps its position. */
export function CompareFilePreview({
	projectId,
	taskId,
	baseRef,
	navigation,
	onClose,
	onReturnFocus,
}: {
	projectId: string;
	taskId: string | null;
	baseRef: string | null;
	navigation: FileNavigation;
	onClose: () => void;
	onReturnFocus: () => void;
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
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
				<Dialog.Content
					aria-label="Read-only live file preview"
					aria-describedby="source-peek-description"
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						onReturnFocus();
					}}
					className="fixed inset-4 z-50 m-auto flex min-h-0 min-w-0 max-w-6xl flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-0 shadow-2xl focus:outline-none sm:inset-10"
				>
					<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3">
						<Button size="sm" onClick={onClose}>
							Back to comparison
						</Button>
						<Dialog.Title className="truncate text-xs text-text-primary">{path}</Dialog.Title>
						<span className="ml-auto shrink-0 text-xs text-text-secondary">Live file · Read-only snapshot</span>
					</div>
					<Dialog.Description id="source-peek-description" className="sr-only">
						Read-only live source peek. Escape closes the peek and returns to your unchanged review position.
					</Dialog.Description>
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
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
