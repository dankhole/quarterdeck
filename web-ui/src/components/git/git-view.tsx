import { PanelLeft } from "lucide-react";

import { CompareBar } from "@/components/git/git-view-compare-bar";
import { GitViewEmptyPanel, GitViewLoadingPanel } from "@/components/git/git-view-empty";
import { ConflictResolutionPanel } from "@/components/git/panels/conflict-resolution-panel";
import { DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/git/panels/file-tree-panel";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { deriveEmptyTitle } from "@/hooks/git/git-view";
import { type UseGitViewOptions, useGitView } from "@/hooks/git/use-git-view";
import { ResizeHandle } from "@/resize/resize-handle";

// --- Tab button ---

function TabButton({
	active,
	disabled,
	onClick,
	children,
}: {
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"px-2.5 py-1 rounded-md text-xs font-medium border-0 cursor-pointer",
				disabled
					? "opacity-35 cursor-not-allowed text-text-tertiary"
					: active
						? "bg-surface-3 text-text-primary"
						: "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-2",
			)}
		>
			{children}
		</button>
	);
}

// --- Main component ---

export interface GitViewProps extends UseGitViewOptions {
	/** Navigate to a file in a different main view (e.g. file browser). */
	navigateToFile?: (nav: { targetView: "git" | "files"; filePath: string }) => void;
	/** Slot for the branch pill + git status controls rendered in the tab bar. */
	branchStatusSlot?: React.ReactNode;
	/** When provided, renders the git history panel instead of the normal diff content. */
	gitHistoryPanel?: React.ReactNode;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
	/** Paste formatted inline comments into the agent terminal without submitting. */
	onAddToTerminal?: (text: string) => void;
	/** Paste formatted inline comments into the agent terminal and submit. */
	onSendToTerminal?: (text: string) => void;
}

export function GitView({
	navigateToFile,
	branchStatusSlot,
	gitHistoryPanel,
	pinnedBranches,
	onTogglePinBranch,
	onAddToTerminal,
	onSendToTerminal,
	...hookOptions
}: GitViewProps): React.ReactElement {
	const {
		activeTab,
		setActiveTab,
		fileTreeVisible,
		setFileTreeVisible,
		fileTreePercent,
		contentPercent,
		contentRowRef,
		handleFileTreeSeparatorMouseDown,
		selectedPath,
		setSelectedPath,
		handleVisibleDiffPathsChange,
		diffComments,
		setDiffComments,
		conflictResolution,
		compare,
		hasCompareRefs,
		activeFiles,
		enrichedFiles,
		fileLoadingState,
		isRuntimeAvailable,
		isChangesPending,
		hasNoChanges,
		handleRollbackFile,
		selectedCard,
	} = useGitView(hookOptions);

	// --- Conflict resolution early return ---

	if (conflictResolution.isActive && conflictResolution.conflictState) {
		return (
			<ConflictResolutionPanel
				conflictState={conflictResolution.conflictState}
				conflictFiles={conflictResolution.conflictFiles}
				resolvedFiles={conflictResolution.resolvedFiles}
				autoMergedFiles={conflictResolution.autoMergedFiles}
				reviewedAutoMergedFiles={conflictResolution.reviewedAutoMergedFiles}
				acceptAutoMergedFile={conflictResolution.acceptAutoMergedFile}
				selectedPath={conflictResolution.selectedPath}
				setSelectedPath={conflictResolution.setSelectedPath}
				resolveFile={conflictResolution.resolveFile}
				continueResolution={conflictResolution.continueResolution}
				abortResolution={conflictResolution.abortResolution}
				isLoading={conflictResolution.isLoading}
			/>
		);
	}

	const emptyTitle = deriveEmptyTitle(
		activeTab,
		hasCompareRefs,
		compare.includeUncommitted,
		compare.sourceRef,
		compare.targetRef,
	);

	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0">
			{/* Tab bar */}
			<div className="flex items-center gap-1 px-3 h-9 border-b border-border bg-surface-1 shrink-0">
				<TabButton active={activeTab === "uncommitted"} onClick={() => setActiveTab("uncommitted")}>
					Uncommitted
				</TabButton>
				<TabButton
					active={activeTab === "last_turn"}
					disabled={!selectedCard}
					onClick={() => setActiveTab("last_turn")}
				>
					Last Turn
				</TabButton>
				<TabButton active={activeTab === "compare"} onClick={() => setActiveTab("compare")}>
					Compare
				</TabButton>

				<div className="flex-1" />

				{branchStatusSlot}

				<Tooltip content={fileTreeVisible ? "Hide file tree" : "Show file tree"}>
					<button
						type="button"
						onClick={() => setFileTreeVisible((v) => !v)}
						className={cn(
							"flex items-center justify-center w-6 h-6 rounded-md border-0 cursor-pointer",
							fileTreeVisible
								? "bg-surface-3 text-text-primary"
								: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
						)}
					>
						<PanelLeft size={14} />
					</button>
				</Tooltip>
			</div>

			{/* Compare bar — only shown when Compare tab is active and git history is not open */}
			{activeTab === "compare" && !gitHistoryPanel && (
				<CompareBar
					sourceRef={compare.sourceRef}
					targetRef={compare.targetRef}
					isBrowsing={compare.isBrowsing}
					hasOverride={compare.hasOverride}
					branches={compare.branches}
					worktreeBranches={compare.worktreeBranches}
					includeUncommitted={compare.includeUncommitted}
					threeDotDiff={compare.threeDotDiff}
					onSourceRefChange={compare.setSourceRef}
					onTargetRefChange={compare.setTargetRef}
					onResetToDefaults={compare.resetToDefaults}
					onIncludeUncommittedChange={compare.setIncludeUncommitted}
					onThreeDotDiffChange={compare.setThreeDotDiff}
					pinnedBranches={pinnedBranches}
					onTogglePinBranch={onTogglePinBranch}
				/>
			)}

			{/* Content area: git history panel OR file tree + diff */}
			{gitHistoryPanel ? (
				<div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">{gitHistoryPanel}</div>
			) : (
				<div ref={contentRowRef} className="flex flex-1 min-h-0">
					{activeTab === "compare" && !hasCompareRefs ? (
						<GitViewEmptyPanel title="Select a branch to compare against." />
					) : isChangesPending ? (
						<GitViewLoadingPanel />
					) : hasNoChanges ? (
						<GitViewEmptyPanel title={emptyTitle} />
					) : (
						<>
							{fileTreeVisible && (
								<>
									<div
										style={{
											display: "flex",
											flex: `0 0 ${fileTreePercent}`,
											minWidth: 0,
											minHeight: 0,
										}}
									>
										<FileTreePanel
											projectFiles={isRuntimeAvailable ? activeFiles : null}
											selectedPath={selectedPath}
											onSelectPath={setSelectedPath}
											panelFlex="1 1 0"
											navigateToFile={navigateToFile}
										/>
									</div>
									<ResizeHandle
										orientation="vertical"
										ariaLabel="Resize git view file tree"
										onMouseDown={handleFileTreeSeparatorMouseDown}
										className="z-10"
									/>
								</>
							)}
							<div
								style={{
									display: "flex",
									flex: fileTreeVisible ? `0 0 ${contentPercent}` : "1 1 0",
									minWidth: 0,
									minHeight: 0,
								}}
							>
								<DiffViewerPanel
									projectFiles={isRuntimeAvailable ? enrichedFiles : null}
									selectedPath={selectedPath}
									onSelectedPathChange={setSelectedPath}
									onVisiblePathsChange={handleVisibleDiffPathsChange}
									onRollbackFile={activeTab === "uncommitted" ? handleRollbackFile : undefined}
									viewMode="split"
									comments={diffComments}
									onCommentsChange={setDiffComments}
									onAddToTerminal={onAddToTerminal}
									onSendToTerminal={onSendToTerminal}
									navigateToFile={navigateToFile}
									fileLoadingState={fileLoadingState}
								/>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
