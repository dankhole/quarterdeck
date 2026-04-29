import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import { applyTaskBaseRefUpdateToBoard } from "@/hooks/board/task-base-ref-sync";
import type { TaskBaseRefUpdate } from "@/runtime/use-runtime-state-stream";
import type { BoardData } from "@/types";

interface UseTaskBaseRefSyncInput {
	latestTaskBaseRefUpdate: TaskBaseRefUpdate | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}

/**
 * Applies base ref updates received via WebSocket to the board.
 * Empty base refs are intentional: they mean the base is unresolved and the user
 * needs to pick one.
 * Skips cards with `baseRefPinned: true` — those are manually locked.
 */
export function useTaskBaseRefSync({ latestTaskBaseRefUpdate, setBoard }: UseTaskBaseRefSyncInput): void {
	useEffect(() => {
		if (!latestTaskBaseRefUpdate) {
			return;
		}
		const { taskId, baseRef } = latestTaskBaseRefUpdate;
		setBoard((current) => {
			return applyTaskBaseRefUpdateToBoard(current, { taskId, baseRef });
		});
	}, [latestTaskBaseRefUpdate, setBoard]);
}
