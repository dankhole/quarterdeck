import { useState } from "react";
import { CompareBar } from "@/components/git/git-view-compare-bar";
import { type DiffLineComment, DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/git/panels/file-tree-panel";
import type { CompareWindowContext } from "@/hooks/git/compare-window-state";
import { useCompareWindowCompare } from "@/hooks/git/use-compare-window-compare";
import { useCompareWindowState } from "@/hooks/git/use-compare-window-state";
import { useGitDiffData } from "@/hooks/git/use-git-diff-data";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";
import type { UseGitViewCompareResult } from "@/hooks/git/use-git-view-compare";
import { UiPreferencesBoundary } from "@/providers/ui-preferences-boundary";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import { CompareFilePreview } from "./compare-file-preview";

const emptyComments = new Map<string, DiffLineComment>();
const ignoreComments = (): void => {};

export function CompareWindowError({ message }: { message: string }): React.ReactElement {
	return (
		<main className="flex h-[100svh] items-center justify-center bg-surface-0 p-8 text-text-primary">
			<div role="alert" className="max-w-xl">
				<h1 className="mb-2 text-lg font-semibold">Compare unavailable</h1>
				<p className="text-sm text-text-secondary">{message}</p>
			</div>
		</main>
	);
}

function CompareReview({
	target,
	context,
	compare,
}: {
	target: CompareWindowTarget;
	context: Extract<CompareWindowContext, { status: "ready" }>;
	compare: UseGitViewCompareResult;
}): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(target.selectedPath ?? null);
	const [visibleDiffPaths, setVisibleDiffPaths] = useState<string[]>([]);
	const [preview, setPreview] = useState<FileNavigation | null>(null);
	const { config } = useRuntimeProjectConfig(target.projectId);
	const data = useGitDiffData({
		activeTab: "compare",
		currentProjectId: target.projectId,
		taskId: target.taskId,
		baseRef: context.baseRef,
		selectedPath,
		visibleDiffPaths,
		compare,
	});
	const repository = {
		projectId: target.projectId,
		taskId: target.taskId,
		taskCreatedAt: target.taskCreatedAt,
		rootPath: context.rootPath,
		...(context.baseRef ? { baseRef: context.baseRef } : {}),
	};
	return (
		<>
			<CompareBar
				{...compare}
				onSourceRefChange={compare.setSourceRef}
				onTargetRefChange={compare.setTargetRef}
				onResetToDefaults={compare.resetToDefaults}
				onIncludeUncommittedChange={compare.setIncludeUncommitted}
				onThreeDotDiffChange={compare.setThreeDotDiff}
			/>
			{preview ? (
				<CompareFilePreview
					projectId={target.projectId}
					taskId={target.taskId}
					baseRef={context.baseRef}
					navigation={preview}
					onClose={() => setPreview(null)}
				/>
			) : (
				<div className="flex min-h-0 flex-1">
					<aside className="flex w-64 shrink-0 border-r border-border">
						<FileTreePanel
							projectFiles={data.activeFiles}
							selectedPath={selectedPath}
							onSelectPath={setSelectedPath}
							panelFlex="1 1 0"
						/>
					</aside>
					<div className="flex min-h-0 min-w-0 flex-1">
						{!data.isRuntimeAvailable ? (
							<p role="alert" className="p-4 text-status-red">
								The captured repository comparison is unavailable. Check the refs and workspace.
							</p>
						) : data.isChangesPending ? (
							<p role="status" className="p-4 text-text-secondary">
								Loading comparison…
							</p>
						) : data.hasNoChanges ? (
							<p className="p-4 text-text-secondary">No changes in this comparison.</p>
						) : (
							<DiffViewerPanel
								reviewScope={{
									repository,
									revisions: {
										kind: "compare",
										base: compare.targetRef ?? "",
										head: compare.includeUncommitted ? "WORKTREE" : (compare.sourceRef ?? ""),
										headSource: compare.includeUncommitted ? "live-worktree" : "revision",
										mode: compare.threeDotDiff ? "three_dot" : "two_dot",
									},
								}}
								projectFiles={data.enrichedFiles}
								selectedPath={selectedPath}
								onSelectedPathChange={setSelectedPath}
								onVisiblePathsChange={setVisibleDiffPaths}
								fileLoadingState={data.fileLoadingState}
								viewMode="split"
								comments={emptyComments}
								onCommentsChange={ignoreComments}
								readOnlyReview
								codeNavigationConfig={config}
								navigateToFile={setPreview}
							/>
						)}
					</div>
				</div>
			)}
		</>
	);
}

function CompareWindow({ target: initialTarget }: { target: CompareWindowTarget }): React.ReactElement {
	// A prop update, main-window navigation, or a stream default must not retarget this document.
	const [target] = useState(initialTarget);
	const context = useCompareWindowState(target);
	const compare = useCompareWindowCompare(target, context);
	if (context.status === "error") return <CompareWindowError message={context.message} />;
	if (context.status === "loading")
		return (
			<main className="h-[100svh] bg-surface-0 p-6 text-text-secondary" role="status">
				Loading captured comparison…
			</main>
		);
	return (
		<main className="flex h-[100svh] min-w-0 flex-col bg-surface-0 text-text-primary" aria-label="Standalone Compare">
			<header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 text-sm">
				<h1 className="truncate font-semibold">
					Compare · {context.project.displayName ?? context.project.name}
					{context.task ? ` · ${context.task.title ?? context.task.id}` : ""}
				</h1>
				<span className="ml-auto shrink-0 text-xs text-text-secondary">Read-only review</span>
			</header>
			<CompareReview
				key={JSON.stringify([target.projectId, target.taskId, target.taskCreatedAt, context.rootPath])}
				target={target}
				context={context}
				compare={compare}
			/>
		</main>
	);
}

/** No App, single-tab ownership, terminal, notification, or editor-recovery providers. */
export function CompareWindowRoot({ target }: { target: CompareWindowTarget }): React.ReactElement {
	return (
		<UiPreferencesBoundary readOnly>
			<CompareWindow target={target} />
		</UiPreferencesBoundary>
	);
}
