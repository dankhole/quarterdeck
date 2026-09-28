import { useCallback, useMemo, useState } from "react";
import { ReviewDocumentDiff } from "@/components/editor/review-document-diff";
import { SourceEditor } from "@/components/editor/source-editor";
import { resolvePrismLanguage } from "@/components/shared/syntax-highlighting";
import { Button } from "@/components/ui/button";
import { type FileBrowserScopeOptions, resolveFileBrowserScope } from "@/hooks/git/file-browser-scope";
import { guardFileEditorScopes } from "@/hooks/git/file-editor-cache";
import { createReviewDocument } from "@/hooks/git/review-document";
import { useFileContentData } from "@/hooks/git/use-file-content-data";
import { useFileEditorWorkspace } from "@/hooks/git/use-file-editor-workspace";
import type { RuntimeConflictFile } from "@/runtime/types";
import { FileEditorPanel } from "./file-editor-panel";

export function ConflictResultEditor({
	file,
	repository,
	isMutating,
	resolveFile,
}: {
	file: RuntimeConflictFile;
	repository: FileBrowserScopeOptions;
	isMutating: boolean;
	resolveFile: (
		path: string,
		resolution: "ours" | "theirs" | "manual",
		expectedContentHash?: string,
	) => Promise<{ ok: boolean; error?: string }>;
}): React.ReactElement {
	const scope = useMemo(() => resolveFileBrowserScope({ ...repository, ref: null }), [repository]);
	const identity = useMemo(
		() => ({
			projectId: repository.projectId,
			taskId: repository.taskId,
			taskCreatedAt: repository.taskCreatedAt,
			rootPath: repository.rootPath,
		}),
		[repository],
	);
	const [source, setSource] = useState<"changes" | "base" | "ours" | "theirs">("changes");
	const content = useFileContentData(scope, file.path);
	const keepSelection = useCallback(() => {}, []);
	const workspace = useFileEditorWorkspace({
		scopeKey: scope.contentScopeKey,
		scope: identity,
		selectedPath: file.path,
		fileContent: content.fileContent,
		isContentLoading: content.isContentLoading,
		isContentError: content.isContentError,
		isReadOnly: isMutating,
		autosaveMode: "off",
		onSelectPath: keepSelection,
		onCloseFile: keepSelection,
		reloadFileContent: content.reloadFileContent,
		saveFileContent: content.saveFileContent,
	});
	const canCopySource = !file.binary && !file.sourcesUnavailable && workspace.canEditActiveTab && !isMutating;
	const replaceResult = (value: string): void => {
		if (!repository.projectId || !canCopySource) return;
		if (!guardFileEditorScopes({ projectId: repository.projectId, taskId: repository.taskId })) return;
		workspace.handleChangeActiveContent(value);
	};
	const review = createReviewDocument(
		{ repository, revisions: { kind: "conflict", base: ":2", head: ":3" } },
		file,
		file.sourcesUnavailable
			? {
					kind: "unavailable",
					message:
						"A conflict source is missing or could not be read. Resolve it using Git or an external editor.",
				}
			: file.binary
				? { kind: "binary" }
				: { kind: "text", oldText: file.oursContent, newText: file.theirsContent },
	);
	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0">
			<div className="flex items-center gap-2 p-2 border-b border-border text-xs">
				<span>Sources (read-only)</span>
				{(["changes", "base", "ours", "theirs"] as const).map((value) => (
					<Button
						key={value}
						size="sm"
						onClick={() => setSource(value)}
						variant={source === value ? "primary" : "default"}
					>
						{value === "changes"
							? "Ours → Theirs"
							: value === "base"
								? "Base"
								: value === "ours"
									? "Ours"
									: "Theirs"}
					</Button>
				))}
			</div>
			<div
				className="flex flex-col flex-1 min-h-0 overflow-auto border-b border-border"
				data-conflict-source={source}
			>
				{source === "changes" || file.binary || file.sourcesUnavailable ? (
					<ReviewDocumentDiff document={review} />
				) : (
					<SourceEditor
						key={`${review.key}:${source}`}
						path={file.path}
						language={resolvePrismLanguage(file.path) ?? ""}
						value={
							source === "base"
								? (file.baseContent ?? "")
								: source === "ours"
									? file.oursContent
									: file.theirsContent
						}
						readOnly
						wordWrap={false}
						onChange={keepSelection}
					/>
				)}
			</div>
			<div className="flex gap-2 items-center p-2 border-b border-border text-xs">
				<span className="flex-1">Worktree result — save, then stage to mark resolved</span>
				<Button size="sm" disabled={!canCopySource} onClick={() => replaceResult(file.oursContent)}>
					Use Ours in Result
				</Button>
				<Button size="sm" disabled={!canCopySource} onClick={() => replaceResult(file.theirsContent)}>
					Use Theirs in Result
				</Button>
				<Button
					size="sm"
					variant="primary"
					disabled={
						isMutating ||
						!workspace.canEditActiveTab ||
						!workspace.activeTab?.contentHash ||
						workspace.isActiveTabDirty ||
						workspace.activeTab.isSaving
					}
					onClick={() => void resolveFile(file.path, "manual", workspace.activeTab?.contentHash ?? undefined)}
				>
					Stage & Mark Resolved
				</Button>
			</div>
			{file.binary ||
			file.sourcesUnavailable ||
			content.isContentError ||
			(workspace.activeTab && !workspace.activeTab.editable) ? (
				<div className="flex items-center gap-2 p-2 text-xs">
					<span className="flex-1">
						Replace the worktree file with a complete Git side and stage it, or resolve externally.
					</span>
					{(["ours", "theirs"] as const).map((side) => (
						<Button
							key={side}
							size="sm"
							disabled={isMutating || content.isContentLoading}
							onClick={() => void resolveFile(file.path, side, workspace.activeTab?.contentHash ?? undefined)}
						>
							{side === "ours" ? "Use Ours & Stage" : "Use Theirs & Stage"}
						</Button>
					))}
				</div>
			) : null}
			<div className="flex flex-col flex-1 min-h-0" data-conflict-result>
				<FileEditorPanel
					embedded
					tabs={workspace.activeTab ? [workspace.activeTab] : []}
					activeTab={workspace.activeTab}
					activePath={file.path}
					isLoading={content.isContentLoading}
					isError={content.isContentError}
					isReadOnly={isMutating}
					canEditActiveTab={workspace.canEditActiveTab}
					isActiveTabDirty={workspace.isActiveTabDirty}
					hasDirtyTabs={workspace.hasDirtyTabs}
					discardPrompt={workspace.discardPrompt}
					autosaveMode="off"
					onSelectTab={keepSelection}
					onCloseTab={keepSelection}
					onChangeActiveContent={workspace.handleChangeActiveContent}
					onSaveActiveTab={workspace.handleSaveActiveTab}
					onSaveAllTabs={workspace.handleSaveAllTabs}
					onCloseAllTabs={keepSelection}
					onAutosaveFocusChange={keepSelection}
					onReloadActiveTab={workspace.handleReloadActiveTab}
					onCancelDiscardPrompt={workspace.handleCancelDiscardPrompt}
					onConfirmDiscardPrompt={workspace.handleConfirmDiscardPrompt}
				/>
			</div>
		</div>
	);
}
