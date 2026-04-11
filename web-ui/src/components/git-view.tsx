import { ArrowRight, CornerDownLeft, GitCompareArrows, PanelLeft } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BranchPillTrigger, BranchSelectorPopover } from "@/components/detail-panels/branch-selector-popover";
import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { type GitViewCompareNavigation, useGitViewCompare } from "@/hooks/use-git-view-compare";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type {
	RuntimeGitRef,
	RuntimeGitSyncSummary,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceFileChange,
} from "@/runtime/types";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";
import type { BoardData, CardSelection } from "@/types";

// --- Constants ---

const POLL_INTERVAL_MS = 1_000;

const GIT_VIEW_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.GitViewFileTreeRatio,
	defaultValue: 0.22,
	normalize: (value) => clampBetween(value, 0.12, 0.5),
};

// --- Types ---

type GitViewTab = "uncommitted" | "last_turn" | "compare";

// --- Tab persistence ---

function loadGitViewTab(): GitViewTab {
	const stored = readLocalStorageItem(LocalStorageKey.GitViewActiveTab);
	if (stored === "uncommitted" || stored === "last_turn" || stored === "compare") return stored;
	return "uncommitted";
}

function persistGitViewTab(tab: GitViewTab): void {
	writeLocalStorageItem(LocalStorageKey.GitViewActiveTab, tab);
}

// --- Empty/Loading panels ---

function GitViewLoadingPanel(): React.ReactElement {
	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-0">
			<div className="flex flex-1 flex-col" style={{ borderRight: "1px solid var(--color-divider)" }}>
				<div className="p-2.5 pb-1.5">
					<div className="flex items-center gap-2 mb-2.5">
						<div className="kb-skeleton h-3.5 rounded-sm" style={{ width: "62%" }} />
						<div className="kb-skeleton h-4 rounded-full" style={{ width: 42 }} />
					</div>
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "92%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "84%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "95%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "79%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "88%" }} />
					<div className="kb-skeleton h-3 rounded-sm" style={{ width: "76%" }} />
				</div>
				<div className="flex-1" />
			</div>
		</div>
	);
}

function GitViewEmptyPanel({ title }: { title: string }): React.ReactElement {
	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-0">
			<div className="flex flex-1 items-center justify-center">
				<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
					<GitCompareArrows size={40} />
					<h3 className="font-semibold text-text-secondary">{title}</h3>
				</div>
			</div>
		</div>
	);
}

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

// --- Compare bar ---

function CompareBar({
	sourceRef,
	targetRef,
	isBrowsing,
	hasOverride,
	branches,
	worktreeBranches,
	onSourceRefChange,
	onTargetRefChange,
	onResetToDefaults,
}: {
	sourceRef: string | null;
	targetRef: string | null;
	isBrowsing: boolean;
	hasOverride: boolean;
	branches: RuntimeGitRef[] | null;
	worktreeBranches: Map<string, string>;
	onSourceRefChange: (ref: string) => void;
	onTargetRefChange: (ref: string) => void;
	onResetToDefaults: () => void;
}): React.ReactElement {
	const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);
	const [targetPopoverOpen, setTargetPopoverOpen] = useState(false);

	return (
		<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
			{isBrowsing && <span className="text-[11px] font-medium text-status-purple">Browsing</span>}

			<BranchSelectorPopover
				isOpen={sourcePopoverOpen}
				onOpenChange={setSourcePopoverOpen}
				branches={branches}
				currentBranch={sourceRef}
				worktreeBranches={worktreeBranches}
				onSelectBranchView={(ref) => {
					onSourceRefChange(ref);
					setSourcePopoverOpen(false);
				}}
				onCheckoutBranch={() => {}}
				trigger={<BranchPillTrigger label={sourceRef ?? "select branch"} />}
			/>

			<ArrowRight size={12} className="text-text-tertiary shrink-0" />

			<BranchSelectorPopover
				isOpen={targetPopoverOpen}
				onOpenChange={setTargetPopoverOpen}
				branches={branches}
				currentBranch={targetRef}
				worktreeBranches={worktreeBranches}
				onSelectBranchView={(ref) => {
					onTargetRefChange(ref);
					setTargetPopoverOpen(false);
				}}
				onCheckoutBranch={() => {}}
				trigger={<BranchPillTrigger label={targetRef ?? "select branch"} />}
			/>

			{hasOverride && (
				<Tooltip content="Return to context">
					<button
						type="button"
						onClick={onResetToDefaults}
						className="flex items-center justify-center w-6 h-6 rounded-md border-0 cursor-pointer bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2"
					>
						<CornerDownLeft size={13} />
					</button>
				</Tooltip>
			)}
		</div>
	);
}

// --- Main component ---

export interface GitViewProps {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	homeGitSummary?: RuntimeGitSyncSummary | null;
	board?: BoardData;
	pendingCompareNavigation?: GitViewCompareNavigation | null;
	onCompareNavigationConsumed?: () => void;
	/** Slot for the branch pill + git status controls rendered in the tab bar. */
	branchStatusSlot?: React.ReactNode;
	/** When provided, renders the git history panel instead of the normal diff content. */
	gitHistoryPanel?: React.ReactNode;
}

export function GitView({
	currentProjectId,
	selectedCard,
	sessionSummary,
	homeGitSummary = null,
	board = { columns: [], dependencies: [] },
	pendingCompareNavigation,
	onCompareNavigationConsumed,
	branchStatusSlot,
	gitHistoryPanel,
}: GitViewProps): React.ReactElement {
	const [activeTab, setActiveTabState] = useState<GitViewTab>(loadGitViewTab);
	const [fileTreeVisible, setFileTreeVisible] = useState(true);
	const [fileTreeRatio, setFileTreeRatioState] = useState(() =>
		loadResizePreference(GIT_VIEW_FILE_TREE_RATIO_PREFERENCE),
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());

	const contentRowRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startFileTreeResize } = useResizeDrag();
	const isDocumentVisible = useDocumentVisibility();

	// --- Resize ---

	const setFileTreeRatio = useCallback((ratio: number) => {
		setFileTreeRatioState(persistResizePreference(GIT_VIEW_FILE_TREE_RATIO_PREFERENCE, ratio));
	}, []);

	const handleFileTreeSeparatorMouseDown = useMemo(() => {
		return (event: ReactMouseEvent<HTMLDivElement>) => {
			const container = contentRowRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const currentRatio = fileTreeRatio;
			startFileTreeResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
				onEnd: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
			});
		};
	}, [fileTreeRatio, setFileTreeRatio, startFileTreeResize]);

	const fileTreePercent = `${(fileTreeRatio * 100).toFixed(1)}%`;
	const contentPercent = `${((1 - fileTreeRatio) * 100).toFixed(1)}%`;

	// --- Tab management ---

	const setActiveTab = useCallback((tab: GitViewTab) => {
		setActiveTabState(tab);
		persistGitViewTab(tab);
	}, []);

	// --- Data fetching ---

	const taskId = selectedCard?.card.id ?? null;
	const baseRef = selectedCard?.card.baseRef ?? null;
	const taskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(taskId);

	// Uncommitted tab data
	const isUncommittedActive = activeTab === "uncommitted";
	const { changes: uncommittedChanges, isRuntimeAvailable: uncommittedAvailable } = useRuntimeWorkspaceChanges(
		isUncommittedActive ? (taskId ?? null) : null,
		isUncommittedActive ? currentProjectId : null,
		isUncommittedActive ? baseRef : null,
		"working_copy",
		taskWorkspaceStateVersion,
		isUncommittedActive && isDocumentVisible ? POLL_INTERVAL_MS : null,
	);

	// Last Turn tab data
	const isLastTurnActive = activeTab === "last_turn";
	const lastTurnViewKey = useMemo(() => {
		if (!isLastTurnActive || !sessionSummary) return null;
		return [
			sessionSummary.state ?? "none",
			sessionSummary.latestTurnCheckpoint?.commit ?? "none",
			sessionSummary.previousTurnCheckpoint?.commit ?? "none",
		].join(":");
	}, [isLastTurnActive, sessionSummary]);

	const { changes: lastTurnChanges, isRuntimeAvailable: lastTurnAvailable } = useRuntimeWorkspaceChanges(
		isLastTurnActive ? taskId : null,
		isLastTurnActive ? currentProjectId : null,
		isLastTurnActive ? baseRef : null,
		"last_turn",
		taskWorkspaceStateVersion,
		isLastTurnActive && isDocumentVisible ? POLL_INTERVAL_MS : null,
		lastTurnViewKey,
		true,
	);

	// Switch to compare tab when external navigation arrives
	useEffect(() => {
		if (pendingCompareNavigation) {
			setActiveTab("compare");
		}
	}, [pendingCompareNavigation, setActiveTab]);

	// Compare tab state
	const isCompareActive = activeTab === "compare";
	const compare = useGitViewCompare({
		selectedCard,
		currentProjectId,
		homeGitSummary,
		board,
		isActive: isCompareActive,
		pendingNavigation: pendingCompareNavigation,
		onNavigationConsumed: onCompareNavigationConsumed,
	});

	const hasCompareRefs = !!compare.sourceRef && !!compare.targetRef;
	const { changes: compareChanges, isRuntimeAvailable: compareAvailable } = useRuntimeWorkspaceChanges(
		isCompareActive && hasCompareRefs ? (taskId ?? null) : null,
		isCompareActive && hasCompareRefs ? currentProjectId : null,
		isCompareActive ? baseRef : null,
		"working_copy",
		0,
		null, // No polling for compare — branch diffs are stable
		isCompareActive ? `compare:${compare.sourceRef}:${compare.targetRef}` : null,
		true,
		compare.targetRef, // fromRef: what we're comparing against
		compare.sourceRef, // toRef: what we're looking at
	);

	// Derive active file list for file tree
	const activeFiles: RuntimeWorkspaceFileChange[] | null = useMemo(() => {
		if (activeTab === "uncommitted") return uncommittedChanges?.files ?? null;
		if (activeTab === "last_turn") return lastTurnChanges?.files ?? null;
		if (activeTab === "compare") return compareChanges?.files ?? null;
		return null;
	}, [activeTab, uncommittedChanges, lastTurnChanges, compareChanges]);

	const isRuntimeAvailable =
		activeTab === "uncommitted"
			? uncommittedAvailable
			: activeTab === "last_turn"
				? lastTurnAvailable
				: compareAvailable;
	const isChangesPending = isRuntimeAvailable && activeFiles === null && !(activeTab === "compare" && !hasCompareRefs);
	const hasNoChanges = isRuntimeAvailable && activeFiles !== null && activeFiles.length === 0;

	// Auto-select first file when file list changes
	const availablePaths = useMemo(() => {
		if (!activeFiles || activeFiles.length === 0) return [];
		return activeFiles.map((file) => file.path);
	}, [activeFiles]);

	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) return;
		setSelectedPath(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath]);

	// --- Reset on context switches ---

	useEffect(() => {
		setSelectedPath(null);
		setDiffComments(new Map());
	}, [taskId]);

	useEffect(() => {
		setSelectedPath(null);
		setActiveTab("uncommitted");
		setDiffComments(new Map());
	}, [currentProjectId, setActiveTab]);

	// --- Render ---

	const emptyTitle =
		activeTab === "last_turn"
			? "No changes since last turn"
			: activeTab === "uncommitted"
				? "No uncommitted changes"
				: activeTab === "compare" && hasCompareRefs
					? `No differences between ${compare.sourceRef} and ${compare.targetRef}.`
					: "No changes";

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
					onSourceRefChange={compare.setSourceRef}
					onTargetRefChange={compare.setTargetRef}
					onResetToDefaults={compare.resetToDefaults}
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
											workspaceFiles={isRuntimeAvailable ? activeFiles : null}
											selectedPath={selectedPath}
											onSelectPath={setSelectedPath}
											panelFlex="1 1 0"
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
									workspaceFiles={isRuntimeAvailable ? activeFiles : null}
									selectedPath={selectedPath}
									onSelectedPathChange={setSelectedPath}
									viewMode="split"
									comments={diffComments}
									onCommentsChange={setDiffComments}
								/>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
