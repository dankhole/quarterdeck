import { PanelLeft, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { CompareBar } from "@/components/git/git-view-compare-bar";
import { type DiffLineComment, DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/git/panels/file-tree-panel";
import { Button } from "@/components/ui/button";
import type { CompareWindowContext } from "@/hooks/git/compare-window-state";
import { useCompareWindowCompare } from "@/hooks/git/use-compare-window-compare";
import { useCompareWindowState } from "@/hooks/git/use-compare-window-state";
import { type UseGitDiffDataResult, useGitDiffData } from "@/hooks/git/use-git-diff-data";
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

function repositoryIdentity(target: CompareWindowTarget, rootPath: string): string {
	return JSON.stringify([target.projectId, target.taskId, target.taskCreatedAt, rootPath]);
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
	const [fileTreeVisible, setFileTreeVisible] = useState(true);
	const [preview, setPreview] = useState<FileNavigation | null>(null);
	const reviewRef = useRef<HTMLDivElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const uncommitted = target.reviewMode === "uncommitted";
	const { config } = useRuntimeProjectConfig(target.projectId);
	const data = useGitDiffData({
		activeTab: uncommitted ? "uncommitted" : "compare",
		currentProjectId: target.projectId,
		taskId: target.taskId,
		baseRef: context.baseRef,
		selectedPath,
		visibleDiffPaths,
		compare,
	});
	const revisionKey = JSON.stringify([
		repositoryIdentity(target, context.rootPath),
		context.baseRef,
		uncommitted,
		uncommitted ? "HEAD" : compare.targetRef,
		uncommitted || compare.includeUncommitted ? "live-worktree" : "revision",
		uncommitted ? "HEAD" : compare.sourceRef,
		!uncommitted && compare.threeDotDiff,
	]);
	const [retainedFiles, setRetainedFiles] = useState<{
		key: string;
		files: UseGitDiffDataResult["enrichedFiles"];
	} | null>(null);
	if (
		data.enrichedFiles !== null &&
		data.isRuntimeAvailable &&
		!data.isChangesPending &&
		(retainedFiles?.key !== revisionKey || retainedFiles.files !== data.enrichedFiles)
	) {
		setRetainedFiles({ key: revisionKey, files: data.enrichedFiles });
	}
	const reviewFiles =
		data.isRuntimeAvailable && !data.isChangesPending
			? data.enrichedFiles
			: retainedFiles?.key === revisionKey
				? retainedFiles.files
				: null;
	const repository = {
		projectId: target.projectId,
		taskId: target.taskId,
		taskCreatedAt: target.taskCreatedAt,
		rootPath: context.rootPath,
		...(context.baseRef ? { baseRef: context.baseRef } : {}),
	};
	const openPreview = (navigation: FileNavigation): void => {
		// A result may only read the repository incarnation that owns this document.
		if (navigation.codeTaskId !== undefined && navigation.codeTaskId !== target.taskId) return;
		const activeElement = document.activeElement;
		returnFocusRef.current =
			activeElement instanceof HTMLElement && reviewRef.current?.contains(activeElement) ? activeElement : null;
		setPreview(navigation);
	};
	const restoreReviewFocus = (): void => {
		const target = returnFocusRef.current;
		// Symbol shortcuts belong to the descendant navigation region, not its scroll container.
		const navigationSurface = reviewRef.current?.querySelector<HTMLElement>(
			'[role="region"][aria-label="Diff code navigation"]',
		);
		const diffSurface = reviewRef.current?.querySelector<HTMLElement>("[data-diff-scroll-container]");
		(target?.isConnected ? target : (navigationSurface ?? diffSurface ?? reviewRef.current))?.focus({
			preventScroll: true,
		});
	};
	return (
		<>
			{uncommitted ? (
				<div className="shrink-0 border-b border-border px-3 py-2 text-xs text-text-secondary">
					Uncommitted · HEAD → live working copy, including untracked files
				</div>
			) : (
				<CompareBar
					{...compare}
					onSourceRefChange={compare.setSourceRef}
					onTargetRefChange={compare.setTargetRef}
					onResetToDefaults={compare.resetToDefaults}
					onIncludeUncommittedChange={compare.setIncludeUncommitted}
					onThreeDotDiffChange={compare.setThreeDotDiff}
				/>
			)}
			<div className="flex shrink-0 items-center border-b border-border px-2 py-1">
				<Button
					size="sm"
					variant="ghost"
					icon={<PanelLeft size={14} />}
					aria-label={fileTreeVisible ? "Hide file tree" : "Show file tree"}
					aria-expanded={fileTreeVisible}
					aria-controls="review-file-tree"
					onClick={() => setFileTreeVisible((visible) => !visible)}
				>
					Files
				</Button>
				<Button
					size="sm"
					variant="ghost"
					icon={<RefreshCw size={14} />}
					aria-label="Refresh review"
					aria-busy={data.isRefreshing}
					disabled={data.isRefreshing || data.isChangesPending}
					onClick={() => {
						void data.refresh();
					}}
				>
					Refresh
				</Button>
				<span className="ml-auto text-xs text-text-secondary">Comment drafts stay in the main window</span>
			</div>
			<div ref={reviewRef} tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
				<aside
					id="review-file-tree"
					hidden={!fileTreeVisible}
					className={fileTreeVisible ? "flex w-64 shrink-0 border-r border-border" : "hidden"}
				>
					<FileTreePanel
						projectFiles={data.isRuntimeAvailable ? data.activeFiles : reviewFiles}
						selectedPath={selectedPath}
						onSelectPath={setSelectedPath}
						panelFlex="1 1 0"
					/>
				</aside>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{data.changesError || !data.isRuntimeAvailable ? (
						<p role="alert" className="p-4 text-status-red">
							{data.changesError ? `Could not refresh review: ${data.changesError}. ` : null}
							{reviewFiles !== null
								? "Comparison refresh unavailable. Retaining the last loaded review; check the runtime, refs and workspace."
								: "The captured repository comparison is unavailable. Check the runtime, refs and workspace."}
						</p>
					) : data.isChangesPending ? (
						<p role="status" className="p-4 text-text-secondary">
							Loading comparison…
						</p>
					) : data.hasNoChanges ? (
						<p className="p-4 text-text-secondary">No changes in this comparison.</p>
					) : null}
					<div
						className={
							(data.changesError || !data.isRuntimeAvailable) && reviewFiles === null
								? "hidden"
								: "flex min-h-0 min-w-0 flex-1"
						}
					>
						<DiffViewerPanel
							presentation="focused"
							reviewScope={{
								repository,
								revisions: {
									kind: uncommitted ? "working-copy" : "compare",
									base: uncommitted ? "HEAD" : (compare.targetRef ?? ""),
									head: uncommitted || compare.includeUncommitted ? "WORKTREE" : (compare.sourceRef ?? ""),
									headSource: uncommitted || compare.includeUncommitted ? "live-worktree" : "revision",
									mode: !uncommitted && compare.threeDotDiff ? "three_dot" : "two_dot",
								},
							}}
							projectFiles={reviewFiles}
							selectedPath={selectedPath}
							onSelectedPathChange={setSelectedPath}
							onVisiblePathsChange={setVisibleDiffPaths}
							fileLoadingState={data.fileLoadingState}
							viewMode="split"
							comments={emptyComments}
							onCommentsChange={ignoreComments}
							readOnlyReview
							codeNavigationConfig={config}
							navigateToFile={openPreview}
						/>
					</div>
				</div>
			</div>
			{preview ? (
				<CompareFilePreview
					projectId={target.projectId}
					taskId={target.taskId}
					baseRef={context.baseRef}
					navigation={preview}
					onClose={() => setPreview(null)}
					onReturnFocus={restoreReviewFocus}
				/>
			) : null}
		</>
	);
}

function CompareWindow({ target: initialTarget }: { target: CompareWindowTarget }): React.ReactElement {
	// A prop update, main-window navigation, or a stream default must not retarget this document.
	const [target] = useState(initialTarget);
	const context = useCompareWindowState(target);
	const compare = useCompareWindowCompare(target, context);
	const [retainedContext, setRetainedContext] = useState<Extract<CompareWindowContext, { status: "ready" }> | null>(
		null,
	);
	if (
		context.status === "ready" &&
		(retainedContext?.project !== context.project ||
			retainedContext.task !== context.task ||
			retainedContext.rootPath !== context.rootPath ||
			retainedContext.baseRef !== context.baseRef ||
			retainedContext.branch !== context.branch)
	)
		setRetainedContext(context);
	else if (context.status === "error" && !context.recoverable && retainedContext !== null) setRetainedContext(null);
	const reviewContext = context.status === "ready" ? context : retainedContext;
	if (context.status === "error" && (!context.recoverable || !reviewContext))
		return <CompareWindowError message={context.message} />;
	if (!reviewContext)
		return (
			<main className="h-[100svh] bg-surface-0 p-6 text-text-secondary" role="status">
				Loading captured comparison…
			</main>
		);
	return (
		<main className="flex h-[100svh] min-w-0 flex-col bg-surface-0 text-text-primary" aria-label="Standalone Compare">
			<header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 text-sm">
				<h1 className="truncate font-semibold">
					{target.reviewMode === "uncommitted" ? "Uncommitted" : "Compare"} ·{" "}
					{reviewContext.project.displayName ?? reviewContext.project.name}
					{reviewContext.task ? ` · ${reviewContext.task.title ?? reviewContext.task.id}` : ""}
				</h1>
				<span className="ml-auto shrink-0 text-xs text-text-secondary">Read-only review</span>
			</header>
			{context.status !== "ready" ? (
				<p role="status" className="shrink-0 px-3 py-1 text-xs text-status-orange">
					{context.status === "error" ? context.message : "Reconnecting…"} Last loaded review retained.
				</p>
			) : null}
			<CompareReview
				key={repositoryIdentity(target, reviewContext.rootPath)}
				target={target}
				context={reviewContext}
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
