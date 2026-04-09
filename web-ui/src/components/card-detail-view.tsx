import type { DropResult } from "@hello-pangea/dnd";
import { ArrowRight, FolderOpen, GitCompareArrows, Maximize2, Minimize2, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { FileBrowserPanel } from "@/components/detail-panels/file-browser-panel";
import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import type { SidebarTabId } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesMode } from "@/runtime/types";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import { useTaskWorkspaceInfoValue, useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import { type BoardCard, type CardSelection, getTaskAutoReviewCancelButtonLabel } from "@/types";

// We still poll the open detail diff because line content can change without changing
// the overall file or line counts that drive the shared workspace metadata stream.
const DETAIL_DIFF_POLL_INTERVAL_MS = 1_000;

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function WorkspaceChangesLoadingPanel({ panelFlex }: { panelFlex: string }): React.ReactElement {
	return (
		<div
			style={{ display: "flex", flex: "1.6 1 0", minWidth: 0, minHeight: 0, background: "var(--color-surface-0)" }}
		>
			<div
				style={{
					display: "flex",
					flex: "1 1 0",
					flexDirection: "column",
					borderRight: "1px solid var(--color-divider)",
				}}
			>
				<div style={{ padding: "10px 10px 6px" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
						<div className="kb-skeleton" style={{ height: 14, width: "62%", borderRadius: 3 }} />
						<div className="kb-skeleton" style={{ height: 16, width: 42, borderRadius: 999 }} />
					</div>
					<div className="kb-skeleton" style={{ height: 13, width: "92%", borderRadius: 3, marginBottom: 7 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "84%", borderRadius: 3, marginBottom: 7 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "95%", borderRadius: 3, marginBottom: 7 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "79%", borderRadius: 3, marginBottom: 7 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "88%", borderRadius: 3, marginBottom: 7 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "76%", borderRadius: 3 }} />
				</div>
				<div style={{ flex: "1 1 0" }} />
			</div>
			<div style={{ display: "flex", flex: panelFlex, flexDirection: "column", padding: "10px 8px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className="kb-skeleton" style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "61%", borderRadius: 3 }} />
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className="kb-skeleton" style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "70%", borderRadius: 3 }} />
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className="kb-skeleton" style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className="kb-skeleton" style={{ height: 13, width: "53%", borderRadius: 3 }} />
				</div>
				<div style={{ flex: "1 1 0" }} />
			</div>
		</div>
	);
}

function WorkspaceChangesEmptyPanel({ title }: { title: string }): React.ReactElement {
	return (
		<div
			style={{ display: "flex", flex: "1.6 1 0", minWidth: 0, minHeight: 0, background: "var(--color-surface-0)" }}
		>
			<div className="kb-empty-state-center" style={{ flex: 1 }}>
				<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
					<GitCompareArrows size={40} />
					<h3 className="font-semibold text-text-secondary">{title}</h3>
				</div>
			</div>
		</div>
	);
}

function DiffToolbar({
	mode,
	onModeChange,
	isExpanded,
	onToggleExpand,
	baseRef,
	branch,
}: {
	mode: RuntimeWorkspaceChangesMode;
	onModeChange: (mode: RuntimeWorkspaceChangesMode) => void;
	isExpanded: boolean;
	onToggleExpand: () => void;
	baseRef: string | null;
	branch: string | null;
}): React.ReactElement {
	return (
		<div className="flex items-center gap-1 px-2 py-1" style={{ borderBottom: "1px solid var(--color-divider)" }}>
			{isExpanded ? (
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={14} />}
					onClick={onToggleExpand}
					className="h-5"
					aria-label="Collapse expanded diff view"
				/>
			) : null}
			<div className="inline-flex items-center gap-0.5 rounded-md p-0.5">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onModeChange("working_copy")}
					className="h-5 rounded-sm text-xs"
					style={
						mode === "working_copy"
							? { backgroundColor: "var(--color-surface-3)", color: "var(--color-text-primary)" }
							: undefined
					}
				>
					All Changes
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onModeChange("last_turn")}
					className="h-5 rounded-sm text-xs"
					style={
						mode === "last_turn"
							? { backgroundColor: "var(--color-surface-3)", color: "var(--color-text-primary)" }
							: undefined
					}
				>
					Last Turn
				</Button>
			</div>
			{baseRef ? (
				<Tooltip content={`Comparing changes from ${branch ?? "working copy"} against ${baseRef}`} side="bottom">
					<div className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-md text-xs text-text-secondary bg-surface-1">
						<GitCompareArrows size={12} className="shrink-0 text-text-tertiary" />
						<span className="truncate max-w-[120px]">{branch ?? "working copy"}</span>
						<ArrowRight size={10} className="shrink-0 text-text-tertiary" />
						<span className="truncate max-w-[120px]">{baseRef}</span>
					</div>
				</Tooltip>
			) : null}
			<Button
				variant="ghost"
				size="sm"
				icon={isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				onClick={onToggleExpand}
				className="ml-auto h-5"
				aria-label={isExpanded ? "Collapse split diff view" : "Expand split diff view"}
			/>
		</div>
	);
}

function FileBrowserToolbar({
	isExpanded,
	onToggleExpand,
}: {
	isExpanded: boolean;
	onToggleExpand: () => void;
}): React.ReactElement {
	return (
		<div className="flex items-center gap-1 px-2 py-1 border-b border-border">
			{isExpanded ? (
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={14} />}
					onClick={onToggleExpand}
					className="h-5"
					aria-label="Collapse expanded file browser"
				/>
			) : null}
			<div className="flex items-center gap-1.5 text-xs text-text-secondary">
				<FolderOpen size={14} />
				<span>Files</span>
			</div>
			<Button
				variant="ghost"
				size="sm"
				icon={isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				onClick={onToggleExpand}
				className="ml-auto h-5"
				aria-label={isExpanded ? "Collapse file browser" : "Expand file browser"}
			/>
		</div>
	);
}

/**
 * Renders the task detail area: side panel (for task-tied tabs) + right column (TopBar + main content).
 * Returns a Fragment — its children are direct flex items of the parent container.
 * The sidebar toolbar is NOT rendered here — it lives in App.tsx.
 */
export function CardDetailView({
	selection,
	currentProjectId,
	sessionSummary,
	taskSessions,
	onSessionSummary,
	onCardSelect,
	onTaskDragEnd,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onMoveReviewCardToTrash,
	onRestoreTaskFromTrash,
	onRestartSessionTask,
	onCancelAutomaticTaskAction,
	onRegenerateTitleTask,
	isLlmGenerationDisabled,
	onUpdateTaskTitle,
	onTogglePinTask,
	moveToTrashLoadingById,
	onMigrateWorkingDirectory,
	migratingTaskId,
	showSummaryOnCards,
	onRequestDisplaySummary,
	onAddReviewComments,
	onSendReviewComments,
	gitHistoryPanel,
	bottomTerminalOpen,
	bottomTerminalTaskId,
	bottomTerminalSummary,
	bottomTerminalSubtitle,
	onBottomTerminalClose,
	onBottomTerminalCollapse,
	bottomTerminalPaneHeight,
	onBottomTerminalPaneHeightChange,
	onBottomTerminalConnectionReady,
	bottomTerminalAgentCommand,
	onBottomTerminalSendAgentCommand,
	isBottomTerminalExpanded,
	onBottomTerminalToggleExpand,
	onBottomTerminalRestart,
	onBottomTerminalExit,
	isDocumentVisible = true,
	// --- New props for sidebar decoupling ---
	activeTab,
	topBar,
	sidePanelRatio,
	setSidePanelRatio,
	isDiffExpanded,
	isFileBrowserExpanded,
	onDiffExpandedChange,
	onFileBrowserExpandedChange,
	detailDiffFileTreeRatio,
	setDetailDiffFileTreeRatio,
	detailFileBrowserTreeRatio,
	setDetailFileBrowserTreeRatio,
}: {
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
	onCardSelect: (taskId: string) => void;
	onTaskDragEnd: (result: DropResult) => void;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	onMoveReviewCardToTrash?: (taskId: string) => void;
	onRestoreTaskFromTrash?: (taskId: string) => void;
	onRestartSessionTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onRegenerateTitleTask?: (taskId: string) => void;
	isLlmGenerationDisabled?: boolean;
	onUpdateTaskTitle?: (taskId: string, title: string) => void;
	onTogglePinTask?: (taskId: string) => void;
	moveToTrashLoadingById?: Record<string, boolean>;
	onMigrateWorkingDirectory?: (taskId: string, direction: "isolate" | "de-isolate") => void;
	migratingTaskId?: string | null;
	showSummaryOnCards?: boolean;
	onRequestDisplaySummary?: (taskId: string) => void;
	onAddReviewComments?: (taskId: string, text: string) => void;
	onSendReviewComments?: (taskId: string, text: string) => void;
	gitHistoryPanel?: ReactNode;
	bottomTerminalOpen: boolean;
	bottomTerminalTaskId: string | null;
	bottomTerminalSummary: RuntimeTaskSessionSummary | null;
	bottomTerminalSubtitle?: string | null;
	onBottomTerminalClose: () => void;
	onBottomTerminalCollapse?: () => void;
	bottomTerminalPaneHeight?: number;
	onBottomTerminalPaneHeightChange?: (height: number) => void;
	onBottomTerminalConnectionReady?: (taskId: string) => void;
	bottomTerminalAgentCommand?: string | null;
	onBottomTerminalSendAgentCommand?: () => void;
	isBottomTerminalExpanded?: boolean;
	onBottomTerminalToggleExpand?: () => void;
	onBottomTerminalRestart?: () => void;
	onBottomTerminalExit?: (taskId: string, exitCode: number | null) => void;
	isDocumentVisible?: boolean;
	// --- New props ---
	activeTab: SidebarTabId | null;
	topBar: ReactNode;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	isDiffExpanded: boolean;
	isFileBrowserExpanded: boolean;
	onDiffExpandedChange: (expanded: boolean) => void;
	onFileBrowserExpandedChange: (expanded: boolean) => void;
	detailDiffFileTreeRatio: number;
	setDetailDiffFileTreeRatio: (ratio: number) => void;
	detailFileBrowserTreeRatio: number;
	setDetailFileBrowserTreeRatio: (ratio: number) => void;
}): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [fileBrowserSelectedPath, setFileBrowserSelectedPath] = useState<string | null>(null);
	const [fileBrowserExpandedDirs, setFileBrowserExpandedDirs] = useState<Set<string>>(new Set());
	const [fileBrowserHasInitializedExpansion, setFileBrowserHasInitializedExpansion] = useState(false);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());
	const [diffMode, setDiffMode] = useState<RuntimeWorkspaceChangesMode>("working_copy");

	const { startDrag: startSidePanelResize } = useResizeDrag();
	const { startDrag: startDetailDiffResize } = useResizeDrag();
	const { startDrag: startFileBrowserTreeResize } = useResizeDrag();
	const detailLayoutRef = useRef<HTMLDivElement | null>(null);
	const mainRowRef = useRef<HTMLDivElement | null>(null);
	const detailDiffRowRef = useRef<HTMLDivElement | null>(null);
	const fileBrowserRowRef = useRef<HTMLDivElement | null>(null);

	const handleSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = detailLayoutRef.current;
			if (!container) return;
			// No toolbar subtraction — toolbar is rendered by App.tsx outside this component
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startRatio = sidePanelRatio;
			startSidePanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
				onEnd: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
			});
		},
		[setSidePanelRatio, startSidePanelResize, sidePanelRatio],
	);

	const createRatioResizeHandler = useCallback(
		(
			containerRef: React.RefObject<HTMLDivElement | null>,
			currentRatio: number,
			setRatio: (ratio: number) => void,
			startDrag: ReturnType<typeof useResizeDrag>["startDrag"],
		) => {
			return (event: ReactMouseEvent<HTMLDivElement>) => {
				const container = containerRef.current;
				if (!container) return;
				const containerWidth = Math.max(container.offsetWidth, 1);
				const startX = event.clientX;
				startDrag(event, {
					axis: "x",
					cursor: "ew-resize",
					onMove: (pointerX) => setRatio(currentRatio + (pointerX - startX) / containerWidth),
					onEnd: (pointerX) => setRatio(currentRatio + (pointerX - startX) / containerWidth),
				});
			};
		},
		[],
	);

	const handleDetailDiffSeparatorMouseDown = useMemo(
		() =>
			createRatioResizeHandler(
				detailDiffRowRef,
				detailDiffFileTreeRatio,
				setDetailDiffFileTreeRatio,
				startDetailDiffResize,
			),
		[createRatioResizeHandler, detailDiffFileTreeRatio, setDetailDiffFileTreeRatio, startDetailDiffResize],
	);

	const handleFileBrowserTreeSeparatorMouseDown = useMemo(
		() =>
			createRatioResizeHandler(
				fileBrowserRowRef,
				detailFileBrowserTreeRatio,
				setDetailFileBrowserTreeRatio,
				startFileBrowserTreeResize,
			),
		[createRatioResizeHandler, detailFileBrowserTreeRatio, setDetailFileBrowserTreeRatio, startFileBrowserTreeResize],
	);

	const taskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(selection.card.id);
	const taskWorkspaceInfo = useTaskWorkspaceInfoValue(selection.card.id, selection.card.baseRef);
	const lastTurnViewKey =
		diffMode === "last_turn"
			? [
					sessionSummary?.state ?? "none",
					sessionSummary?.latestTurnCheckpoint?.commit ?? "none",
					sessionSummary?.previousTurnCheckpoint?.commit ?? "none",
				].join(":")
			: null;
	const { changes: workspaceChanges, isRuntimeAvailable } = useRuntimeWorkspaceChanges(
		selection.card.id,
		currentProjectId,
		selection.card.baseRef,
		diffMode,
		taskWorkspaceStateVersion,
		isDocumentVisible && !gitHistoryPanel && selection.column.id !== "trash" ? DETAIL_DIFF_POLL_INTERVAL_MS : null,
		lastTurnViewKey,
		true,
	);
	const runtimeFiles = workspaceChanges?.files ?? null;
	const isWorkspaceChangesPending = isRuntimeAvailable && workspaceChanges === null;
	const hasNoWorkspaceFileChanges =
		isRuntimeAvailable && workspaceChanges !== null && runtimeFiles !== null && runtimeFiles.length === 0;
	const emptyDiffTitle = diffMode === "last_turn" ? "No changes since last turn" : "No working changes";
	const sidePanelPercent = `${(sidePanelRatio * 100).toFixed(1)}%`;
	const detailDiffFileTreePanelPercent = `${(detailDiffFileTreeRatio * 100).toFixed(1)}%`;
	const detailDiffContentPanelPercent = `${((1 - detailDiffFileTreeRatio) * 100).toFixed(1)}%`;
	const detailDiffFileTreePanelFlex = `0 0 ${detailDiffFileTreePanelPercent}`;
	const fileBrowserTreePanelPercent = `${(detailFileBrowserTreeRatio * 100).toFixed(1)}%`;
	const fileBrowserContentPanelPercent = `${((1 - detailFileBrowserTreeRatio) * 100).toFixed(1)}%`;

	const isTaskSidePanelOpen = activeTab === "task_column" || activeTab === "changes" || activeTab === "files";
	const isTaskTerminalEnabled = selection.column.id === "in_progress" || selection.column.id === "review";
	const availablePaths = useMemo(() => {
		if (!runtimeFiles || runtimeFiles.length === 0) return [];
		return runtimeFiles.map((file) => file.path);
	}, [runtimeFiles]);

	const handleSelectAdjacentCard = useCallback(
		(step: number) => {
			const cards = selection.column.cards;
			const currentIndex = cards.findIndex((card) => card.id === selection.card.id);
			if (currentIndex === -1) return;
			const nextIndex = (currentIndex + step + cards.length) % cards.length;
			const nextCard = cards[nextIndex];
			if (nextCard) onCardSelect(nextCard.id);
		},
		[onCardSelect, selection.card.id, selection.column.cards],
	);

	useHotkeys(
		"up,left",
		() => handleSelectAdjacentCard(-1),
		{ ignoreEventWhen: (event) => isTypingTarget(event.target), preventDefault: true },
		[handleSelectAdjacentCard],
	);

	useHotkeys(
		"down,right",
		() => handleSelectAdjacentCard(1),
		{ ignoreEventWhen: (event) => isTypingTarget(event.target), preventDefault: true },
		[handleSelectAdjacentCard],
	);

	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) return;
		setSelectedPath(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath]);

	// Reset parent-owned state on task switch. The key={selection.card.id} on
	// FileBrowserPanel resets child-internal state (search, focus); this effect
	// resets lifted state that lives here and survives the child remount.
	useEffect(() => {
		setDiffComments(new Map());
		setDiffMode("working_copy");
		setFileBrowserSelectedPath(null);
		setFileBrowserExpandedDirs(new Set());
		setFileBrowserHasInitializedExpansion(false);
	}, [selection.card.id]);

	const handleToggleDiffExpand = useCallback(() => {
		if (!isDiffExpanded && bottomTerminalOpen) {
			onBottomTerminalClose();
		}
		onFileBrowserExpandedChange(false);
		onDiffExpandedChange(!isDiffExpanded);
	}, [bottomTerminalOpen, isDiffExpanded, onBottomTerminalClose, onDiffExpandedChange, onFileBrowserExpandedChange]);

	const handleToggleFileBrowserExpand = useCallback(() => {
		if (!isFileBrowserExpanded && bottomTerminalOpen) {
			onBottomTerminalClose();
		}
		onDiffExpandedChange(false);
		onFileBrowserExpandedChange(!isFileBrowserExpanded);
	}, [
		bottomTerminalOpen,
		isFileBrowserExpanded,
		onBottomTerminalClose,
		onDiffExpandedChange,
		onFileBrowserExpandedChange,
	]);

	const handleFileBrowserInitializedExpansion = useCallback(() => {
		setFileBrowserHasInitializedExpansion(true);
	}, []);

	const fileBrowserContent = useMemo(() => {
		if (!currentProjectId) {
			return (
				<div className="flex flex-1 items-center justify-center text-text-tertiary">
					<div className="flex flex-col items-center gap-3 py-12">
						<FolderOpen size={40} />
						<span className="text-sm text-text-secondary font-semibold">No project selected</span>
					</div>
				</div>
			);
		}
		return (
			<div ref={fileBrowserRowRef} className="flex flex-1 min-h-0">
				<FileBrowserPanel
					key={selection.card.id}
					taskId={selection.card.id}
					baseRef={selection.card.baseRef}
					workspaceId={currentProjectId}
					selectedPath={fileBrowserSelectedPath}
					onSelectPath={setFileBrowserSelectedPath}
					treePanelFlex={fileBrowserTreePanelPercent}
					contentPanelFlex={fileBrowserContentPanelPercent}
					onTreeResizeStart={handleFileBrowserTreeSeparatorMouseDown}
					expandedDirs={fileBrowserExpandedDirs}
					onExpandedDirsChange={setFileBrowserExpandedDirs}
					hasInitializedExpansion={fileBrowserHasInitializedExpansion}
					onInitializedExpansion={handleFileBrowserInitializedExpansion}
				/>
			</div>
		);
	}, [
		currentProjectId,
		selection.card.id,
		selection.card.baseRef,
		fileBrowserSelectedPath,
		fileBrowserTreePanelPercent,
		fileBrowserContentPanelPercent,
		handleFileBrowserTreeSeparatorMouseDown,
		fileBrowserExpandedDirs,
		fileBrowserHasInitializedExpansion,
		handleFileBrowserInitializedExpansion,
	]);

	const handleAddDiffComments = useCallback(
		(formatted: string) => {
			onAddReviewComments?.(selection.card.id, formatted);
		},
		[onAddReviewComments, selection.card.id],
	);

	const handleSendDiffComments = useCallback(
		(formatted: string) => {
			onSendReviewComments?.(selection.card.id, formatted);
			onDiffExpandedChange(false);
		},
		[onSendReviewComments, selection.card.id, onDiffExpandedChange],
	);

	// The component renders as a wrapper div whose children are the side panel + right column.
	// The wrapper is a flex row that fills the parent container.
	return (
		<div
			ref={detailLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			{/* Task-tied side panel — only when a task tab is active and not expanded */}
			{!isDiffExpanded && !isFileBrowserExpanded && isTaskSidePanelOpen ? (
				<>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							flex: `0 0 ${sidePanelPercent}`,
							minWidth: 0,
							minHeight: 0,
							overflow: "hidden",
						}}
					>
						{activeTab === "task_column" ? (
							<ColumnContextPanel
								selection={selection}
								onCardSelect={onCardSelect}
								taskSessions={taskSessions}
								onTaskDragEnd={onTaskDragEnd}
								onCreateTask={onCreateTask}
								onStartTask={onStartTask}
								onRestartSessionTask={onRestartSessionTask}
								onStartAllTasks={onStartAllTasks}
								onClearTrash={onClearTrash}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={onEditTask}
								onMoveToTrashTask={onMoveReviewCardToTrash}
								onRestoreFromTrashTask={onRestoreTaskFromTrash}
								onRegenerateTitleTask={onRegenerateTitleTask}
								isLlmGenerationDisabled={isLlmGenerationDisabled}
								onUpdateTaskTitle={onUpdateTaskTitle}
								onTogglePinTask={onTogglePinTask}
								moveToTrashLoadingById={moveToTrashLoadingById}
								onMigrateWorkingDirectory={onMigrateWorkingDirectory}
								migratingTaskId={migratingTaskId}
								showSummaryOnCards={showSummaryOnCards}
								onRequestDisplaySummary={onRequestDisplaySummary}
								panelWidth="100%"
							/>
						) : activeTab === "changes" ? (
							<>
								{isRuntimeAvailable ? (
									<DiffToolbar
										mode={diffMode}
										onModeChange={setDiffMode}
										isExpanded={isDiffExpanded}
										onToggleExpand={handleToggleDiffExpand}
										baseRef={selection.card.baseRef}
										branch={taskWorkspaceInfo?.branch ?? selection.card.branch ?? null}
									/>
								) : null}
								<div style={{ display: "flex", flex: "1 1 0", minHeight: 0 }}>
									{isWorkspaceChangesPending ? (
										<WorkspaceChangesLoadingPanel panelFlex={detailDiffFileTreePanelFlex} />
									) : hasNoWorkspaceFileChanges ? (
										<WorkspaceChangesEmptyPanel title={emptyDiffTitle} />
									) : (
										<div ref={detailDiffRowRef} style={{ display: "flex", flex: "1 1 0", minWidth: 0 }}>
											<div
												style={{
													display: "flex",
													flex: `0 0 ${detailDiffFileTreePanelPercent}`,
													minWidth: 0,
													minHeight: 0,
												}}
											>
												<FileTreePanel
													workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
													selectedPath={selectedPath}
													onSelectPath={setSelectedPath}
													panelFlex="1 1 0"
												/>
											</div>
											<ResizeHandle
												orientation="vertical"
												ariaLabel="Resize detail diff panels"
												onMouseDown={handleDetailDiffSeparatorMouseDown}
												className="z-10"
											/>
											<div
												style={{
													display: "flex",
													flex: `0 0 ${detailDiffContentPanelPercent}`,
													minWidth: 0,
													minHeight: 0,
												}}
											>
												<DiffViewerPanel
													workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
													selectedPath={selectedPath}
													onSelectedPathChange={setSelectedPath}
													viewMode="unified"
													onAddToTerminal={onAddReviewComments ? handleAddDiffComments : undefined}
													onSendToTerminal={onSendReviewComments ? handleSendDiffComments : undefined}
													comments={diffComments}
													onCommentsChange={setDiffComments}
												/>
											</div>
										</div>
									)}
								</div>
							</>
						) : activeTab === "files" ? (
							<>
								<FileBrowserToolbar
									isExpanded={isFileBrowserExpanded}
									onToggleExpand={handleToggleFileBrowserExpand}
								/>
								{fileBrowserContent}
							</>
						) : null}
					</div>
					<ResizeHandle
						orientation="vertical"
						ariaLabel="Resize side panel"
						onMouseDown={handleSidePanelSeparatorMouseDown}
						className="z-10"
					/>
				</>
			) : null}

			{/* Right column — TopBar + main content */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flex: "1 1 0",
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				{topBar}
				{gitHistoryPanel ? (
					<div style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>{gitHistoryPanel}</div>
				) : isDiffExpanded ? (
					<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
						<div style={{ display: "flex", width: "100%", minWidth: 0, minHeight: 0, flexDirection: "column" }}>
							{isRuntimeAvailable ? (
								<DiffToolbar
									mode={diffMode}
									onModeChange={setDiffMode}
									isExpanded={isDiffExpanded}
									onToggleExpand={handleToggleDiffExpand}
									baseRef={selection.card.baseRef}
									branch={taskWorkspaceInfo?.branch ?? selection.card.branch ?? null}
								/>
							) : null}
							<div style={{ display: "flex", flex: "1 1 0", minHeight: 0 }}>
								{isWorkspaceChangesPending ? (
									<WorkspaceChangesLoadingPanel panelFlex={detailDiffFileTreePanelFlex} />
								) : hasNoWorkspaceFileChanges ? (
									<WorkspaceChangesEmptyPanel title={emptyDiffTitle} />
								) : (
									<div ref={detailDiffRowRef} style={{ display: "flex", flex: "1 1 0", minWidth: 0 }}>
										<div
											style={{
												display: "flex",
												flex: `0 0 ${detailDiffFileTreePanelPercent}`,
												minWidth: 0,
												minHeight: 0,
											}}
										>
											<FileTreePanel
												workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
												selectedPath={selectedPath}
												onSelectPath={setSelectedPath}
												panelFlex="1 1 0"
											/>
										</div>
										<ResizeHandle
											orientation="vertical"
											ariaLabel="Resize detail diff panels"
											onMouseDown={handleDetailDiffSeparatorMouseDown}
											className="z-10"
										/>
										<div
											style={{
												display: "flex",
												flex: `0 0 ${detailDiffContentPanelPercent}`,
												minWidth: 0,
												minHeight: 0,
											}}
										>
											<DiffViewerPanel
												workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
												selectedPath={selectedPath}
												onSelectedPathChange={setSelectedPath}
												viewMode="split"
												onAddToTerminal={onAddReviewComments ? handleAddDiffComments : undefined}
												onSendToTerminal={onSendReviewComments ? handleSendDiffComments : undefined}
												comments={diffComments}
												onCommentsChange={setDiffComments}
											/>
										</div>
									</div>
								)}
							</div>
						</div>
					</div>
				) : isFileBrowserExpanded ? (
					<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
						<div style={{ display: "flex", width: "100%", minWidth: 0, minHeight: 0, flexDirection: "column" }}>
							<FileBrowserToolbar
								isExpanded={isFileBrowserExpanded}
								onToggleExpand={handleToggleFileBrowserExpand}
							/>
							{fileBrowserContent}
						</div>
					</div>
				) : (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
								<AgentTerminalPanel
									taskId={selection.card.id}
									workspaceId={currentProjectId}
									terminalEnabled={isTaskTerminalEnabled}
									summary={sessionSummary}
									onSummary={onSessionSummary}
									showSessionToolbar={false}
									autoFocus
									onCancelAutomaticAction={
										selection.card.autoReviewEnabled === true && onCancelAutomaticTaskAction
											? () => onCancelAutomaticTaskAction(selection.card.id)
											: undefined
									}
									cancelAutomaticActionLabel={
										selection.card.autoReviewEnabled === true
											? getTaskAutoReviewCancelButtonLabel(selection.card.autoReviewMode)
											: null
									}
									panelBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
									terminalBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
									taskColumnId={selection.column.id}
								/>
							</div>
						</div>
						{bottomTerminalOpen && bottomTerminalTaskId ? (
							<ResizableBottomPane
								minHeight={200}
								initialHeight={bottomTerminalPaneHeight}
								onHeightChange={onBottomTerminalPaneHeightChange}
								onCollapse={onBottomTerminalCollapse}
							>
								<div
									style={{
										display: "flex",
										flex: "1 1 0",
										minWidth: 0,
										paddingLeft: 12,
										paddingRight: 12,
									}}
								>
									<AgentTerminalPanel
										key={`detail-shell-${bottomTerminalTaskId}`}
										taskId={bottomTerminalTaskId}
										workspaceId={currentProjectId}
										summary={bottomTerminalSummary}
										onSummary={onSessionSummary}
										showSessionToolbar={false}
										autoFocus
										onClose={onBottomTerminalClose}
										minimalHeaderTitle="Terminal"
										minimalHeaderSubtitle={bottomTerminalSubtitle}
										panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										cursorColor={TERMINAL_THEME_COLORS.textPrimary}
										onConnectionReady={onBottomTerminalConnectionReady}
										agentCommand={bottomTerminalAgentCommand}
										onSendAgentCommand={onBottomTerminalSendAgentCommand}
										isExpanded={isBottomTerminalExpanded}
										onToggleExpand={onBottomTerminalToggleExpand}
										onRestart={onBottomTerminalRestart}
										onExit={onBottomTerminalExit}
									/>
								</div>
							</ResizableBottomPane>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}
