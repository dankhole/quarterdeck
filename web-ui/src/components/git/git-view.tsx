import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { ArrowRight, Check, CornerDownLeft, GitCompareArrows, PanelLeft } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { ConflictResolutionPanel } from "@/components/git/panels/conflict-resolution-panel";
import { type DiffLineComment, DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/git/panels/file-tree-panel";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useConflictResolution } from "@/hooks/git/use-conflict-resolution";
import { type GitViewCompareNavigation, useGitViewCompare } from "@/hooks/git/use-git-view-compare";
import { useDocumentVisibility } from "@/hooks/notifications/use-document-visibility";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeGitRef,
	RuntimeGitSyncSummary,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceFileChange,
} from "@/runtime/types";
import { useAllFileDiffContent } from "@/runtime/use-all-file-diff-content";
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

// --- Last-selected-path persistence ---

/** Module-level cache of last viewed file per scope+tab key. */
const lastSelectedPathByScope = new Map<string, string>();

/** Hydrate in-memory cache from localStorage once at module load. */
(function hydrateLastSelectedPathCache(): void {
	const raw = readLocalStorageItem(LocalStorageKey.GitViewLastSelectedPath);
	if (!raw) return;
	try {
		const parsed: Record<string, string> = JSON.parse(raw);
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				lastSelectedPathByScope.set(key, value);
			}
		}
	} catch {
		// Ignore corrupt data.
	}
})();

function persistLastSelectedPathToStorage(): void {
	writeLocalStorageItem(
		LocalStorageKey.GitViewLastSelectedPath,
		JSON.stringify(Object.fromEntries(lastSelectedPathByScope)),
	);
}

function lastSelectedPathScopeKey(taskId: string | null, tab: GitViewTab): string {
	return `${taskId ?? "__home__"}::${tab}`;
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
	includeUncommitted,
	threeDotDiff,
	onSourceRefChange,
	onTargetRefChange,
	onResetToDefaults,
	onIncludeUncommittedChange,
	onThreeDotDiffChange,
	pinnedBranches,
	onTogglePinBranch,
}: {
	sourceRef: string | null;
	targetRef: string | null;
	isBrowsing: boolean;
	hasOverride: boolean;
	branches: RuntimeGitRef[] | null;
	worktreeBranches: Map<string, string>;
	includeUncommitted: boolean;
	threeDotDiff: boolean;
	onSourceRefChange: (ref: string) => void;
	onTargetRefChange: (ref: string) => void;
	onResetToDefaults: () => void;
	onIncludeUncommittedChange: (value: boolean) => void;
	onThreeDotDiffChange: (value: boolean) => void;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
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
				pinnedBranches={pinnedBranches}
				onTogglePinBranch={onTogglePinBranch}
				disableContextMenu
				onSelectBranchView={(ref) => {
					onSourceRefChange(ref);
					setSourcePopoverOpen(false);
				}}
				trigger={<BranchPillTrigger label={sourceRef ?? "select branch"} />}
			/>

			<ArrowRight size={12} className="text-text-tertiary shrink-0" />

			<BranchSelectorPopover
				isOpen={targetPopoverOpen}
				onOpenChange={setTargetPopoverOpen}
				branches={branches}
				currentBranch={targetRef}
				worktreeBranches={worktreeBranches}
				pinnedBranches={pinnedBranches}
				onTogglePinBranch={onTogglePinBranch}
				disableContextMenu
				onSelectBranchView={(ref) => {
					onTargetRefChange(ref);
					setTargetPopoverOpen(false);
				}}
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

			<label
				htmlFor="compare-three-dot-diff"
				className="flex items-center gap-1.5 ml-auto text-[12px] text-text-secondary cursor-pointer select-none"
			>
				<RadixCheckbox.Root
					id="compare-three-dot-diff"
					checked={threeDotDiff}
					onCheckedChange={(checked) => onThreeDotDiffChange(checked === true)}
					className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
				>
					<RadixCheckbox.Indicator>
						<Check size={10} className="text-white" />
					</RadixCheckbox.Indicator>
				</RadixCheckbox.Root>
				Only branch changes
			</label>

			<label
				htmlFor="compare-include-uncommitted"
				className="flex items-center gap-1.5 text-[12px] text-text-secondary cursor-pointer select-none"
			>
				<RadixCheckbox.Root
					id="compare-include-uncommitted"
					checked={includeUncommitted}
					onCheckedChange={(checked) => onIncludeUncommittedChange(checked === true)}
					className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
				>
					<RadixCheckbox.Indicator>
						<Check size={10} className="text-white" />
					</RadixCheckbox.Indicator>
				</RadixCheckbox.Root>
				Include uncommitted work
			</label>
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
	pendingFileNavigation?: { targetView: "git" | "files"; filePath: string } | null;
	onFileNavigationConsumed?: () => void;
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
	currentProjectId,
	selectedCard,
	sessionSummary,
	homeGitSummary = null,
	board = { columns: [], dependencies: [] },
	pendingCompareNavigation,
	onCompareNavigationConsumed,
	pendingFileNavigation,
	onFileNavigationConsumed,
	navigateToFile,
	branchStatusSlot,
	gitHistoryPanel,
	pinnedBranches,
	onTogglePinBranch,
	onAddToTerminal,
	onSendToTerminal,
}: GitViewProps): React.ReactElement {
	const [activeTab, setActiveTabState] = useState<GitViewTab>(loadGitViewTab);
	const [fileTreeVisible, setFileTreeVisible] = useState(true);
	const [fileTreeRatio, setFileTreeRatioState] = useState(() =>
		loadResizePreference(GIT_VIEW_FILE_TREE_RATIO_PREFERENCE),
	);
	const [selectedPath, setSelectedPathRaw] = useState<string | null>(null);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());

	const contentRowRef = useRef<HTMLDivElement | null>(null);
	const pendingCompareNavigationRef = useRef(pendingCompareNavigation);
	pendingCompareNavigationRef.current = pendingCompareNavigation;
	const { startDrag: startFileTreeResize } = useResizeDrag();
	const isDocumentVisible = useDocumentVisibility();

	const taskId = selectedCard?.card.id ?? null;

	// --- Selected path with persistence ---

	const setSelectedPath = useCallback(
		(path: string | null) => {
			setSelectedPathRaw(path);
			if (path) {
				const scopeKey = lastSelectedPathScopeKey(taskId, activeTab);
				lastSelectedPathByScope.set(scopeKey, path);
				persistLastSelectedPathToStorage();
			}
		},
		[taskId, activeTab],
	);

	// --- Conflict resolution ---

	const conflictResolution = useConflictResolution({
		taskId,
		workspaceId: currentProjectId,
	});

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

	// Navigate to a specific file when external file navigation arrives (from commit panel)
	useEffect(() => {
		if (pendingFileNavigation?.targetView === "git") {
			setActiveTab("uncommitted");
			// Use raw setter — the tab is being switched simultaneously, so the persisting wrapper
			// would record under the old tab's scope key. The auto-select effect will persist it
			// correctly on the next render once activeTab has settled to "uncommitted".
			setSelectedPathRaw(pendingFileNavigation.filePath);
			onFileNavigationConsumed?.();
		}
	}, [pendingFileNavigation, onFileNavigationConsumed, setActiveTab]);

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
	const compareIncludeUncommitted = compare.includeUncommitted;
	const compareThreeDot = compare.threeDotDiff;
	const compareDiffMode = compareThreeDot ? ("three_dot" as const) : ("two_dot" as const);
	const comparePollInterval =
		isCompareActive && compareIncludeUncommitted && isDocumentVisible ? POLL_INTERVAL_MS : null;
	const { changes: compareChanges, isRuntimeAvailable: compareAvailable } = useRuntimeWorkspaceChanges(
		isCompareActive && hasCompareRefs ? (taskId ?? null) : null,
		isCompareActive && hasCompareRefs ? currentProjectId : null,
		isCompareActive ? baseRef : null,
		"working_copy",
		taskWorkspaceStateVersion,
		comparePollInterval,
		isCompareActive
			? `compare:${compare.sourceRef}:${compare.targetRef}:${compareIncludeUncommitted ? "wt" : "refs"}:${compareDiffMode}`
			: null,
		true,
		compare.targetRef, // fromRef: what we're comparing against
		compareIncludeUncommitted ? undefined : compare.sourceRef, // toRef: omit to include working tree
		compareDiffMode,
	);

	// Derive active file list for file tree
	const activeFiles: RuntimeWorkspaceFileChange[] | null = useMemo(() => {
		if (activeTab === "uncommitted") return uncommittedChanges?.files ?? null;
		if (activeTab === "last_turn") return lastTurnChanges?.files ?? null;
		if (activeTab === "compare") return compareChanges?.files ?? null;
		return null;
	}, [activeTab, uncommittedChanges, lastTurnChanges, compareChanges]);

	// Batch diff content loading — fetches diffs for ALL files progressively.
	const { enrichedFiles, fileLoadingState } = useAllFileDiffContent({
		workspaceId: currentProjectId,
		taskId,
		baseRef,
		mode: activeTab === "last_turn" ? "last_turn" : "working_copy",
		fromRef: activeTab === "compare" ? compare.targetRef : undefined,
		toRef: activeTab === "compare" && !compareIncludeUncommitted ? compare.sourceRef : undefined,
		diffMode: activeTab === "compare" ? compareDiffMode : undefined,
		files: activeFiles,
	});

	const isRuntimeAvailable =
		activeTab === "uncommitted"
			? uncommittedAvailable
			: activeTab === "last_turn"
				? lastTurnAvailable
				: compareAvailable;
	const isChangesPending = isRuntimeAvailable && activeFiles === null && !(activeTab === "compare" && !hasCompareRefs);
	const hasNoChanges = isRuntimeAvailable && activeFiles !== null && activeFiles.length === 0;

	// Auto-select file when file list changes: restore last-viewed from cache, or fall back to first file.
	const availablePaths = useMemo(() => {
		if (!activeFiles || activeFiles.length === 0) return [];
		return activeFiles.map((file) => file.path);
	}, [activeFiles]);

	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) return;
		// Try to restore the last-viewed file for this scope+tab.
		const scopeKey = lastSelectedPathScopeKey(taskId, activeTab);
		const remembered = lastSelectedPathByScope.get(scopeKey);
		if (remembered && availablePaths.includes(remembered)) {
			setSelectedPathRaw(remembered);
			return;
		}
		setSelectedPathRaw(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath, taskId, activeTab]);

	// --- File rollback (uncommitted tab only) ---

	const taskScope = useMemo(() => (taskId && baseRef ? { taskId, baseRef } : null), [taskId, baseRef]);
	const isRollingBackRef = useRef(false);

	const handleRollbackFile = useCallback(
		async (path: string) => {
			if (!currentProjectId || isRollingBackRef.current) return;
			const file = uncommittedChanges?.files?.find((f) => f.path === path);
			if (!file) return;
			isRollingBackRef.current = true;
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.workspace.discardFile.mutate({
					taskScope,
					path,
					fileStatus: file.status,
				});
				if (result.ok) {
					showAppToast({
						intent: "success",
						message: `Discarded changes to ${path.split("/").pop()}`,
						timeout: 4000,
					});
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Rollback failed.", timeout: 7000 });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Rollback failed.",
					timeout: 7000,
				});
			} finally {
				isRollingBackRef.current = false;
			}
		},
		[currentProjectId, taskScope, uncommittedChanges?.files],
	);

	// --- Reset on context switches ---

	useEffect(() => {
		const scopeKey = lastSelectedPathScopeKey(taskId, activeTab);
		setSelectedPathRaw(lastSelectedPathByScope.get(scopeKey) ?? null);
		setDiffComments(new Map());
	}, [taskId, activeTab]);

	useEffect(() => {
		setSelectedPathRaw(null);
		// Don't reset to uncommitted if we're navigating to compare via external request.
		// Read from ref to avoid re-firing when navigation is consumed (which would
		// overwrite the compare tab that Effect A just set).
		if (!pendingCompareNavigationRef.current) {
			setActiveTab("uncommitted");
		}
		setDiffComments(new Map());
	}, [currentProjectId, setActiveTab]);

	// --- Render ---

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

	const emptyTitle =
		activeTab === "last_turn"
			? "No changes since last turn"
			: activeTab === "uncommitted"
				? "No uncommitted changes"
				: activeTab === "compare" && hasCompareRefs
					? compareIncludeUncommitted
						? `No differences between working tree and ${compare.targetRef}.`
						: `No differences between ${compare.sourceRef} and ${compare.targetRef}.`
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
											workspaceFiles={isRuntimeAvailable ? activeFiles : null}
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
									workspaceFiles={isRuntimeAvailable ? enrichedFiles : null}
									selectedPath={selectedPath}
									onSelectedPathChange={setSelectedPath}
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
