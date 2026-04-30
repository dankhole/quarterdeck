import { clampBetween } from "@/resize/resize-persistence";

export const COMMIT_CONTROLS_DEFAULT_HEIGHT = 196;
export const COMMIT_CONTROLS_MIN_HEIGHT = 172;
export const COMMIT_CONTROLS_MAX_HEIGHT = 420;
export const COMMIT_CHANGES_LIST_MIN_HEIGHT = 112;

export interface CommitControlsResizeBounds {
	minHeight: number;
	maxHeight: number;
}

export function clampCommitControlsHeight(height: number, maxHeight = COMMIT_CONTROLS_MAX_HEIGHT): number {
	const boundedMaxHeight = Math.max(COMMIT_CONTROLS_MIN_HEIGHT, Math.min(COMMIT_CONTROLS_MAX_HEIGHT, maxHeight));
	return clampBetween(height, COMMIT_CONTROLS_MIN_HEIGHT, boundedMaxHeight, true);
}

export function getCommitControlsResizeBounds({
	startHeight,
	changesListHeight,
}: {
	startHeight: number;
	changesListHeight: number;
}): CommitControlsResizeBounds {
	const maxHeightFromChangesList = startHeight + Math.max(0, changesListHeight - COMMIT_CHANGES_LIST_MIN_HEIGHT);
	return {
		minHeight: COMMIT_CONTROLS_MIN_HEIGHT,
		maxHeight: Math.max(COMMIT_CONTROLS_MIN_HEIGHT, Math.min(COMMIT_CONTROLS_MAX_HEIGHT, maxHeightFromChangesList)),
	};
}

export function calculateCommitControlsDragHeight({
	startHeight,
	startPointerY,
	pointerY,
	bounds,
}: {
	startHeight: number;
	startPointerY: number;
	pointerY: number;
	bounds: CommitControlsResizeBounds;
}): number {
	return clampBetween(startHeight - (pointerY - startPointerY), bounds.minHeight, bounds.maxHeight, true);
}
