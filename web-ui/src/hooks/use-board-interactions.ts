import type { DropResult } from "@hello-pangea/dnd";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { TaskTrashWarningViewModel } from "@/components/task-trash-warning-dialog";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";

interface TaskGitActionLoadingStateLike {
	commitSource: "card" | "agent" | null;
	prSource: "card" | "agent" | null;
}

import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import {
	applyDragResult,
	clearColumnTasks,
	disableTaskAutoReview,
	findCardSelection,
	getTaskColumnId,
	moveTaskToColumn,
	removeTask,
	updateTask,
} from "@/state/board-state";
import { clearTaskWorkspaceInfo, setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface TrashWarningState {
	open: boolean;
	warning: TaskTrashWarningViewModel | null;
	card: BoardCard | null;
	fromColumnId: BoardColumnId | null;
	optimisticMoveApplied: boolean;
}

const INITIAL_TRASH_WARNING_STATE: TrashWarningState = {
	open: false,
	warning: null,
	card: null,
	fromColumnId: null,
	optimisticMoveApplied: false,
};

interface HardDeleteDialogState {
	open: boolean;
	taskId: string | null;
	taskTitle: string | null;
}

const INITIAL_HARD_DELETE_DIALOG_STATE: HardDeleteDialogState = {
	open: false,
	taskId: null,
	taskTitle: null,
};

interface PendingProgrammaticStartMoveCompletion {
	resolve: (started: boolean) => void;
	timeoutId: number;
}

interface UseBoardInteractionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	sendTaskSessionInput: (
		taskId: string,
		input: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	showTrashWorktreeNotice: boolean;
	saveTrashWorktreeNoticeDismissed: () => void;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingStateLike>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleHardDeleteTrashTask: (taskId: string) => void;
	hardDeleteDialogState: HardDeleteDialogState;
	handleCancelHardDelete: () => void;
	handleConfirmHardDelete: () => void;
	handleRestartTaskSession: (taskId: string) => void;
	handleCancelAutomaticTaskAction: (taskId: string) => void;
	handleOpenClearTrash: () => void;
	handleConfirmClearTrash: () => void;
	handleAddReviewComments: (taskId: string, text: string) => Promise<void>;
	handleSendReviewComments: (taskId: string, text: string) => Promise<void>;
	moveToTrashLoadingById: Record<string, boolean>;
	trashTaskCount: number;
	trashWarningState: TrashWarningState;
	handleCancelTrashWarning: () => void;
	handleConfirmTrashWarning: () => void;
}

export function useBoardInteractions({
	board,
	setBoard,
	sessions,
	setSessions,
	selectedCard,
	selectedTaskId,
	currentProjectId,
	setSelectedTaskId,
	setIsClearTrashDialogOpen,
	setIsGitHistoryOpen,
	stopTaskSession,
	cleanupTaskWorkspace,
	ensureTaskWorkspace,
	startTaskSession,
	fetchTaskWorkspaceInfo,
	sendTaskSessionInput,
	showTrashWorktreeNotice,
	saveTrashWorktreeNoticeDismissed,
	taskGitActionLoadingByTaskId: _taskGitActionLoadingByTaskId,
	runAutoReviewGitAction: _runAutoReviewGitAction,
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	const showNonIsolatedResumeWarning = () => {
		showAppToast({
			intent: "warning",
			icon: "info-sign",
			message:
				"Non-isolated tasks resume the most recent agent session in this repo. If other agents have run here, this may not be the original conversation.",
			timeout: 9000,
		});
	};

	const previousSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});
	const moveToTrashLoadingByIdRef = useRef<Record<string, true>>({});
	const pendingProgrammaticStartMoveCompletionByTaskIdRef = useRef<
		Record<string, PendingProgrammaticStartMoveCompletion>
	>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});
	const [trashWarningState, setTrashWarningState] = useState<TrashWarningState>(INITIAL_TRASH_WARNING_STATE);
	const trashWarningConfirmedRef = useRef(false);
	const [hardDeleteDialogState, setHardDeleteDialogState] = useState<HardDeleteDialogState>(
		INITIAL_HARD_DELETE_DIALOG_STATE,
	);
	const hardDeleteConfirmedRef = useRef(false);
	const {
		handleProgrammaticCardMoveReady,
		setRequestMoveTaskToTrashHandler,
		tryProgrammaticCardMove,
		consumeProgrammaticCardMove,
		resolvePendingProgrammaticTrashMove,
		waitForProgrammaticCardMoveAvailability,
		resetProgrammaticCardMoves,
		requestMoveTaskToTrashWithAnimation,
		programmaticCardMoveCycle,
	} = useProgrammaticCardMoves();

	const resolvePendingProgrammaticStartMove = useCallback((taskId: string, started: boolean) => {
		const pending = pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		if (!pending) {
			return;
		}
		window.clearTimeout(pending.timeoutId);
		delete pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		pending.resolve(started);
	}, []);

	const getPrimaryBoardTaskElement = useCallback((taskId: string): HTMLElement | null => {
		const boardElement = document.querySelector<HTMLElement>(".kb-board");
		if (!boardElement) {
			return null;
		}
		for (const element of boardElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
			if (element.dataset.taskId === taskId) {
				return element;
			}
		}
		return null;
	}, []);

	const waitForBacklogCardHeightToSettle = useCallback(
		async (taskId: string): Promise<void> => {
			if (!getPrimaryBoardTaskElement(taskId)) {
				return;
			}

			await new Promise<void>((resolve) => {
				let previousHeight = 0;
				let stableFrameCount = 0;
				let framesRemaining = 8;

				const measure = () => {
					const cardElement = getPrimaryBoardTaskElement(taskId);
					const nextHeight = cardElement?.getBoundingClientRect().height ?? 0;
					if (nextHeight > 0 && previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) {
						stableFrameCount += 1;
					} else {
						stableFrameCount = 0;
					}
					previousHeight = nextHeight;

					if (stableFrameCount >= 1 || framesRemaining <= 0) {
						resolve();
						return;
					}

					framesRemaining -= 1;
					window.requestAnimationFrame(measure);
				};

				window.requestAnimationFrame(measure);
			});
		},
		[getPrimaryBoardTaskElement],
	);

	const setTaskMoveToTrashLoading = useCallback((taskId: string, isLoading: boolean) => {
		if (isLoading) {
			moveToTrashLoadingByIdRef.current[taskId] = true;
			setMoveToTrashLoadingById((current) => {
				if (current[taskId]) {
					return current;
				}
				return {
					...current,
					[taskId]: true,
				};
			});
			return;
		}

		delete moveToTrashLoadingByIdRef.current[taskId];
		setMoveToTrashLoadingById((current) => {
			if (!current[taskId]) {
				return current;
			}
			const next = { ...current };
			delete next[taskId];
			return next;
		});
	}, []);

	const handleAddReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not add review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const handleSendReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not send review comments to the task session.",
					timeout: 7000,
				});
				return;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: submitted.message ?? "Could not submit review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const trashTaskIds = useMemo(() => {
		const trashColumn = board.columns.find((column) => column.id === "trash");
		return trashColumn ? trashColumn.cards.map((card) => card.id) : [];
	}, [board.columns]);
	const trashTaskCount = trashTaskIds.length;

	const kickoffTaskInProgress = useCallback(
		async (
			task: BoardCard,
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { optimisticMove?: boolean },
		): Promise<boolean> => {
			const optimisticMove = options?.optimisticMove ?? true;
			const isNonIsolated = task.useWorktree === false;

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			// Calling ensureTaskWorkspace would create an orphan worktree on disk.
			if (!isNonIsolated) {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					if (optimisticMove) {
						setBoard((currentBoard) => {
							const currentColumnId = getTaskColumnId(currentBoard, taskId);
							if (currentColumnId !== "in_progress") {
								return currentBoard;
							}
							const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
							return reverted.moved ? reverted.board : currentBoard;
						});
					}
					return false;
				}
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
				if (selectedTaskId === taskId) {
					if (ensured.response) {
						setTaskWorkspaceInfo({
							taskId,
							path: ensured.response.path,
							exists: true,
							baseRef: ensured.response.baseRef,
							branch: ensured.response.branch ?? null,
							isDetached: !ensured.response.branch,
							headCommit: ensured.response.baseCommit,
						});
					}
					const infoAfterEnsure = await fetchTaskWorkspaceInfo(task);
					if (infoAfterEnsure) {
						setTaskWorkspaceInfo(infoAfterEnsure);
					}
				}
			}

			const started = await startTaskSession(task);
			if (!started.ok) {
				notifyError(started.message ?? "Could not start task session.");
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (!optimisticMove) {
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== fromColumnId) {
						return currentBoard;
					}
					const moved = moveTaskToColumn(currentBoard, taskId, "in_progress", { insertAtTop: true });
					return moved.moved ? moved.board : currentBoard;
				});
			}
			return true;
		},
		[ensureTaskWorkspace, fetchTaskWorkspaceInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const startBacklogTaskImmediately = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			const selection = findCardSelection(board, task.id);
			if (!selection || selection.column.id !== "backlog") {
				return false;
			}

			setBoard((currentBoard) => {
				const currentSelection = findCardSelection(currentBoard, task.id);
				if (!currentSelection || currentSelection.column.id !== "backlog") {
					return currentBoard;
				}
				const moved = moveTaskToColumn(currentBoard, task.id, "in_progress", { insertAtTop: true });
				return moved.moved ? moved.board : currentBoard;
			});

			return kickoffTaskInProgress(task, task.id, "backlog", {
				optimisticMove: true,
			});
		},
		[board, kickoffTaskInProgress, setBoard],
	);

	const startBacklogTaskWithAnimation = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			if (selectedCard) {
				return startBacklogTaskImmediately(task);
			}

			await waitForBacklogCardHeightToSettle(task.id);

			const programmaticMoveAttempt = tryProgrammaticCardMove(task.id, "backlog", "in_progress");
			if (programmaticMoveAttempt === "blocked") {
				await waitForProgrammaticCardMoveAvailability();
				return startBacklogTaskWithAnimation(task);
			}
			if (programmaticMoveAttempt === "unavailable") {
				return kickoffTaskInProgress(task, task.id, "backlog", {
					optimisticMove: false,
				});
			}

			let resolveCompletion: ((started: boolean) => void) | null = null;
			const completionPromise = new Promise<boolean>((resolve) => {
				resolveCompletion = resolve;
			});
			const timeoutId = window.setTimeout(() => {
				resolvePendingProgrammaticStartMove(task.id, false);
			}, 5000);
			pendingProgrammaticStartMoveCompletionByTaskIdRef.current[task.id] = {
				resolve: (started) => {
					resolveCompletion?.(started);
					resolveCompletion = null;
				},
				timeoutId,
			};
			return completionPromise;
		},
		[
			kickoffTaskInProgress,
			resolvePendingProgrammaticStartMove,
			selectedCard,
			startBacklogTaskImmediately,
			tryProgrammaticCardMove,
			waitForBacklogCardHeightToSettle,
			waitForProgrammaticCardMoveAvailability,
		],
	);

	useEffect(() => {
		setBoard((currentBoard) => {
			let nextBoard = currentBoard;
			const previousSessions = previousSessionsRef.current;
			const blockedInterruptedTaskIds = new Set<string>();
			for (const summary of Object.values(sessions)) {
				const previous = previousSessions[summary.taskId];
				if (previous && previous.updatedAt > summary.updatedAt) {
					continue;
				}
				const columnId = getTaskColumnId(nextBoard, summary.taskId);
				if (summary.state === "awaiting_review" && columnId === "in_progress") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "review");
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (summary.state === "running" && columnId === "review") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "in_progress", {
						skipKickoff: true,
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (
					summary.state === "interrupted" &&
					previous?.state !== "interrupted" &&
					columnId &&
					columnId !== "trash"
				) {
					const nextTaskId = getNextDetailTaskIdAfterTrashMove(nextBoard, summary.taskId);
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "trash", {
						skipTrashWorkflow: true,
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						if (programmaticMoveAttempt === "blocked") {
							blockedInterruptedTaskIds.add(summary.taskId);
						}
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "trash", { insertAtTop: true });
					if (moved.moved) {
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						nextBoard = moved.board;
					}
				}
			}
			const nextPreviousSessions = { ...sessions };
			for (const taskId of blockedInterruptedTaskIds) {
				const previousSession = previousSessions[taskId];
				if (previousSession) {
					nextPreviousSessions[taskId] = previousSession;
					continue;
				}
				delete nextPreviousSessions[taskId];
			}
			previousSessionsRef.current = nextPreviousSessions;
			return nextBoard;
		});
	}, [programmaticCardMoveCycle, sessions, setBoard, setSelectedTaskId, tryProgrammaticCardMove]);

	const { confirmMoveTaskToTrash, handleCreateDependency, handleDeleteDependency, requestMoveTaskToTrash } =
		useLinkedBacklogTaskActions({
			board,
			setBoard,
			setSelectedTaskId,
			stopTaskSession,
			cleanupTaskWorkspace,
			kickoffTaskInProgress,
			startBacklogTaskWithAnimation,
			waitForBacklogStartAnimationAvailability: waitForProgrammaticCardMoveAvailability,
			onRequestTrashConfirmation: (viewModel, card, fromColumnId, optimisticMoveApplied) => {
				console.debug("[trash-warning] showing dialog", {
					cardId: card.id,
					fileCount: viewModel.fileCount,
					fromColumnId,
					optimisticMoveApplied,
				});
				setTrashWarningState({ open: true, warning: viewModel, card, fromColumnId, optimisticMoveApplied });
			},
			showTrashWorktreeNotice,
			saveTrashWorktreeNoticeDismissed,
		});

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	useReviewAutoActions({
		board,
		sessions,
		requestMoveTaskToTrash: requestMoveTaskToTrashWithAnimation,
		resetKey: currentProjectId,
	});

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const isNonIsolated = task.useWorktree === false;

			const revertToTrash = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== "review") {
						return currentBoard;
					}
					const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
						insertAtTop: true,
					});
					return reverted.moved ? reverted.board : currentBoard;
				});
			};

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			// Calling ensureTaskWorkspace would create an unwanted worktree.
			if (!isNonIsolated) {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					revertToTrash();
					return;
				}
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
			}

			const resumed = await startTaskSession(task, { resumeConversation: true, awaitReview: true });
			if (resumed.ok) {
				if (isNonIsolated) {
					showNonIsolatedResumeWarning();
				}
				setBoard((currentBoard) => {
					const disabledAutoReview = disableTaskAutoReview(currentBoard, taskId);
					return disabledAutoReview.updated ? disabledAutoReview.board : currentBoard;
				});
				return;
			}

			notifyError(resumed.message ?? "Could not resume task session.");
			revertToTrash();
		},
		[ensureTaskWorkspace, setBoard, startTaskSession],
	);

	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);

			const applied = applyDragResult(board, result, { programmaticCardMoveInFlight });

			const moveEvent = applied.moveEvent;
			if (!moveEvent) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				setBoard(applied.board);
				return;
			}

			if (moveEvent.toColumnId === "trash") {
				setBoard(applied.board);
				if (programmaticMoveBehavior?.skipTrashWorkflow) {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
					return;
				}
				const requestPromise = requestMoveTaskToTrash(moveEvent.taskId, moveEvent.fromColumnId, {
					optimisticMoveApplied: true,
					skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
				});
				void requestPromise.finally(() => {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
				});
				return;
			}

			if (moveEvent.fromColumnId === "trash" && moveEvent.toColumnId === "review") {
				setBoard(applied.board);
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (!movedSelection) {
					return;
				}
				void resumeTaskFromTrash(movedSelection.card, moveEvent.taskId, { optimisticMoveApplied: true });
				return;
			}

			setBoard(applied.board);

			if (
				moveEvent.toColumnId === "in_progress" &&
				moveEvent.fromColumnId === "backlog" &&
				!programmaticMoveBehavior?.skipKickoff
			) {
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (movedSelection) {
					void kickoffTaskInProgress(movedSelection.card, moveEvent.taskId, moveEvent.fromColumnId)
						.then((started) => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
						});
					return;
				}
				resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
				return;
			}
			resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
		},
		[
			board,
			consumeProgrammaticCardMove,
			kickoffTaskInProgress,
			requestMoveTaskToTrash,
			resumeTaskFromTrash,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			setBoard,
			setSelectedTaskId,
		],
	);

	const handleStartTask = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				return;
			}
			void startBacklogTaskWithAnimation(selection.card);
		},
		[board, startBacklogTaskWithAnimation],
	);

	const handleStartAllBacklogTasks = useCallback(
		(taskIds?: string[]) => {
			const requestedTaskIds =
				taskIds ?? board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
			if (requestedTaskIds.length === 0) {
				return;
			}

			let nextBoard = board;
			const pendingStarts: BoardCard[] = [];
			const startedTaskIds = new Set<string>();

			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(nextBoard, taskId);
				if (!selection || selection.column.id !== "backlog") {
					continue;
				}
				const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
				if (!moved.moved) {
					continue;
				}
				nextBoard = moved.board;
				const movedSelection = findCardSelection(nextBoard, taskId);
				if (!movedSelection) {
					continue;
				}
				pendingStarts.push(movedSelection.card);
				startedTaskIds.add(taskId);
			}

			if (pendingStarts.length === 0) {
				return;
			}

			setBoard(nextBoard);
			for (const task of pendingStarts) {
				void kickoffTaskInProgress(task, task.id, "backlog");
			}
		},
		[board, kickoffTaskInProgress, setBoard],
	);

	const handleDetailTaskDragEnd = useCallback(
		(result: DropResult) => {
			handleDragEnd(result);
		},
		[handleDragEnd],
	);

	const handleCardSelect = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id === "trash") {
				return;
			}
			setSelectedTaskId(taskId);
			setIsGitHistoryOpen(false);
		},
		[board, setIsGitHistoryOpen, setSelectedTaskId],
	);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		if (moveToTrashLoadingByIdRef.current[selectedCard.card.id] || trashWarningState.open) {
			return;
		}
		setTaskMoveToTrashLoading(selectedCard.card.id, true);
		void requestMoveTaskToTrashWithAnimation(selectedCard.card.id, selectedCard.column.id).finally(() => {
			setTaskMoveToTrashLoading(selectedCard.card.id, false);
		});
	}, [requestMoveTaskToTrashWithAnimation, selectedCard, setTaskMoveToTrashLoading, trashWarningState.open]);

	const handleMoveReviewCardToTrash = useCallback(
		(taskId: string) => {
			if (moveToTrashLoadingByIdRef.current[taskId] || trashWarningState.open) {
				return;
			}
			const selection = findCardSelection(board, taskId);
			const fromColumnId = selection?.column.id ?? "review";
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrashWithAnimation(taskId, fromColumnId).finally(() => {
				setTaskMoveToTrashLoading(taskId, false);
			});
		},
		[board, requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading, trashWarningState.open],
	);

	const handleRestoreTaskFromTrash = useCallback(
		(taskId: string) => {
			const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, "trash", "review");
			if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
				return;
			}

			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}

			const moved = moveTaskToColumn(board, taskId, "review", { insertAtTop: true });
			if (!moved.moved) {
				return;
			}
			setBoard(moved.board);
			const movedSelection = findCardSelection(moved.board, taskId);
			if (!movedSelection) {
				return;
			}
			void resumeTaskFromTrash(movedSelection.card, taskId, { optimisticMoveApplied: true });
		},
		[board, resumeTaskFromTrash, setBoard, tryProgrammaticCardMove],
	);

	const handleRestartTaskSession = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || (selection.column.id !== "in_progress" && selection.column.id !== "review")) {
				return;
			}
			const awaitReview = selection.column.id === "review";
			void (async () => {
				await stopTaskSession(taskId, { waitForExit: true });
				const started = await startTaskSession(selection.card, { resumeConversation: true, awaitReview });
				if (!started.ok) {
					notifyError(started.message ?? "Could not restart task session.");
				} else if (selection.card.useWorktree === false) {
					showNonIsolatedResumeWarning();
				}
			})();
		},
		[board, startTaskSession, stopTaskSession],
	);

	const handleCancelAutomaticTaskAction = useCallback(
		(taskId: string) => {
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection || selection.card.autoReviewEnabled !== true) {
					return currentBoard;
				}
				const updated = updateTask(currentBoard, taskId, {
					prompt: selection.card.prompt,
					startInPlanMode: selection.card.startInPlanMode,
					autoReviewEnabled: false,
					autoReviewMode: resolveTaskAutoReviewMode(selection.card.autoReviewMode),
					baseRef: selection.card.baseRef,
					useWorktree: selection.card.useWorktree,
				});
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleOpenClearTrash = useCallback(() => {
		if (trashTaskCount === 0) {
			return;
		}
		setIsClearTrashDialogOpen(true);
	}, [setIsClearTrashDialogOpen, trashTaskCount]);

	const handleConfirmClearTrash = useCallback(() => {
		const taskIds = [...trashTaskIds];
		setIsClearTrashDialogOpen(false);
		if (taskIds.length === 0) {
			return;
		}

		setBoard((currentBoard) => clearColumnTasks(currentBoard, "trash").board);
		setSessions((currentSessions) => {
			const nextSessions = { ...currentSessions };
			for (const taskId of taskIds) {
				delete nextSessions[taskId];
			}
			return nextSessions;
		});
		if (selectedTaskId && taskIds.includes(selectedTaskId)) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(selectedTaskId);
		}

		void (async () => {
			await Promise.all(
				taskIds.map(async (taskId) => {
					await stopTaskSession(taskId, { waitForExit: true });
					await cleanupTaskWorkspace(taskId);
				}),
			);
		})();
	}, [
		cleanupTaskWorkspace,
		selectedTaskId,
		setBoard,
		setIsClearTrashDialogOpen,
		setSelectedTaskId,
		setSessions,
		stopTaskSession,
		trashTaskIds,
	]);

	const handleHardDeleteTrashTask = useCallback(
		(taskId: string) => {
			const card = board.columns.flatMap((col) => col.cards).find((c) => c.id === taskId);
			setHardDeleteDialogState({
				open: true,
				taskId,
				taskTitle: card?.title ?? null,
			});
		},
		[board.columns],
	);

	const executeHardDelete = useCallback(
		(taskId: string) => {
			let didRemove = false;
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection || selection.column.id !== "trash") {
					return currentBoard;
				}
				const result = removeTask(currentBoard, taskId);
				if (!result.removed) {
					return currentBoard;
				}
				didRemove = true;
				return result.board;
			});
			if (!didRemove) {
				return;
			}

			setSessions((currentSessions) => {
				const nextSessions = { ...currentSessions };
				delete nextSessions[taskId];
				return nextSessions;
			});
			setSelectedTaskId((current) => {
				if (current === taskId) {
					clearTaskWorkspaceInfo(taskId);
					return null;
				}
				return current;
			});

			void (async () => {
				await stopTaskSession(taskId, { waitForExit: true });
				await cleanupTaskWorkspace(taskId);
			})();
		},
		[cleanupTaskWorkspace, setBoard, setSelectedTaskId, setSessions, stopTaskSession],
	);

	const handleCancelHardDelete = useCallback(() => {
		// Radix AlertDialog fires onOpenChange(false) after confirm — the ref guard
		// prevents the cancel handler from resetting state after confirm already ran.
		if (hardDeleteConfirmedRef.current) {
			hardDeleteConfirmedRef.current = false;
			return;
		}
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
	}, []);

	const handleConfirmHardDelete = useCallback(() => {
		if (!hardDeleteDialogState.open || !hardDeleteDialogState.taskId) {
			return;
		}
		hardDeleteConfirmedRef.current = true;
		const { taskId } = hardDeleteDialogState;
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
		executeHardDelete(taskId);
	}, [executeHardDelete, hardDeleteDialogState]);

	const handleCancelTrashWarning = useCallback(() => {
		// When the user clicks confirm, Radix AlertDialog fires onOpenChange(false) which triggers
		// this cancel handler with a stale closure (React state hasn't re-rendered yet). The ref
		// lets us detect that confirm already ran and skip the revert.
		if (trashWarningConfirmedRef.current) {
			console.debug("[trash-warning] cancel skipped — confirm already in progress (ref guard)");
			trashWarningConfirmedRef.current = false;
			return;
		}
		const { card, fromColumnId, optimisticMoveApplied } = trashWarningState;
		console.debug("[trash-warning] cancel handler fired", {
			open: trashWarningState.open,
			cardId: card?.id ?? null,
			fromColumnId,
			optimisticMoveApplied,
		});
		if (trashWarningState.open && card && fromColumnId && optimisticMoveApplied) {
			console.debug("[trash-warning] reverting optimistic move", { cardId: card.id, fromColumnId });
			setBoard((currentBoard) => {
				const reverted = moveTaskToColumn(currentBoard, card.id, fromColumnId);
				return reverted.moved ? reverted.board : currentBoard;
			});
		}
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
	}, [setBoard, trashWarningState]);

	const handleConfirmTrashWarning = useCallback(() => {
		if (!trashWarningState.open || !trashWarningState.card) {
			console.debug("[trash-warning] confirm handler bailed — no open state or card");
			return;
		}
		const { card } = trashWarningState;
		console.debug("[trash-warning] confirm handler — trashing card", { cardId: card.id });
		trashWarningConfirmedRef.current = true;
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
		void confirmMoveTaskToTrash(card).then(
			() => console.debug("[trash-warning] confirmMoveTaskToTrash resolved", { cardId: card.id }),
			(err) => console.error("[trash-warning] confirmMoveTaskToTrash failed", { cardId: card.id, err }),
		);
	}, [confirmMoveTaskToTrash, trashWarningState]);

	const resetBoardInteractionsState = useCallback(() => {
		previousSessionsRef.current = {};
		moveToTrashLoadingByIdRef.current = {};
		setMoveToTrashLoadingById({});
		for (const taskId of Object.keys(pendingProgrammaticStartMoveCompletionByTaskIdRef.current)) {
			resolvePendingProgrammaticStartMove(taskId, false);
		}
		resetProgrammaticCardMoves();
		setIsClearTrashDialogOpen(false);
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
	}, [resetProgrammaticCardMoves, resolvePendingProgrammaticStartMove, setIsClearTrashDialogOpen]);

	useEffect(() => {
		resetBoardInteractionsState();
	}, [currentProjectId, resetBoardInteractionsState]);

	return {
		handleProgrammaticCardMoveReady,
		confirmMoveTaskToTrash,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		hardDeleteDialogState,
		handleCancelHardDelete,
		handleConfirmHardDelete,
		handleRestartTaskSession,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		handleCancelTrashWarning,
		handleConfirmTrashWarning,
	};
}
