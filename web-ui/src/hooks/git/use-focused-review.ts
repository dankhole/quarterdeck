import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffViewMode } from "@/components/git/panels/diff-viewer-utils";
import { type ReviewHunk, reconcileReviewHunk, resolveReviewPath } from "./focused-review";

interface ReviewPosition {
	scopeKey: string;
	path: string | null;
	index: number;
	signature?: string;
}

export interface UseFocusedReviewResult {
	path: string | null;
	fileIndex: number;
	hunkIndex: number;
	hunk: ReviewHunk | null;
	hunks: readonly ReviewHunk[] | null;
	viewMode: DiffViewMode;
	setViewMode: (mode: DiffViewMode) => void;
	stepFile: (direction: -1 | 1) => void;
	stepHunk: (direction: -1 | 1) => void;
}

/** Selection is controlled by the caller; hunk and layout are local presentation state. */
export function useFocusedReview({
	paths,
	selectedPath,
	onSelectedPathChange,
	scopeKey,
	getHunks,
	initialViewMode = "unified",
}: {
	paths: readonly string[];
	selectedPath: string | null;
	onSelectedPathChange: (path: string) => void;
	scopeKey: string;
	/** Null means unknown/loading, not zero differences. */
	getHunks: (path: string) => readonly ReviewHunk[] | null;
	initialViewMode?: DiffViewMode;
}): UseFocusedReviewResult {
	const previousFile = useRef({ scopeKey, index: 0 });
	const path = resolveReviewPath(
		paths,
		selectedPath,
		previousFile.current.scopeKey === scopeKey ? previousFile.current.index : 0,
	);
	const fileIndex = path === null ? -1 : paths.indexOf(path);
	const hunks = useMemo(() => (path === null ? [] : getHunks(path)), [path, getHunks]);
	const [position, setPosition] = useState<ReviewPosition>({ scopeKey, path, index: 0 });
	const [viewMode, setViewMode] = useState(initialViewMode);
	const sameFile = position.scopeKey === scopeKey && position.path === path;
	const hunkIndex =
		hunks === null
			? -1
			: reconcileReviewHunk(hunks, sameFile ? position.index : 0, sameFile ? position.signature : undefined);
	const hunk = hunks?.[hunkIndex] ?? null;

	useEffect(() => {
		if (fileIndex >= 0) previousFile.current = { scopeKey, index: fileIndex };
		if (path !== null && path !== selectedPath) onSelectedPathChange(path);
	}, [fileIndex, scopeKey, path, selectedPath, onSelectedPathChange]);

	useEffect(() => {
		// Keep the last known content anchor while a refresh is pending.
		if (hunks === null || path === null) return;
		setPosition((previous) =>
			previous.scopeKey === scopeKey &&
			previous.path === path &&
			previous.index === Math.max(hunkIndex, 0) &&
			previous.signature === hunk?.signature
				? previous
				: { scopeKey, path, index: Math.max(hunkIndex, 0), signature: hunk?.signature },
		);
	}, [scopeKey, path, hunks, hunkIndex, hunk?.signature]);

	return {
		path,
		fileIndex,
		hunkIndex,
		hunk,
		hunks,
		viewMode,
		setViewMode,
		stepFile: (direction) => {
			const next = paths[fileIndex + direction];
			if (next !== undefined) onSelectedPathChange(next);
		},
		stepHunk: (direction) => {
			setPosition((previous) => {
				if (!hunks) return previous;
				const current = reconcileReviewHunk(
					hunks,
					previous.scopeKey === scopeKey && previous.path === path ? previous.index : 0,
					previous.scopeKey === scopeKey && previous.path === path ? previous.signature : undefined,
				);
				const index = current + direction;
				const next = hunks[index];
				return next ? { scopeKey, path, index, signature: next.signature } : previous;
			});
		},
	};
}
