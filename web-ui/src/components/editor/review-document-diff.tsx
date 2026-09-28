import { useMemo } from "react";
import { SplitDiff } from "@/components/git/panels/diff-split";
import { UnifiedDiff } from "@/components/git/panels/diff-unified";
import type { DiffCommentCallbacks, DiffLineComment, DiffViewMode } from "@/components/git/panels/diff-viewer-utils";
import { buildUnifiedDiffRows, parsePatchToRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import type { ReviewDocument } from "@/hooks/git/review-document";

export interface ReviewInteractions extends DiffCommentCallbacks {
	comments: Map<string, DiffLineComment>;
	agentContextSource?: string;
}

/** Owns patch versus full-content admission; a patch is never treated as a complete editable file. */
export function ReviewDocumentDiff({
	document,
	viewMode = "unified",
	interactions,
}: {
	document: ReviewDocument;
	viewMode?: DiffViewMode;
	interactions?: ReviewInteractions;
}): React.ReactElement {
	const { content, path } = document;
	const patch = content.kind === "patch" ? content.patch : null;
	const oldText = content.kind === "text" ? content.oldText : null;
	const newText = content.kind === "text" && !interactions ? content.newText : null;
	const rows = useMemo(() => {
		if (patch !== null) return parsePatchToRows(patch);
		if (newText !== null) return buildUnifiedDiffRows(oldText, newText);
		return null;
	}, [patch, oldText, newText]);
	return (
		<div data-review-document={document.key} data-readonly="true">
			{document.oldPath && document.newPath && document.oldPath !== document.newPath ? (
				<div className="px-3 py-2 text-xs text-text-tertiary">
					Renamed from <code>{document.oldPath}</code>
				</div>
			) : null}
			{content.kind === "binary" ? (
				<div className="p-3 text-xs text-text-tertiary">Binary file</div>
			) : content.kind === "loading" ? (
				<div role="status" className="p-3 text-xs text-text-tertiary">
					Loading diff…
				</div>
			) : content.kind === "unavailable" ? (
				<div role="status" className="p-3 text-xs text-text-tertiary">
					{content.message ?? "No textual diff available."}
				</div>
			) : content.kind === "text" && interactions ? (
				viewMode === "split" ? (
					<SplitDiff
						key={document.key}
						path={path}
						oldText={content.oldText}
						newText={content.newText}
						{...interactions}
					/>
				) : (
					<UnifiedDiff
						key={document.key}
						path={path}
						oldText={content.oldText}
						newText={content.newText}
						{...interactions}
					/>
				)
			) : rows?.length ? (
				<ReadOnlyUnifiedDiff key={document.key} path={path} rows={rows} />
			) : (
				<div className="p-3 text-xs text-text-tertiary">No textual diff available.</div>
			)}
		</div>
	);
}
