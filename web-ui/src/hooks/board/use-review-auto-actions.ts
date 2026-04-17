import { useCallback, useEffect, useRef } from "react";

import {
	AUTO_REVIEW_ACTION_DELAY_MS,
	buildColumnByTaskId,
	getReviewCardsForAutomation,
	isAutoTrashMode,
	isTaskAutoReviewEnabled,
} from "@/hooks/board/review-auto-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import { subscribeToAnyTaskMetadata } from "@/stores/project-metadata-store";
import type { BoardColumnId, BoardData, TaskAutoReviewMode } from "@/types";
import { isApprovalState } from "@/utils/session-status";

interface RequestMoveTaskToTrashOptions {
	skipWorkingChangeWarning?: boolean;
}

interface UseReviewAutoActionsOptions {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
	resetKey?: string | null;
}

export function useReviewAutoActions({
	board,
	sessions,
	requestMoveTaskToTrash,
	resetKey,
}: UseReviewAutoActionsOptions): void {
	const boardRef = useRef<BoardData>(board);
	const sessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>(sessions);
	const requestMoveTaskToTrashRef = useRef(requestMoveTaskToTrash);
	const timerByTaskIdRef = useRef<Record<string, number>>({});
	const scheduledActionByTaskIdRef = useRef<Record<string, TaskAutoReviewMode>>({});
	const moveToTrashInFlightTaskIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		requestMoveTaskToTrashRef.current = requestMoveTaskToTrash;
	}, [requestMoveTaskToTrash]);

	const clearAutoReviewTimer = useCallback((taskId: string) => {
		const timer = timerByTaskIdRef.current[taskId];
		if (typeof timer === "number") {
			window.clearTimeout(timer);
		}
		delete timerByTaskIdRef.current[taskId];
		delete scheduledActionByTaskIdRef.current[taskId];
	}, []);

	const clearAllAutoReviewState = useCallback(() => {
		for (const timer of Object.values(timerByTaskIdRef.current)) {
			window.clearTimeout(timer);
		}
		timerByTaskIdRef.current = {};
		scheduledActionByTaskIdRef.current = {};
		moveToTrashInFlightTaskIdsRef.current.clear();
	}, []);

	const scheduleAutoReviewAction = useCallback((taskId: string, action: TaskAutoReviewMode, execute: () => void) => {
		const existingTimer = timerByTaskIdRef.current[taskId];
		const existingAction = scheduledActionByTaskIdRef.current[taskId];
		if (typeof existingTimer === "number" && existingAction === action) {
			return;
		}
		if (typeof existingTimer === "number") {
			window.clearTimeout(existingTimer);
		}
		scheduledActionByTaskIdRef.current[taskId] = action;
		timerByTaskIdRef.current[taskId] = window.setTimeout(() => {
			delete timerByTaskIdRef.current[taskId];
			delete scheduledActionByTaskIdRef.current[taskId];
			execute();
		}, AUTO_REVIEW_ACTION_DELAY_MS);
	}, []);

	useEffect(() => {
		return () => {
			clearAllAutoReviewState();
		};
	}, [clearAllAutoReviewState]);

	useEffect(() => {
		clearAllAutoReviewState();
	}, [clearAllAutoReviewState, resetKey]);

	const evaluateAutoReview = useCallback(
		(_trigger: { source: string; taskId?: string }) => {
			const columnByTaskId = buildColumnByTaskId(boardRef.current);
			const reviewCardsForAutomation = getReviewCardsForAutomation(boardRef.current);

			for (const taskId of moveToTrashInFlightTaskIdsRef.current) {
				if (columnByTaskId.get(taskId) !== "review") {
					moveToTrashInFlightTaskIdsRef.current.delete(taskId);
				}
			}

			const reviewTaskIds = new Set(reviewCardsForAutomation.map((card) => card.id));
			for (const taskId of Object.keys(timerByTaskIdRef.current)) {
				if (!reviewTaskIds.has(taskId)) {
					clearAutoReviewTimer(taskId);
				}
			}

			for (const reviewTask of reviewCardsForAutomation) {
				const sessionSummary = sessionsRef.current[reviewTask.id] ?? null;
				if (isApprovalState(sessionSummary)) {
					clearAutoReviewTimer(reviewTask.id);
					continue;
				}

				if (moveToTrashInFlightTaskIdsRef.current.has(reviewTask.id)) {
					continue;
				}

				scheduleAutoReviewAction(reviewTask.id, "move_to_trash", () => {
					const latestSelection = findCardSelection(boardRef.current, reviewTask.id);
					if (!latestSelection || latestSelection.column.id !== "review") {
						return;
					}
					if (!isTaskAutoReviewEnabled(latestSelection.card)) {
						return;
					}
					if (!isAutoTrashMode(latestSelection.card)) {
						return;
					}
					moveToTrashInFlightTaskIdsRef.current.add(reviewTask.id);
					void requestMoveTaskToTrashRef
						.current(reviewTask.id, "review", {
							skipWorkingChangeWarning: true,
						})
						.finally(() => {
							moveToTrashInFlightTaskIdsRef.current.delete(reviewTask.id);
						});
				});
			}
		},
		[clearAutoReviewTimer, scheduleAutoReviewAction],
	);

	useEffect(() => {
		evaluateAutoReview({
			source: "board_or_loading_change",
		});
	}, [board, evaluateAutoReview]);

	useEffect(() => {
		return subscribeToAnyTaskMetadata((taskId) => {
			const selection = findCardSelection(boardRef.current, taskId);
			if (!selection || selection.column.id !== "review") {
				return;
			}
			evaluateAutoReview({
				source: "task_metadata_store",
				taskId,
			});
		});
	}, [evaluateAutoReview]);
}
