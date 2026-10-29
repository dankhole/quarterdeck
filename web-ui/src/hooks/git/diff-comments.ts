import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";

export type CommentVariant = DiffLineComment["variant"];
export type CommentAddress = [filePath: string, lineNumber: number, variant: CommentVariant, draftKey?: string];

function hasAddress(comment: DiffLineComment, [filePath, lineNumber, variant]: CommentAddress): boolean {
	return comment.filePath === filePath && comment.lineNumber === lineNumber && comment.variant === variant;
}

/** Legacy address-only callers may mutate only an unambiguous draft. Production passes its exact map key. */
export function resolveDiffCommentKey(
	comments: ReadonlyMap<string, DiffLineComment>,
	address: CommentAddress,
): string | undefined {
	const exactKey = address[3];
	if (exactKey !== undefined) {
		const comment = comments.get(exactKey);
		return comment && hasAddress(comment, address) ? exactKey : undefined;
	}
	let match: string | undefined;
	for (const [key, comment] of comments) {
		if (!hasAddress(comment, address)) continue;
		if (match !== undefined) return undefined;
		match = key;
	}
	return match;
}

export function sortedNonEmptyComments(comments: ReadonlyMap<string, DiffLineComment>): DiffLineComment[] {
	return [...comments.values()]
		.filter((comment) => comment.comment.trim().length > 0)
		.sort(
			(a, b) =>
				a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber || a.variant.localeCompare(b.variant),
		);
}

export function addDiffComment(
	comments: Map<string, DiffLineComment>,
	filePath: string,
	lineNumber: number,
	lineText: string,
	variant: CommentVariant,
	anchorRevision: string | undefined,
	draftId: string,
): Map<string, DiffLineComment> {
	for (const [key, existing] of comments) {
		if (
			hasAddress(existing, [filePath, lineNumber, variant]) &&
			existing.lineText === lineText &&
			existing.anchorRevision === anchorRevision
		) {
			return changeDiffComment(comments, [filePath, lineNumber, variant, key], { editing: true });
		}
	}
	if (comments.has(draftId)) return comments;
	const next = new Map(comments);
	for (const [existingKey, comment] of next) {
		if (!comment.comment.trim()) next.delete(existingKey);
	}
	next.set(draftId, {
		filePath,
		lineNumber,
		lineText,
		variant,
		comment: "",
		editing: true,
		...(anchorRevision !== undefined ? { anchorRevision } : {}),
	});
	return next;
}

export function changeDiffComment(
	comments: Map<string, DiffLineComment>,
	address: CommentAddress,
	change: Partial<Pick<DiffLineComment, "comment" | "editing">>,
): Map<string, DiffLineComment> {
	const key = resolveDiffCommentKey(comments, address);
	const existing = key === undefined ? undefined : comments.get(key);
	if (!existing || key === undefined) return comments;
	return new Map(comments).set(key, { ...existing, ...change });
}

export function finishDiffComment(
	comments: Map<string, DiffLineComment>,
	address: CommentAddress,
	deleteEmpty: boolean,
): Map<string, DiffLineComment> {
	const key = resolveDiffCommentKey(comments, address);
	const existing = key === undefined ? undefined : comments.get(key);
	if (!existing || key === undefined) return comments;
	if (existing.comment.trim())
		return changeDiffComment(comments, [address[0], address[1], address[2], key], { editing: false });
	if (!deleteEmpty) return comments;
	const next = new Map(comments);
	next.delete(key);
	return next;
}
