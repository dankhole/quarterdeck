import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { RuntimeProjectMetadata } from "@/runtime/types";
import { reconcileTaskBranch, reconcileTaskWorkingDirectory } from "@/state/board-state";
import {
	getProjectPath,
	getTaskWorktreeSnapshot,
	replaceProjectMetadata,
	subscribeToAnyTaskMetadata,
} from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";

interface UseBoardMetadataSyncInput {
	projectMetadata: RuntimeProjectMetadata | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}

/**
 * Keeps the project metadata store and board cards in sync.
 *
 * 1. Pushes incoming project metadata into the external store.
 * 2. Self-heals card.workingDirectory and card.branch when the metadata monitor
 *    reports values different from what the card has persisted. This catches
 *    drift after migration, manual worktree changes, or any server-side CWD
 *    resolution that the UI missed.
 */
export function useBoardMetadataSync({ projectMetadata, setBoard }: UseBoardMetadataSyncInput): void {
	useEffect(() => {
		replaceProjectMetadata(projectMetadata);
	}, [projectMetadata]);

	useEffect(() => {
		return subscribeToAnyTaskMetadata((taskId) => {
			const snapshot = getTaskWorktreeSnapshot(taskId);
			if (!snapshot?.path) {
				return;
			}
			setBoard((currentBoard) => {
				const wdResult = reconcileTaskWorkingDirectory(currentBoard, taskId, snapshot.path, getProjectPath());
				const branchResult = reconcileTaskBranch(wdResult.board, taskId, snapshot.branch);
				const updated = wdResult.updated || branchResult.updated;
				return updated ? branchResult.board : currentBoard;
			});
		});
	}, [setBoard]);
}
