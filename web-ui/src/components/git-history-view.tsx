import { GitBranch } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { GitCommitDiffPanel } from "@/components/git-history/git-commit-diff-panel";
import { GitCommitListPanel } from "@/components/git-history/git-commit-list-panel";
import { GitRefsPanel } from "@/components/git-history/git-refs-panel";
import type { UseGitHistoryDataResult } from "@/components/git-history/use-git-history-data";
import { ResizeHandle } from "@/resize/resize-handle";
import {
	clampGitCommitsPanelWidth,
	clampGitRefsPanelWidth,
	useGitHistoryLayout,
} from "@/resize/use-git-history-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeGitCommit } from "@/runtime/types";
import { useWindowEvent } from "@/utils/react-use";

function CommitDiffHeader({ commit }: { commit: RuntimeGitCommit }): React.ReactElement {
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
	);
}

interface GitHistoryViewProps {
	workspaceId: string | null;
	gitHistory: UseGitHistoryDataResult;
	onCheckoutBranch?: (branch: string) => void;
	onCreateBranch?: (sourceRef: string) => void;
}

export function GitHistoryView({
	workspaceId,
	gitHistory,
	onCheckoutBranch,
	onCreateBranch,
}: GitHistoryViewProps): React.ReactElement {
	const [historyLayoutWidth, setHistoryLayoutWidth] = useState<number | null>(null);
	const historyLayoutRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startRefsPanelResize } = useResizeDrag();
	const { startDrag: startCommitsPanelResize } = useResizeDrag();
	const { displayRefsPanelWidth, displayCommitsPanelWidth, setRefsPanelWidth, setCommitsPanelWidth } =
		useGitHistoryLayout({
			containerWidth: historyLayoutWidth,
		});

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
				diffSource={gitHistory.diffSource}
				isLoading={gitHistory.isDiffLoading}
				errorMessage={gitHistory.diffErrorMessage}
				selectedPath={gitHistory.selectedDiffPath}
				onSelectPath={gitHistory.selectDiffPath}
				headerContent={
					gitHistory.viewMode === "commit" && gitHistory.selectedCommit ? (
						<CommitDiffHeader commit={gitHistory.selectedCommit} />
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
	);
}
