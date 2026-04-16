import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { RuntimeWorkspaceMetadata } from "@/runtime/types";
import { reconcileTaskBranch, reconcileTaskWorkingDirectory } from "@/state/board-state";
import {
	getTaskWorkspaceSnapshot,
	getWorkspacePath,
	replaceWorkspaceMetadata,
	subscribeToAnyTaskMetadata,
} from "@/stores/workspace-metadata-store";
import type { BoardData } from "@/types";

interface UseBoardMetadataSyncInput {
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}

/**
 * Keeps the workspace metadata store and board cards in sync.
 *
 * 1. Pushes incoming workspace metadata into the external store.
 * 2. Self-heals card.workingDirectory and card.branch when the metadata monitor
 *    reports values different from what the card has persisted. This catches
 *    drift after migration, manual worktree changes, or any server-side CWD
 *    resolution that the UI missed.
 */
export function useBoardMetadataSync({ workspaceMetadata, setBoard }: UseBoardMetadataSyncInput): void {
	useEffect(() => {
		replaceWorkspaceMetadata(workspaceMetadata);
	}, [workspaceMetadata]);

	useEffect(() => {
		return subscribeToAnyTaskMetadata((taskId) => {
			const snapshot = getTaskWorkspaceSnapshot(taskId);
			if (!snapshot?.path) {
				return;
			}
			setBoard((currentBoard) => {
				const wdResult = reconcileTaskWorkingDirectory(currentBoard, taskId, snapshot.path, getWorkspacePath());
				const branchResult = reconcileTaskBranch(wdResult.board, taskId, snapshot.branch);
				const updated = wdResult.updated || branchResult.updated;
				return updated ? branchResult.board : currentBoard;
			});
		});
	}, [setBoard]);
}
