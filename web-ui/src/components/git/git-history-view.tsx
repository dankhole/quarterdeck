import { GitBranch } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { BranchSelectDropdown, type BranchSelectOption } from "@/components/git/branch-select-dropdown";
import {
	CherryPickConfirmationDialog,
	type CherryPickDialogState,
} from "@/components/git/history/cherry-pick-confirmation-dialog";
import { GitCommitDiffPanel } from "@/components/git/history/git-commit-diff-panel";
import { GitCommitListPanel } from "@/components/git/history/git-commit-list-panel";
import { GitRefsPanel } from "@/components/git/history/git-refs-panel";
import type { UseGitHistoryDataResult } from "@/components/git/history/use-git-history-data";
import { ResizeHandle } from "@/resize/resize-handle";
import {
	clampGitCommitsPanelWidth,
	clampGitRefsPanelWidth,
	useGitHistoryLayout,
} from "@/resize/use-git-history-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitCommit, RuntimeWorkspaceFileChange } from "@/runtime/types";
import { useFileDiffContent } from "@/runtime/use-file-diff-content";
import { useWindowEvent } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";

function CommitDiffHeader({
	commit,
	branches,
	onLandOnBranch,
}: {
	commit: RuntimeGitCommit;
	branches: BranchSelectOption[];
	onLandOnBranch?: (commit: RuntimeGitCommit, targetBranch: string) => void;
}): React.ReactElement {
	const isMergeCommit = commit.parentHashes.length > 1;

	return (
		<div
			style={{
				padding: "10px 12px",
				borderBottom: "1px solid var(--color-divider)",
				background: "var(--color-surface-1)",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "flex-start",
					justifyContent: "space-between",
					gap: 8,
				}}
			>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							fontSize: 14,
							color: "var(--color-text-primary)",
							marginBottom: 4,
							lineHeight: 1.4,
						}}
					>
						{commit.message}
					</div>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							fontSize: 10,
							color: "var(--color-text-tertiary)",
						}}
					>
						<span>{commit.authorName}</span>
						<span>
							{new Date(commit.date).toLocaleDateString(undefined, {
								year: "numeric",
								month: "short",
								day: "numeric",
							})}
						</span>
						<code className="font-mono">{commit.shortHash}</code>
					</div>
				</div>
				{onLandOnBranch && branches.length > 0 && !isMergeCommit ? (
					<BranchSelectDropdown
						options={branches}
						onSelect={(branch) => onLandOnBranch(commit, branch)}
						size="sm"
						buttonText="Land on..."
						buttonClassName="shrink-0"
						iconSize={12}
						emptyText="No branches"
						noResultsText="No matching branches"
						matchTargetWidth={false}
						dropdownStyle={{ minWidth: 220 }}
					/>
				) : null}
			</div>
		</div>
	);
}

interface GitHistoryViewProps {
	workspaceId: string | null;
	gitHistory: UseGitHistoryDataResult;
	onCheckoutBranch?: (branch: string) => void;
	onCreateBranch?: (sourceRef: string) => void;
	onPullLatest?: () => void;
	onRebaseBranch?: (onto: string) => void;
	onRenameBranch?: (branchName: string) => void;
	onResetToRef?: (ref: string) => void;
	/** Task scope for cherry-pick operations (null = home repo context). */
	taskScope?: { taskId: string; baseRef: string } | null;
	/** When true, skip the cherry-pick confirmation dialog and execute immediately. */
	skipCherryPickConfirmation?: boolean;
}

export function GitHistoryView({
	workspaceId,
	gitHistory,
	onCheckoutBranch,
	onCreateBranch,
	onPullLatest,
	onRebaseBranch,
	onRenameBranch,
	onResetToRef,
	taskScope,
	skipCherryPickConfirmation = false,
}: GitHistoryViewProps): React.ReactElement {
	const [historyLayoutWidth, setHistoryLayoutWidth] = useState<number | null>(null);
	const historyLayoutRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startRefsPanelResize } = useResizeDrag();
	const { startDrag: startCommitsPanelResize } = useResizeDrag();
	const { displayRefsPanelWidth, displayCommitsPanelWidth, setRefsPanelWidth, setCommitsPanelWidth } =
		useGitHistoryLayout({
			containerWidth: historyLayoutWidth,
		});

	// Cherry-pick state
	const [cherryPickDialog, setCherryPickDialog] = useState<CherryPickDialogState>({ type: "closed" });
	const [isCherryPickLoading, setIsCherryPickLoading] = useState(false);

	// Build branch options from refs (local branches only, exclude the active ref)
	const activeRefName = gitHistory.activeRef?.name ?? null;
	const branchOptions = useMemo((): BranchSelectOption[] => {
		return gitHistory.refs
			.filter((ref) => ref.type === "branch" && ref.name !== activeRefName)
			.map((ref) => ({
				label: ref.name,
				value: ref.name,
			}));
	}, [gitHistory.refs, activeRefName]);

	const handleConfirmCherryPick = useCallback(
		async (commitHash: string, targetBranch: string) => {
			if (!workspaceId) {
				return;
			}
			setIsCherryPickLoading(true);
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				const result = await trpc.workspace.cherryPickCommit.mutate({
					commitHash,
					targetBranch,
					taskScope: taskScope ?? null,
				});
				if (result.ok) {
					setCherryPickDialog({ type: "closed" });
					showAppToast({
						intent: "success",
						message: `Landed ${commitHash.slice(0, 7)} on ${targetBranch}`,
					});
					// Refresh the git history to show the new commit
					gitHistory.refresh({ background: true });
				} else {
					showAppToast({
						intent: "danger",
						message: result.error ?? "Cherry-pick failed.",
					});
					setCherryPickDialog({ type: "closed" });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: `Cherry-pick failed: ${toErrorMessage(error)}`,
				});
				setCherryPickDialog({ type: "closed" });
			} finally {
				setIsCherryPickLoading(false);
			}
		},
		[workspaceId, taskScope, gitHistory.refresh],
	);

	const handleLandOnBranch = useCallback(
		(commit: RuntimeGitCommit, targetBranch: string) => {
			if (skipCherryPickConfirmation) {
				void handleConfirmCherryPick(commit.hash, targetBranch);
				return;
			}
			setCherryPickDialog({
				type: "confirm",
				commitHash: commit.hash,
				shortHash: commit.shortHash,
				commitMessage: commit.message,
				targetBranch,
			});
		},
		[skipCherryPickConfirmation, handleConfirmCherryPick],
	);

	const closeCherryPickDialog = useCallback(() => {
		setCherryPickDialog({ type: "closed" });
	}, []);

	const updateHistoryLayoutWidth = useCallback(() => {
		const container = historyLayoutRef.current;
		if (!container) {
			return;
		}
		setHistoryLayoutWidth(Math.max(container.offsetWidth, 1));
	}, []);

	useEffect(() => {
		updateHistoryLayoutWidth();
	}, [updateHistoryLayoutWidth]);

	useWindowEvent("resize", updateHistoryLayoutWidth);

	const handleRefsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayRefsPanelWidth;
			startRefsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setRefsPanelWidth, startRefsPanelResize],
	);

	const handleCommitsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayCommitsPanelWidth;
			startCommitsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setCommitsPanelWidth, startCommitsPanelResize],
	);

	// Lazy file content loading for working-copy view in git history
	const wcSelectedFile = useMemo((): RuntimeWorkspaceFileChange | null => {
		if (gitHistory.viewMode !== "working-copy" || !gitHistory.selectedDiffPath || !gitHistory.diffSource) {
			return null;
		}
		if (gitHistory.diffSource.type !== "working-copy") return null;
		return gitHistory.diffSource.files.find((f) => f.path === gitHistory.selectedDiffPath) ?? null;
	}, [gitHistory.viewMode, gitHistory.selectedDiffPath, gitHistory.diffSource]);

	// changesGeneratedAt omitted: the git history working-copy view is a one-shot load (no polling),
	// so cached diff content doesn't go stale between polls like in git-view.tsx.
	const wcFileDiff = useFileDiffContent({
		workspaceId,
		taskId: taskScope?.taskId ?? null,
		baseRef: taskScope?.baseRef ?? null,
		mode: "working_copy",
		selectedFile: wcSelectedFile,
	});

	const enrichedDiffSource = useMemo(() => {
		if (!gitHistory.diffSource || gitHistory.diffSource.type !== "working-copy" || !gitHistory.selectedDiffPath) {
			return gitHistory.diffSource;
		}
		if (wcFileDiff.oldText == null && wcFileDiff.newText == null) return gitHistory.diffSource;
		const enrichedFiles = gitHistory.diffSource.files.map((f) => {
			if (f.path !== gitHistory.selectedDiffPath) return f;
			return { ...f, oldText: wcFileDiff.oldText, newText: wcFileDiff.newText };
		});
		return { type: "working-copy" as const, files: enrichedFiles };
	}, [gitHistory.diffSource, gitHistory.selectedDiffPath, wcFileDiff.oldText, wcFileDiff.newText]);

	if (!workspaceId) {
		return (
			<div
				className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary"
				style={{ flex: 1, background: "var(--color-surface-0)" }}
			>
				<GitBranch size={48} />
				<h3 className="font-semibold text-text-primary">No project selected</h3>
			</div>
		);
	}

	return (
		<>
			<div
				ref={historyLayoutRef}
				style={{
					display: "flex",
					flex: "1 1 0",
					minHeight: 0,
					overflow: "hidden",
					background: "var(--color-surface-0)",
				}}
			>
				<GitRefsPanel
					refs={gitHistory.refs}
					selectedRefName={gitHistory.viewMode === "working-copy" ? null : (gitHistory.activeRef?.name ?? null)}
					isLoading={gitHistory.isRefsLoading}
					errorMessage={gitHistory.refsErrorMessage}
					panelWidth={displayRefsPanelWidth}
					workingCopyChanges={gitHistory.hasWorkingCopy ? gitHistory.workingCopyFileCount : null}
					isWorkingCopySelected={gitHistory.viewMode === "working-copy"}
					onSelectRef={gitHistory.selectRef}
					onSelectWorkingCopy={gitHistory.hasWorkingCopy ? gitHistory.selectWorkingCopy : undefined}
					onCheckoutRef={onCheckoutBranch}
					onCreateBranch={onCreateBranch}
					onPullLatest={onPullLatest}
					onRebaseBranch={onRebaseBranch}
					onRenameBranch={onRenameBranch}
					onResetToRef={onResetToRef}
				/>
				<ResizeHandle
					orientation="vertical"
					ariaLabel="Resize git refs and commits panels"
					onMouseDown={handleRefsSeparatorMouseDown}
					className="z-10"
				/>
				<GitCommitListPanel
					commits={gitHistory.commits}
					totalCount={gitHistory.totalCommitCount}
					selectedCommitHash={gitHistory.viewMode === "commit" ? gitHistory.selectedCommitHash : null}
					isLoading={gitHistory.isLogLoading}
					isLoadingMore={gitHistory.isLoadingMoreCommits}
					canLoadMore={gitHistory.commits.length < gitHistory.totalCommitCount}
					errorMessage={gitHistory.logErrorMessage}
					refs={gitHistory.refs}
					panelWidth={displayCommitsPanelWidth}
					onSelectCommit={gitHistory.selectCommit}
					onLoadMore={gitHistory.loadMoreCommits}
				/>
				<ResizeHandle
					orientation="vertical"
					ariaLabel="Resize git commits and diff panels"
					onMouseDown={handleCommitsSeparatorMouseDown}
					className="z-10"
				/>
				<GitCommitDiffPanel
					diffSource={enrichedDiffSource}
					isLoading={gitHistory.isDiffLoading}
					errorMessage={gitHistory.diffErrorMessage}
					selectedPath={gitHistory.selectedDiffPath}
					onSelectPath={gitHistory.selectDiffPath}
					headerContent={
						gitHistory.viewMode === "commit" && gitHistory.selectedCommit ? (
							<CommitDiffHeader
								commit={gitHistory.selectedCommit}
								branches={branchOptions}
								onLandOnBranch={handleLandOnBranch}
							/>
						) : gitHistory.viewMode === "working-copy" ? (
							<div
								className="kb-git-working-copy-header"
								style={{
									display: "flex",
									alignItems: "center",
									padding: "10px 12px",
									borderBottom: "1px solid var(--color-border)",
									fontSize: 14,
									color: "var(--color-text-primary)",
								}}
							>
								<span style={{ flex: 1 }}>Working Copy Changes</span>
							</div>
						) : null
					}
				/>
			</div>
			<CherryPickConfirmationDialog
				state={cherryPickDialog}
				isLoading={isCherryPickLoading}
				onClose={closeCherryPickDialog}
				onConfirm={handleConfirmCherryPick}
			/>
		</>
	);
}
