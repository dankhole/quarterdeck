import { useCallback, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import {
	commentKey,
	type DiffLineComment,
	formatCommentsForTerminal,
} from "@/components/detail-panels/diff-viewer-utils";

export interface UseDiffCommentsOptions {
	comments: Map<string, DiffLineComment>;
	onCommentsChange: (comments: Map<string, DiffLineComment>) => void;
	onAddToTerminal?: (formatted: string) => void;
	onSendToTerminal?: (formatted: string) => void;
}

export interface UseDiffCommentsResult {
	handleAddComment: (
		filePath: string,
		lineNumber: number,
		lineText: string,
		variant: "added" | "removed" | "context",
	) => void;
	handleUpdateComment: (
		filePath: string,
		lineNumber: number,
		variant: "added" | "removed" | "context",
		text: string,
	) => void;
	handleDeleteComment: (filePath: string, lineNumber: number, variant: "added" | "removed" | "context") => void;
	handleAddComments: () => void;
	handleSendComments: () => void;
	handleClearAllComments: () => void;
	hasAnyComments: boolean;
	nonEmptyCount: number;
}

export function useDiffComments({
	comments,
	onCommentsChange,
	onAddToTerminal,
	onSendToTerminal,
}: UseDiffCommentsOptions): UseDiffCommentsResult {
	const handleAddComment = useCallback(
		(filePath: string, lineNumber: number, lineText: string, variant: "added" | "removed" | "context") => {
			const key = commentKey(filePath, lineNumber, variant);
			if (comments.has(key)) {
				return;
			}
			const next = new Map(comments);
			// Remove any existing empty comment boxes before opening a new one
			for (const [existingKey, existingComment] of next) {
				if (existingComment.comment.trim() === "") {
					next.delete(existingKey);
				}
			}
			next.set(key, {
				filePath,
				lineNumber,
				lineText,
				variant,
				comment: "",
			});
			onCommentsChange(next);
		},
		[comments, onCommentsChange],
	);

	const handleUpdateComment = useCallback(
		(filePath: string, lineNumber: number, variant: "added" | "removed" | "context", text: string) => {
			const key = commentKey(filePath, lineNumber, variant);
			const existing = comments.get(key);
			if (!existing) {
				return;
			}
			const next = new Map(comments);
			next.set(key, { ...existing, comment: text });
			onCommentsChange(next);
		},
		[comments, onCommentsChange],
	);

	const handleDeleteComment = useCallback(
		(filePath: string, lineNumber: number, variant: "added" | "removed" | "context") => {
			const next = new Map(comments);
			next.delete(commentKey(filePath, lineNumber, variant));
			onCommentsChange(next);
		},
		[comments, onCommentsChange],
	);

	const nonEmptyComments = useMemo(() => {
		return Array.from(comments.values()).filter((c) => c.comment.trim().length > 0);
	}, [comments]);

	const buildFormattedComments = useCallback((): string | null => {
		if (nonEmptyComments.length === 0) {
			return null;
		}
		const sorted = [...nonEmptyComments].sort((a, b) => {
			const pathCmp = a.filePath.localeCompare(b.filePath);
			if (pathCmp !== 0) {
				return pathCmp;
			}
			return a.lineNumber - b.lineNumber;
		});
		return formatCommentsForTerminal(sorted);
	}, [nonEmptyComments]);

	const handleAddComments = useCallback(() => {
		const formatted = buildFormattedComments();
		if (!formatted || !onAddToTerminal) {
			return;
		}
		onAddToTerminal(formatted);
		onCommentsChange(new Map());
	}, [buildFormattedComments, onAddToTerminal, onCommentsChange]);

	const handleSendComments = useCallback(() => {
		const formatted = buildFormattedComments();
		if (!formatted || !onSendToTerminal) {
			return;
		}
		onSendToTerminal(formatted);
		onCommentsChange(new Map());
	}, [buildFormattedComments, onCommentsChange, onSendToTerminal]);

	const handleClearAllComments = useCallback(() => {
		onCommentsChange(new Map());
	}, [onCommentsChange]);

	const nonEmptyCount = nonEmptyComments.length;

	useHotkeys(
		"meta+enter,ctrl+enter",
		(event) => {
			if (!onAddToTerminal || nonEmptyCount === 0) {
				return;
			}
			event.preventDefault();
			handleAddComments();
		},
		{
			enabled: Boolean(onAddToTerminal),
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => event.defaultPrevented,
			preventDefault: true,
		},
		[handleAddComments, nonEmptyCount, onAddToTerminal],
	);

	useHotkeys(
		"meta+shift+enter,ctrl+shift+enter",
		(event) => {
			if (!onSendToTerminal || nonEmptyCount === 0) {
				return;
			}
			event.preventDefault();
			handleSendComments();
		},
		{
			enabled: Boolean(onSendToTerminal),
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => event.defaultPrevented,
			preventDefault: true,
		},
		[handleSendComments, nonEmptyCount, onSendToTerminal],
	);

	return {
		handleAddComment,
		handleUpdateComment,
		handleDeleteComment,
		handleAddComments,
		handleSendComments,
		handleClearAllComments,
		hasAnyComments: comments.size > 0,
		nonEmptyCount,
	};
}
