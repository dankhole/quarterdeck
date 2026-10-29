import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DiffLineComment, formatCommentsForTerminal } from "@/components/git/panels/diff-viewer-utils";
import { ReviewDrafts, type ReviewSendResult, reviewDrafts } from "@/state/review-drafts";
import {
	addDiffComment,
	type CommentAddress,
	type CommentVariant,
	changeDiffComment,
	finishDiffComment,
	resolveDiffCommentKey,
	sortedNonEmptyComments,
} from "./diff-comments";
import { useReviewDraft } from "./use-review-draft";

export interface UseDiffCommentsOptions {
	/** Production identity from useGitView. Omitted for standalone controlled viewers. */
	reviewDraftKey?: string;
	comments: Map<string, DiffLineComment>;
	onCommentsChange: (comments: Map<string, DiffLineComment>) => void;
	onSendToTerminal?: (formatted: string) => Promise<ReviewSendResult>;
}

export interface UseDiffCommentsResult {
	handleAddComment: (
		filePath: string,
		lineNumber: number,
		lineText: string,
		variant: CommentVariant,
		anchorRevision?: string,
	) => void;
	handleUpdateComment: (
		filePath: string,
		lineNumber: number,
		variant: CommentVariant,
		text: string,
		draftKey?: string,
	) => void;
	handleDeleteComment: (...address: CommentAddress) => void;
	handleSaveComment: (...address: CommentAddress) => void;
	handleEditComment: (...address: CommentAddress) => void;
	handleCancelEditComment: (...address: CommentAddress) => void;
	handleSendComments: () => Promise<void>;
	handleClearAllComments: () => void;
	hasAnyComments: boolean;
	nonEmptyCount: number;
	fileCount: number;
	formattedLength: number;
	isSending: boolean;
	sendError: string | null;
}

export function useDiffComments({
	reviewDraftKey,
	comments,
	onCommentsChange,
	onSendToTerminal,
}: UseDiffCommentsOptions): UseDiffCommentsResult {
	const [localStore] = useState(() => {
		const store = new ReviewDrafts();
		store.updateComments("local", () => comments);
		return store;
	});
	const store = reviewDraftKey === undefined ? localStore : reviewDrafts;
	const key = reviewDraftKey ?? "local";
	const draft = useReviewDraft(key, store);
	const lastControlledComments = useRef(comments);
	const dispatchScope = useMemo(() => ({ active: false }), [key, store, onSendToTerminal]);
	useLayoutEffect(() => {
		dispatchScope.active = true;
		return () => {
			dispatchScope.active = false;
		};
	}, [dispatchScope]);

	// Standalone viewers remain controlled. Scoped production viewers read their window owner directly.
	useLayoutEffect(() => {
		if (reviewDraftKey === undefined && comments !== lastControlledComments.current) {
			store.updateComments(key, () => comments);
		}
		lastControlledComments.current = comments;
	}, [comments, reviewDraftKey, store, key]);

	const updateComments = useCallback(
		(update: (previous: Map<string, DiffLineComment>) => Map<string, DiffLineComment>) => {
			store.updateComments(key, update);
			const next = store.get(key).comments;
			lastControlledComments.current = next;
			onCommentsChange(next);
		},
		[key, store, onCommentsChange],
	);

	const handleAddComment = useCallback(
		(filePath: string, lineNumber: number, lineText: string, variant: CommentVariant, anchorRevision?: string) => {
			updateComments((previous) =>
				addDiffComment(previous, filePath, lineNumber, lineText, variant, anchorRevision, crypto.randomUUID()),
			);
		},
		[updateComments],
	);
	const handleUpdateComment = useCallback(
		(filePath: string, lineNumber: number, variant: CommentVariant, text: string, draftKey?: string) => {
			updateComments((previous) =>
				changeDiffComment(previous, [filePath, lineNumber, variant, draftKey], { comment: text }),
			);
		},
		[updateComments],
	);
	const handleDeleteComment = useCallback(
		(...address: CommentAddress) => {
			updateComments((previous) => {
				const key = resolveDiffCommentKey(previous, address);
				if (key === undefined) return previous;
				const next = new Map(previous);
				next.delete(key);
				return next;
			});
		},
		[updateComments],
	);
	const handleSaveComment = useCallback(
		(...address: CommentAddress) => {
			updateComments((previous) => finishDiffComment(previous, address, false));
		},
		[updateComments],
	);
	const handleEditComment = useCallback(
		(...address: CommentAddress) => {
			updateComments((previous) => changeDiffComment(previous, address, { editing: true }));
		},
		[updateComments],
	);
	const handleCancelEditComment = useCallback(
		(...address: CommentAddress) => {
			updateComments((previous) => finishDiffComment(previous, address, true));
		},
		[updateComments],
	);
	const handleClearAllComments = useCallback(() => {
		updateComments(() => new Map());
	}, [updateComments]);
	const handleSendComments = useCallback(async () => {
		if (!dispatchScope.active || !onSendToTerminal) return;
		await store.send(key, (snapshot) => onSendToTerminal(formatCommentsForTerminal(snapshot)));
		// The callback is captured with its original scope, never the currently navigated scope.
		const next = store.get(key).comments;
		lastControlledComments.current = next;
		onCommentsChange(next);
	}, [key, store, onSendToTerminal, onCommentsChange, dispatchScope]);

	const nonEmptyComments = useMemo(() => sortedNonEmptyComments(draft.comments), [draft.comments]);
	const formattedLength = useMemo(() => formatCommentsForTerminal(nonEmptyComments).length, [nonEmptyComments]);
	return {
		handleAddComment,
		handleUpdateComment,
		handleDeleteComment,
		handleSaveComment,
		handleEditComment,
		handleCancelEditComment,
		handleSendComments,
		handleClearAllComments,
		hasAnyComments: draft.comments.size > 0,
		nonEmptyCount: nonEmptyComments.length,
		fileCount: new Set(nonEmptyComments.map((comment) => comment.filePath)).size,
		formattedLength,
		isSending: draft.isSending,
		sendError: draft.sendError,
	};
}
