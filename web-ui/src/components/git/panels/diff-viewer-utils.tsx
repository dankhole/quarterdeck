import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { buildUnifiedDiffRows, type UnifiedDiffRow } from "@/components/shared/diff-renderer";
import { Button } from "@/components/ui/button";
import { buildFileTree } from "@/utils/file-tree";

export interface FileDiffGroup {
	path: string;
	entries: Array<{
		id: string;
		isBinary: boolean;
		oldText: string | null;
		newText: string;
	}>;
	added: number;
	removed: number;
}

export interface DiffLineComment {
	filePath: string;
	lineNumber: number;
	lineText: string;
	variant: "added" | "removed" | "context";
	comment: string;
	/** Absent means editing for older callers and fixtures. */
	editing?: boolean;
	/** Exact original old/new snapshot identity, independent of refresh timestamps. */
	anchorRevision?: string;
}

export type DiffViewMode = "unified" | "split";

export function commentKey(filePath: string, lineNumber: number, variant: DiffLineComment["variant"]): string {
	return `${filePath}:${variant}:${lineNumber}`;
}

export function formatCommentsForTerminal(comments: DiffLineComment[]): string {
	const lines: string[] = [];
	for (const comment of comments) {
		lines.push(`${comment.filePath}:${comment.lineNumber} | ${comment.lineText}`);
		for (const commentLine of comment.comment.split("\n")) {
			lines.push(`> ${commentLine}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export function diffAnchorRevision(oldText: string | null | undefined, newText: string): string {
	return JSON.stringify([oldText ?? null, newText]);
}

export interface DiffAnchorLookup {
	readonly revision: string;
	readonly rows: UnifiedDiffRow[];
	readonly lineTextByAddress: ReadonlyMap<string, string>;
}

/** Exact snapshot identity and line index are built once from file contents, never from editor text. */
export function createDiffAnchorLookup(oldText: string | null | undefined, newText: string): DiffAnchorLookup {
	const rows = buildUnifiedDiffRows(oldText, newText);
	return {
		revision: diffAnchorRevision(oldText, newText),
		rows,
		lineTextByAddress: new Map(
			rows.flatMap((row) =>
				row.lineNumber == null ? [] : [[commentKey("", row.lineNumber, row.variant), row.text]],
			),
		),
	};
}

export function isCommentAnchorValid(comment: DiffLineComment, lookup: DiffAnchorLookup): boolean {
	return (
		(comment.anchorRevision === undefined || comment.anchorRevision === lookup.revision) &&
		lookup.lineTextByAddress.get(commentKey("", comment.lineNumber, comment.variant)) === comment.lineText
	);
}

export interface AnchoredDiffComment {
	draftKey: string;
	comment: DiffLineComment;
}

export function indexAnchoredComments(
	path: string,
	comments: ReadonlyMap<string, DiffLineComment>,
	lookup: DiffAnchorLookup,
): Map<string, AnchoredDiffComment> {
	const indexed = new Map<string, AnchoredDiffComment>();
	for (const [draftKey, comment] of comments) {
		if (comment.filePath === path && isCommentAnchorValid(comment, lookup)) {
			indexed.set(commentKey(path, comment.lineNumber, comment.variant), { draftKey, comment });
		}
	}
	return indexed;
}

export function flattenFilePathsForDisplay(paths: string[]): string[] {
	const tree = buildFileTree(paths);
	const ordered: string[] = [];

	function walk(nodes: ReturnType<typeof buildFileTree>): void {
		for (const node of nodes) {
			if (node.type === "file") {
				ordered.push(node.path);
				continue;
			}
			walk(node.children);
		}
	}

	walk(tree);
	return ordered;
}

export function getSectionTopWithinScrollContainer(container: HTMLElement, section: HTMLElement): number {
	const containerRect = container.getBoundingClientRect();
	const sectionRect = section.getBoundingClientRect();
	return container.scrollTop + sectionRect.top - (containerRect.top + container.clientTop);
}

export function getVisibleDiffGroupPaths({
	container,
	groupedByPath,
	sectionElements,
	overscanPx = 0,
}: {
	container: HTMLElement;
	groupedByPath: readonly FileDiffGroup[];
	sectionElements: Readonly<Record<string, HTMLElement | null>>;
	overscanPx?: number;
}): string[] {
	const containerRect = container.getBoundingClientRect();
	const viewportHeight = container.clientHeight || Math.max(0, containerRect.height);
	if (viewportHeight <= 0) {
		return [];
	}

	const visibleTop = containerRect.top - overscanPx;
	const visibleBottom = containerRect.top + viewportHeight + overscanPx;
	const visiblePaths: string[] = [];

	for (const group of groupedByPath) {
		const section = sectionElements[group.path];
		if (!section) {
			continue;
		}
		const sectionRect = section.getBoundingClientRect();
		if (sectionRect.bottom >= visibleTop && sectionRect.top <= visibleBottom) {
			visiblePaths.push(group.path);
		}
	}

	return visiblePaths;
}

export interface DiffCommentCallbacks {
	anchorLookup?: DiffAnchorLookup;
	onAddComment: (
		filePath: string,
		lineNumber: number,
		lineText: string,
		variant: "added" | "removed" | "context",
		anchorRevision?: string,
	) => void;
	onUpdateComment: (
		filePath: string,
		lineNumber: number,
		variant: "added" | "removed" | "context",
		text: string,
		draftKey?: string,
	) => void;
	onDeleteComment: (
		filePath: string,
		lineNumber: number,
		variant: "added" | "removed" | "context",
		draftKey?: string,
	) => void;
	onSaveComment?: (
		filePath: string,
		lineNumber: number,
		variant: DiffLineComment["variant"],
		draftKey?: string,
	) => void;
	onEditComment?: (
		filePath: string,
		lineNumber: number,
		variant: DiffLineComment["variant"],
		draftKey?: string,
	) => void;
	onCancelEditComment?: (
		filePath: string,
		lineNumber: number,
		variant: DiffLineComment["variant"],
		draftKey?: string,
	) => void;
}

export function DiffLineGutter({
	lineNumber,
	hasComment,
	canComment = true,
	onDeleteComment,
}: {
	lineNumber: number | null | undefined;
	hasComment: boolean;
	canComment?: boolean;
	onDeleteComment?: () => void;
}): React.ReactElement {
	return (
		<span className="kb-diff-line-number" style={{ color: "var(--color-text-tertiary)" }}>
			<span className="kb-diff-line-number-text">{lineNumber ?? ""}</span>
			{lineNumber != null && canComment ? (
				<span
					className="kb-diff-comment-gutter"
					onClick={
						hasComment
							? (event) => {
									event.stopPropagation();
									onDeleteComment?.();
								}
							: undefined
					}
					style={hasComment ? { cursor: "pointer" } : undefined}
				>
					<span className="kb-diff-gutter-icon-comment">
						<MessageSquare size={12} />
					</span>
					<span className="kb-diff-gutter-icon-delete">
						<X size={12} className="text-status-red" />
					</span>
				</span>
			) : null}
		</span>
	);
}

export function InlineComment({
	comment,
	onChange,
	onDelete,
	onSave,
	onEdit,
	onCancel,
}: {
	comment: DiffLineComment;
	onChange: (text: string) => void;
	onDelete: () => void;
	onSave?: () => void;
	onEdit?: () => void;
	onCancel?: () => void;
}): React.ReactElement {
	const textAreaRef = useRef<HTMLTextAreaElement>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const wasNonEmptyRef = useRef(comment.comment.trim().length > 0);
	const editing = comment.editing !== false;
	const wasEditingRef = useRef(editing);

	useEffect(() => {
		if (editing) textAreaRef.current?.focus();
		else {
			wasNonEmptyRef.current = true;
			if (wasEditingRef.current) editButtonRef.current?.focus();
		}
		wasEditingRef.current = editing;
	}, [editing]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(320, Math.max(72, textarea.scrollHeight))}px`;
	}, [comment.comment, editing]);

	const cancel = () => {
		if (!comment.comment.trim()) onDelete();
		else onCancel?.();
	};

	return (
		<div className="kb-diff-inline-comment" onClick={(event) => event.stopPropagation()}>
			{editing ? (
				<>
					<textarea
						ref={textAreaRef}
						aria-label={`Comment on ${comment.filePath}:${comment.lineNumber}`}
						name={`diff-comment-${comment.filePath}-${comment.variant}-${comment.lineNumber}`}
						value={comment.comment}
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.defaultPrevented || event.nativeEvent.isComposing) return;
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								cancel();
							} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
								event.preventDefault();
								event.stopPropagation();
								if (comment.comment.trim()) onSave?.();
							}
						}}
						placeholder="Add a comment..."
						rows={3}
						className="max-h-80 min-h-18 w-full resize-y rounded-md border border-border bg-surface-2 p-3 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<div className="mt-2 flex gap-2">
						<Button size="sm" onClick={onSave} disabled={!comment.comment.trim()}>
							{wasNonEmptyRef.current ? "Update comment" : "Add comment"}
						</Button>
						<Button size="sm" variant="ghost" onClick={cancel}>
							Cancel
						</Button>
					</div>
				</>
			) : (
				<div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
					<div className="mb-2 flex items-center gap-2 text-text-secondary">
						<span className="flex-1">Unsent</span>
						<Button ref={editButtonRef} size="sm" variant="ghost" onClick={onEdit}>
							Edit
						</Button>
						<Button size="sm" variant="ghost" onClick={onDelete}>
							Delete
						</Button>
					</div>
					<p className="whitespace-pre-wrap break-words text-text-primary">{comment.comment}</p>
				</div>
			)}
		</div>
	);
}
