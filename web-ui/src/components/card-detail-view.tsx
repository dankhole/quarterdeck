import type { DropResult } from "@hello-pangea/dnd";
import { FolderOpen, GitCompareArrows, Maximize2, Minimize2, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import { DetailToolbar, TOOLBAR_WIDTH } from "@/components/detail-panels/detail-toolbar";
import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { FileBrowserPanel } from "@/components/detail-panels/file-browser-panel";
import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import { Button } from "@/components/ui/button";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import { useCardDetailLayout } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesMode } from "@/runtime/types";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import { useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import { type BoardCard, type CardSelection, getTaskAutoReviewCancelButtonLabel } from "@/types";
import { useWindowEvent } from "@/utils/react-use";

// We still poll the open detail diff because line content can change without changing
// the overall file or line counts that drive the shared workspace metadata stream.
const DETAIL_DIFF_POLL_INTERVAL_MS = 1_000;

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function isEventInsideDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[role='dialog']") !== null;
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
				<div
					style={{
						padding: "10px 10px 6px",
					}}
				>
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
			<div
				style={{
					display: "flex",
					flex: panelFlex,
					flexDirection: "column",
					padding: "10px 8px",
				}}
			>
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
}: {
	mode: RuntimeWorkspaceChangesMode;
	onModeChange: (mode: RuntimeWorkspaceChangesMode) => void;
	isExpanded: boolean;
	onToggleExpand: () => void;
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
	onCommitTask,
	onOpenPrTask,
	onAgentCommitTask,
	onAgentOpenPrTask,
	onMoveReviewCardToTrash,
	onRestoreTaskFromTrash,
	onCancelAutomaticTaskAction,
	onRegenerateTitleTask,
	onUpdateTaskTitle,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	agentCommitTaskLoadingById,
	agentOpenPrTaskLoadingById,
	moveToTrashLoadingById,
	onMigrateWorkingDirectory,
	migratingTaskId,
	onAddReviewComments,
	onSendReviewComments,
	gitHistoryPanel,
	onCloseGitHistory,
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
	isDocumentVisible = true,
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
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onAgentCommitTask?: (taskId: string) => void;
	onAgentOpenPrTask?: (taskId: string) => void;
	onMoveReviewCardToTrash?: (taskId: string) => void;
	onRestoreTaskFromTrash?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onRegenerateTitleTask?: (taskId: string) => void;
	onUpdateTaskTitle?: (taskId: string, title: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	agentCommitTaskLoadingById?: Record<string, boolean>;
	agentOpenPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	onMigrateWorkingDirectory?: (taskId: string, direction: "isolate" | "de-isolate") => void;
	migratingTaskId?: string | null;
	onAddReviewComments?: (taskId: string, text: string) => void;
	onSendReviewComments?: (taskId: string, text: string) => void;
	gitHistoryPanel?: ReactNode;
	onCloseGitHistory?: () => void;
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
	isDocumentVisible?: boolean;
}): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [fileBrowserSelectedPath, setFileBrowserSelectedPath] = useState<string | null>(null);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());
	const [diffMode, setDiffMode] = useState<RuntimeWorkspaceChangesMode>("working_copy");
	const [isDiffExpanded, setIsDiffExpanded] = useState(false);
	const [isFileBrowserExpanded, setIsFileBrowserExpanded] = useState(false);
	const {
		activeDetailPanel,
		setActiveDetailPanel,
		sidePanelRatio,
		setSidePanelRatio,
		detailDiffFileTreeRatio,
		setDetailDiffFileTreeRatio,
		detailFileBrowserTreeRatio,
		setDetailFileBrowserTreeRatio,
	} = useCardDetailLayout({
		isDiffExpanded,
		isFileBrowserExpanded,
	});
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
			if (!container) {
				return;
			}
			// Subtract toolbar width from container width so the ratio applies to the resizable area only
			const containerWidth = Math.max(container.offsetWidth - TOOLBAR_WIDTH, 1);
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
				if (!container) {
					return;
				}
				const containerWidth = Math.max(container.offsetWidth, 1);
				const startX = event.clientX;
				startDrag(event, {
					axis: "x",
					cursor: "ew-resize",
					onMove: (pointerX) => {
						setRatio(currentRatio + (pointerX - startX) / containerWidth);
					},
					onEnd: (pointerX) => {
						setRatio(currentRatio + (pointerX - startX) / containerWidth);
					},
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
	const isSidePanelOpen = activeDetailPanel !== null;
	const isTaskTerminalEnabled = selection.column.id === "in_progress" || selection.column.id === "review";
	const availablePaths = useMemo(() => {
		if (!runtimeFiles || runtimeFiles.length === 0) {
			return [];
		}
		return runtimeFiles.map((file) => file.path);
	}, [runtimeFiles]);

	const handleSelectAdjacentCard = useCallback(
		(step: number) => {
			const cards = selection.column.cards;
			const currentIndex = cards.findIndex((card) => card.id === selection.card.id);
			if (currentIndex === -1) {
				return;
			}
			const nextIndex = (currentIndex + step + cards.length) % cards.length;
			const nextCard = cards[nextIndex];
			if (nextCard) {
				onCardSelect(nextCard.id);
			}
		},
		[onCardSelect, selection.card.id, selection.column.cards],
	);

	useHotkeys(
		"up,left",
		() => {
			handleSelectAdjacentCard(-1);
		},
		{
			ignoreEventWhen: (event) => isTypingTarget(event.target),
			preventDefault: true,
		},
		[handleSelectAdjacentCard],
	);

	useWindowEvent(
		"keydown",
		useCallback(
			(event: KeyboardEvent) => {
				if (event.key !== "Escape" || event.defaultPrevented || isEventInsideDialog(event.target)) {
					return;
				}
				if (gitHistoryPanel && onCloseGitHistory) {
					event.preventDefault();
					onCloseGitHistory();
					return;
				}
				if (isTypingTarget(event.target)) {
					return;
				}
				if (isFileBrowserExpanded) {
					event.preventDefault();
					setIsFileBrowserExpanded(false);
					return;
				}
				if (isDiffExpanded) {
					event.preventDefault();
					setIsDiffExpanded(false);
				}
			},
			[gitHistoryPanel, isDiffExpanded, isFileBrowserExpanded, onCloseGitHistory],
		),
	);

	useHotkeys(
		"down,right",
		() => {
			handleSelectAdjacentCard(1);
		},
		{
			ignoreEventWhen: (event) => isTypingTarget(event.target),
			preventDefault: true,
		},
		[handleSelectAdjacentCard],
	);

	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) {
			return;
		}
		setSelectedPath(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath]);

	useEffect(() => {
		setDiffComments(new Map());
	}, [selection.card.id]);

	useEffect(() => {
		setDiffMode("working_copy");
		setIsDiffExpanded(false);
		setIsFileBrowserExpanded(false);
		setFileBrowserSelectedPath(null);
	}, [selection.card.id]);

	const handleToggleDiffExpand = useCallback(() => {
		if (!isDiffExpanded && bottomTerminalOpen) {
			onBottomTerminalClose();
		}
		setIsFileBrowserExpanded(false);
		setIsDiffExpanded((previous) => !previous);
	}, [bottomTerminalOpen, isDiffExpanded, onBottomTerminalClose]);

	const handleToggleFileBrowserExpand = useCallback(() => {
		if (!isFileBrowserExpanded && bottomTerminalOpen) {
			onBottomTerminalClose();
		}
		setIsDiffExpanded(false);
		setIsFileBrowserExpanded((previous) => !previous);
	}, [bottomTerminalOpen, isFileBrowserExpanded, onBottomTerminalClose]);

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
			setIsDiffExpanded(false);
		},
		[onSendReviewComments, selection.card.id],
	);

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
			{/* Toolbar — always visible unless diff or file browser is expanded */}
			{!isDiffExpanded && !isFileBrowserExpanded ? (
				<DetailToolbar
					activePanel={activeDetailPanel}
					onPanelChange={setActiveDetailPanel}
					hasUncommittedChanges={runtimeFiles !== null && runtimeFiles.length > 0}
				/>
			) : null}

			{/* Side panel — kanban, changes, or files, shown when activeDetailPanel is set */}
			{!isDiffExpanded && !isFileBrowserExpanded && isSidePanelOpen ? (
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
						{activeDetailPanel === "kanban" ? (
							<ColumnContextPanel
								selection={selection}
								onCardSelect={onCardSelect}
								taskSessions={taskSessions}
								onTaskDragEnd={onTaskDragEnd}
								onCreateTask={onCreateTask}
								onStartTask={onStartTask}
								onStartAllTasks={onStartAllTasks}
								onClearTrash={onClearTrash}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={onEditTask}
								onCommitTask={onCommitTask}
								onOpenPrTask={onOpenPrTask}
								onMoveToTrashTask={onMoveReviewCardToTrash}
								onRestoreFromTrashTask={onRestoreTaskFromTrash}
								onRegenerateTitleTask={onRegenerateTitleTask}
								onUpdateTaskTitle={onUpdateTaskTitle}
								commitTaskLoadingById={commitTaskLoadingById}
								openPrTaskLoadingById={openPrTaskLoadingById}
								moveToTrashLoadingById={moveToTrashLoadingById}
								onMigrateWorkingDirectory={onMigrateWorkingDirectory}
								migratingTaskId={migratingTaskId}
								panelWidth="100%"
							/>
						) : activeDetailPanel === "changes" ? (
							<>
								{isRuntimeAvailable ? (
									<DiffToolbar
										mode={diffMode}
										onModeChange={setDiffMode}
										isExpanded={isDiffExpanded}
										onToggleExpand={handleToggleDiffExpand}
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
						) : activeDetailPanel === "files" ? (
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

			{/* Main content area — agent panel + optional bottom terminal */}
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
				{gitHistoryPanel ? (
					<div style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>{gitHistoryPanel}</div>
				) : isDiffExpanded ? (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							<div
								style={{
									display: "flex",
									width: "100%",
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								{isRuntimeAvailable ? (
									<DiffToolbar
										mode={diffMode}
										onModeChange={setDiffMode}
										isExpanded={isDiffExpanded}
										onToggleExpand={handleToggleDiffExpand}
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
					</>
				) : isFileBrowserExpanded ? (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							<div
								style={{
									display: "flex",
									width: "100%",
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<FileBrowserToolbar
									isExpanded={isFileBrowserExpanded}
									onToggleExpand={handleToggleFileBrowserExpand}
								/>
								{fileBrowserContent}
							</div>
						</div>
					</>
				) : (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							<div
								style={{
									display: "flex",
									flex: "1 1 0",
									minWidth: 0,
									minHeight: 0,
								}}
							>
								<AgentTerminalPanel
									taskId={selection.card.id}
									workspaceId={currentProjectId}
									terminalEnabled={isTaskTerminalEnabled}
									summary={sessionSummary}
									onSummary={onSessionSummary}
									onCommit={onAgentCommitTask ? () => onAgentCommitTask(selection.card.id) : undefined}
									onOpenPr={onAgentOpenPrTask ? () => onAgentOpenPrTask(selection.card.id) : undefined}
									isCommitLoading={agentCommitTaskLoadingById?.[selection.card.id] ?? false}
									isOpenPrLoading={agentOpenPrTaskLoadingById?.[selection.card.id] ?? false}
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
