import type {
	RuntimeBoardColumnId,
	RuntimeConflictState,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskImage,
} from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;

export type TaskAutoReviewMode = RuntimeTaskAutoReviewMode;
export type TaskImage = RuntimeTaskImage;

export const DEFAULT_TASK_AUTO_REVIEW_MODE: TaskAutoReviewMode = "move_to_trash";

export function resolveTaskAutoReviewMode(mode: TaskAutoReviewMode | null | undefined): TaskAutoReviewMode {
	if (mode === "commit" || mode === "pr" || mode === "move_to_trash") {
		return mode;
	}
	return DEFAULT_TASK_AUTO_REVIEW_MODE;
}

export function getTaskAutoReviewCancelButtonLabel(mode: TaskAutoReviewMode | null | undefined): string {
	switch (resolveTaskAutoReviewMode(mode)) {
		case "commit":
			return "Cancel Auto-commit";
		case "pr":
			return "Cancel Auto-PR";
		case "move_to_trash":
			return "Cancel Auto-trash";
	}
}

export interface BoardCard {
	id: string;
	title: string | null;
	prompt: string;
	startInPlanMode: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	baseRef: string;
	baseRefPinned?: boolean;
	useWorktree?: boolean;
	workingDirectory?: string | null;
	branch?: string | null;
	pinned?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
}

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
}

export interface ReviewTaskWorktreeSnapshot {
	taskId: string;
	path: string;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
	hasUnmergedChanges: boolean | null;
	behindBaseCount: number | null;
	conflictState: RuntimeConflictState | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
