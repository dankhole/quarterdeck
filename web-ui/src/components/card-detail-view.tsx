import { Button, Classes, Colors, NonIdealState, SegmentedControl } from "@blueprintjs/core";
import type { DropResult } from "@hello-pangea/dnd";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import { ResizableBottomPane } from "@/components/resizable-bottom-pane";
import { panelSeparatorColor } from "@/data/column-colors";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesMode } from "@/runtime/types";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import { useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";
import { type BoardCard, type CardSelection, getTaskAutoReviewActionLabel } from "@/types";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

// We still poll the open detail diff because line content can change without changing
// the overall file or line counts that drive the shared workspace metadata stream.
const DETAIL_DIFF_POLL_INTERVAL_MS = 1_000;

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

const COLLAPSED_FILE_TREE_PANEL_BASIS = "33.3333%";
const EXPANDED_FILE_TREE_PANEL_BASIS = "16%";

function WorkspaceChangesLoadingPanel({ panelFlex }: { panelFlex: string }): React.ReactElement {
	return (
		<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0, background: Colors.DARK_GRAY1 }}>
			<div
				style={{
					display: "flex",
					flex: "1 1 0",
					flexDirection: "column",
					borderRight: `1px solid ${panelSeparatorColor}`,
				}}
			>
				<div
					style={{
						padding: "10px 10px 6px",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
						<div className={Classes.SKELETON} style={{ height: 14, width: "62%", borderRadius: 3 }} />
						<div className={Classes.SKELETON} style={{ height: 16, width: 42, borderRadius: 999 }} />
					</div>
					<div
						className={Classes.SKELETON}
						style={{ height: 13, width: "92%", borderRadius: 3, marginBottom: 7 }}
					/>
					<div
						className={Classes.SKELETON}
						style={{ height: 13, width: "84%", borderRadius: 3, marginBottom: 7 }}
					/>
					<div
						className={Classes.SKELETON}
						style={{ height: 13, width: "95%", borderRadius: 3, marginBottom: 7 }}
					/>
					<div
						className={Classes.SKELETON}
						style={{ height: 13, width: "79%", borderRadius: 3, marginBottom: 7 }}
					/>
					<div
						className={Classes.SKELETON}
						style={{ height: 13, width: "88%", borderRadius: 3, marginBottom: 7 }}
					/>
					<div className={Classes.SKELETON} style={{ height: 13, width: "76%", borderRadius: 3 }} />
				</div>
				<div style={{ flex: "1 1 0" }} />
			</div>
			<div
				style={{
					display: "flex",
					flex: panelFlex,
					flexDirection: "column",
					minWidth: 0,
					padding: "10px 8px",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className={Classes.SKELETON} style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className={Classes.SKELETON} style={{ height: 13, width: "61%", borderRadius: 3 }} />
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className={Classes.SKELETON} style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className={Classes.SKELETON} style={{ height: 13, width: "70%", borderRadius: 3 }} />
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 2 }}>
					<div className={Classes.SKELETON} style={{ height: 12, width: 12, borderRadius: 2 }} />
					<div className={Classes.SKELETON} style={{ height: 13, width: "53%", borderRadius: 3 }} />
				</div>
				<div style={{ flex: "1 1 0" }} />
			</div>
		</div>
	);
}

function WorkspaceChangesEmptyPanel({ title }: { title: string }): React.ReactElement {
	return (
		<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0, background: Colors.DARK_GRAY1 }}>
			<div className="kb-empty-state-center" style={{ flex: 1 }}>
				<NonIdealState icon="comparison" title={title} />
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
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				padding: "6px 10px",
				borderBottom: `1px solid ${panelSeparatorColor}`,
				background: Colors.DARK_GRAY2,
			}}
		>
			<SegmentedControl
				size="small"
				value={mode}
				onValueChange={(value) => onModeChange(value as RuntimeWorkspaceChangesMode)}
				options={[
					{ label: "Last Turn", value: "last_turn" },
					{ label: "All Changes", value: "working_copy" },
				]}
			/>
			<div style={{ display: "flex", alignItems: "center", gap: 4 }}>
				<Button
					icon={isExpanded ? "minimize" : "maximize"}
					variant="minimal"
					size="small"
					onClick={onToggleExpand}
				/>
			</div>
		</div>
	);
}

const DEFAULT_AGENT_PANEL_RATIO = 0.4;
const MIN_AGENT_PANEL_RATIO = 0.15;
const MAX_AGENT_PANEL_RATIO = 0.75;

export function CardDetailView({
	selection,
	currentProjectId,
	sessionSummary,
	taskSessions,
	onSessionSummary,
	onBack,
	onCardSelect,
	onTaskDragEnd,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	inlineTaskCreator,
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
	commitTaskLoadingById,
	openPrTaskLoadingById,
	agentCommitTaskLoadingById,
	agentOpenPrTaskLoadingById,
	moveToTrashLoadingById,
	onAddReviewComments,
	onSendReviewComments,
	onMoveToTrash,
	isMoveToTrashLoading,
	gitHistoryPanel,
	bottomTerminalOpen,
	bottomTerminalTaskId,
	bottomTerminalSummary,
	bottomTerminalSubtitle,
	onBottomTerminalClose,
	bottomTerminalPaneHeight,
	onBottomTerminalPaneHeightChange,
	onBottomTerminalConnectionReady,
	bottomTerminalAgentCommand,
	onBottomTerminalSendAgentCommand,
	isBottomTerminalExpanded,
	onBottomTerminalToggleExpand,
	isDocumentVisible = true,
}: {
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
	onBack: () => void;
	onCardSelect: (taskId: string) => void;
	onTaskDragEnd: (result: DropResult) => void;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	inlineTaskCreator?: ReactNode;
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
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	agentCommitTaskLoadingById?: Record<string, boolean>;
	agentOpenPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	onAddReviewComments?: (taskId: string, text: string) => void;
	onSendReviewComments?: (taskId: string, text: string) => void;
	onMoveToTrash: () => void;
	isMoveToTrashLoading?: boolean;
	gitHistoryPanel?: ReactNode;
	bottomTerminalOpen: boolean;
	bottomTerminalTaskId: string | null;
	bottomTerminalSummary: RuntimeTaskSessionSummary | null;
	bottomTerminalSubtitle?: string | null;
	onBottomTerminalClose: () => void;
	bottomTerminalPaneHeight?: number;
	onBottomTerminalPaneHeightChange?: (height: number) => void;
	onBottomTerminalConnectionReady?: (taskId: string) => void;
	bottomTerminalAgentCommand?: string | null;
	onBottomTerminalSendAgentCommand?: () => void;
	isBottomTerminalExpanded?: boolean;
	onBottomTerminalToggleExpand?: () => void;
	isDocumentVisible?: boolean;
}): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());
	const [diffMode, setDiffMode] = useState<RuntimeWorkspaceChangesMode>("last_turn");
	const [isDiffExpanded, setIsDiffExpanded] = useState(false);
	const [agentPanelRatio, setAgentPanelRatio] = useState(DEFAULT_AGENT_PANEL_RATIO);
	const [isResizing, setIsResizing] = useState(false);
	const resizeDragRef = useRef<{ startX: number; startRatio: number; containerWidth: number } | null>(null);
	const previousBodyStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);
	const mainRowRef = useRef<HTMLDivElement>(null);

	const stopResize = useCallback(() => {
		setIsResizing(false);
		const previousBodyStyle = previousBodyStyleRef.current;
		if (previousBodyStyle) {
			document.body.style.userSelect = previousBodyStyle.userSelect;
			document.body.style.cursor = previousBodyStyle.cursor;
			previousBodyStyleRef.current = null;
		}
		resizeDragRef.current = null;
	}, []);

	useUnmount(() => {
		stopResize();
	});

	const handleResizeMouseMove = useCallback(
		(event: MouseEvent) => {
			const dragState = resizeDragRef.current;
			if (!isResizing || !dragState) {
				return;
			}
			const deltaX = event.clientX - dragState.startX;
			const deltaRatio = deltaX / dragState.containerWidth;
			const nextRatio = Math.max(
				MIN_AGENT_PANEL_RATIO,
				Math.min(MAX_AGENT_PANEL_RATIO, dragState.startRatio + deltaRatio),
			);
			setAgentPanelRatio(nextRatio);
		},
		[isResizing],
	);

	const handleResizeMouseUp = useCallback(() => {
		if (!isResizing) {
			return;
		}
		stopResize();
	}, [isResizing, stopResize]);

	useWindowEvent("mousemove", isResizing ? handleResizeMouseMove : null);
	useWindowEvent("mouseup", isResizing ? handleResizeMouseUp : null);

	const handleSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			if (isResizing) {
				stopResize();
			}
			const container = mainRowRef.current;
			if (!container) {
				return;
			}
			resizeDragRef.current = {
				startX: event.clientX,
				startRatio: agentPanelRatio,
				containerWidth: container.offsetWidth,
			};
			setIsResizing(true);
			previousBodyStyleRef.current = {
				userSelect: document.body.style.userSelect,
				cursor: document.body.style.cursor,
			};
			document.body.style.userSelect = "none";
			document.body.style.cursor = "ew-resize";
		},
		[agentPanelRatio, isResizing, stopResize],
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
	const shouldClearLastTurnDuringTransition = diffMode !== "last_turn" || sessionSummary?.state === "running";
	const { changes: workspaceChanges, isRuntimeAvailable } = useRuntimeWorkspaceChanges(
		selection.card.id,
		currentProjectId,
		selection.card.baseRef,
		diffMode,
		taskWorkspaceStateVersion,
		isDocumentVisible && !gitHistoryPanel ? DETAIL_DIFF_POLL_INTERVAL_MS : null,
		lastTurnViewKey,
		shouldClearLastTurnDuringTransition,
	);
	const runtimeFiles = workspaceChanges?.files ?? null;
	const isWorkspaceChangesPending = isRuntimeAvailable && workspaceChanges === null;
	const hasNoWorkspaceFileChanges =
		isRuntimeAvailable && workspaceChanges !== null && runtimeFiles !== null && runtimeFiles.length === 0;
	const emptyDiffTitle = diffMode === "last_turn" ? "No last-turn changes yet" : "No working changes";
	const showMoveToTrashActions = selection.column.id === "review" || selection.column.id === "in_progress";
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
		"esc",
		() => {
			onBack();
		},
		{
			ignoreEventWhen: (event) => isTypingTarget(event.target),
			preventDefault: true,
		},
		[onBack],
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
		setDiffMode("last_turn");
	}, [selection.card.id]);

	const agentPanelPercent = `${(agentPanelRatio * 100).toFixed(1)}%`;
	const diffPanelPercent = `${((1 - agentPanelRatio) * 100).toFixed(1)}%`;
	const fileTreePanelFlex = `0 0 ${isDiffExpanded ? EXPANDED_FILE_TREE_PANEL_BASIS : COLLAPSED_FILE_TREE_PANEL_BASIS}`;

	return (
		<div style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden", background: Colors.DARK_GRAY1 }}>
			{!isDiffExpanded ? (
				<ColumnContextPanel
					selection={selection}
					onCardSelect={onCardSelect}
					taskSessions={taskSessions}
					onTaskDragEnd={onTaskDragEnd}
					onCreateTask={onCreateTask}
					onStartTask={onStartTask}
					onStartAllTasks={onStartAllTasks}
					onClearTrash={onClearTrash}
					inlineTaskCreator={inlineTaskCreator}
					editingTaskId={editingTaskId}
					inlineTaskEditor={inlineTaskEditor}
					onEditTask={onEditTask}
					onCommitTask={onCommitTask}
					onOpenPrTask={onOpenPrTask}
					onMoveToTrashTask={onMoveReviewCardToTrash}
					onRestoreFromTrashTask={onRestoreTaskFromTrash}
					commitTaskLoadingById={commitTaskLoadingById}
					openPrTaskLoadingById={openPrTaskLoadingById}
					moveToTrashLoadingById={moveToTrashLoadingById}
				/>
			) : null}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					width: isDiffExpanded ? "100%" : "80%",
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				{gitHistoryPanel ? (
					<div style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>{gitHistoryPanel}</div>
				) : (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							{!isDiffExpanded ? (
								<div style={{ display: "flex", width: agentPanelPercent, minWidth: 0, minHeight: 0 }}>
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
										showMoveToTrash={showMoveToTrashActions}
										onMoveToTrash={onMoveToTrash}
										isMoveToTrashLoading={isMoveToTrashLoading}
										onCancelAutomaticAction={
											selection.card.autoReviewEnabled === true && onCancelAutomaticTaskAction
												? () => onCancelAutomaticTaskAction(selection.card.id)
												: undefined
										}
										cancelAutomaticActionLabel={
											selection.card.autoReviewEnabled === true
												? getTaskAutoReviewActionLabel(selection.card.autoReviewMode)
												: null
										}
										taskColumnId={selection.column.id}
									/>
								</div>
							) : null}
							{!isDiffExpanded ? (
								<div
									role="separator"
									aria-orientation="vertical"
									aria-label="Resize agent and diff panels"
									style={{
										position: "relative",
										flex: "0 0 1px",
										background: panelSeparatorColor,
										zIndex: 2,
									}}
								>
									<div
										onMouseDown={handleSeparatorMouseDown}
										style={{
											position: "absolute",
											left: -2,
											right: -2,
											top: 0,
											bottom: 0,
											cursor: "ew-resize",
										}}
									/>
								</div>
							) : null}
							<div
								style={{
									display: "flex",
									width: isDiffExpanded ? "100%" : diffPanelPercent,
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
										onToggleExpand={() => setIsDiffExpanded((prev) => !prev)}
									/>
								) : null}
								<div style={{ display: "flex", flex: "1 1 0", minHeight: 0 }}>
									{isWorkspaceChangesPending ? (
										<WorkspaceChangesLoadingPanel panelFlex={fileTreePanelFlex} />
									) : hasNoWorkspaceFileChanges ? (
										<WorkspaceChangesEmptyPanel title={emptyDiffTitle} />
									) : (
										<>
											<DiffViewerPanel
												workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
												selectedPath={selectedPath}
												onSelectedPathChange={setSelectedPath}
												viewMode={isDiffExpanded ? "split" : "unified"}
												onAddToTerminal={
													onAddReviewComments
														? (formatted) => onAddReviewComments(selection.card.id, formatted)
														: undefined
												}
												onSendToTerminal={
													onSendReviewComments
														? (formatted) => {
															onSendReviewComments(selection.card.id, formatted);
															setIsDiffExpanded(false);
														}
														: undefined
												}
												comments={diffComments}
												onCommentsChange={setDiffComments}
											/>
											<FileTreePanel
												workspaceFiles={isRuntimeAvailable ? runtimeFiles : null}
												selectedPath={selectedPath}
												onSelectPath={setSelectedPath}
												panelFlex={fileTreePanelFlex}
											/>
										</>
									)}
								</div>
							</div>
						</div>
						{bottomTerminalOpen && bottomTerminalTaskId ? (
							<ResizableBottomPane
								minHeight={200}
								initialHeight={bottomTerminalPaneHeight}
								onHeightChange={onBottomTerminalPaneHeightChange}
							>
								<div
									style={{
										display: "flex",
										flex: "1 1 0",
										minWidth: 0,
										paddingLeft: "calc(var(--bp-surface-spacing) * 3)",
										paddingRight: "calc(var(--bp-surface-spacing) * 3)",
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
										panelBackgroundColor={Colors.DARK_GRAY2}
										terminalBackgroundColor={Colors.DARK_GRAY2}
										cursorColor={Colors.LIGHT_GRAY5}
										showRightBorder={false}
										onConnectionReady={onBottomTerminalConnectionReady}
										agentCommand={bottomTerminalAgentCommand}
										onSendAgentCommand={onBottomTerminalSendAgentCommand}
										isExpanded={isBottomTerminalExpanded}
										onToggleExpand={onBottomTerminalToggleExpand}
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
