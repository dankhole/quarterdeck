import type { RuntimeBoardColumnId, RuntimeConflictState, RuntimeTaskImage } from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;

export type TaskImage = RuntimeTaskImage;

export interface BoardCard {
	id: string;
	title: string | null;
	prompt: string;
	startInPlanMode: boolean;
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
