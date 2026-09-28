import type { ReactElement } from "react";
import { SourceEditor } from "@/components/editor/source-editor";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { useSearchPreview } from "@/hooks/search/use-search-preview";

const ignoreChange = () => {};

export function SearchResultPreview({
	projectId,
	searchScope,
	path,
	line,
}: {
	projectId: string | null;
	searchScope: WorkdirSearchScope;
	path: string | null;
	line?: number;
}): ReactElement {
	const { content, isLoading, isError } = useSearchPreview(projectId, searchScope, path);
	const message = !path
		? "Highlight a result to preview"
		: isLoading
			? "Loading preview..."
			: isError
				? "Unable to load preview"
				: content?.binary
					? "Binary file — preview unavailable"
					: null;
	return (
		<section
			aria-label="Search result preview"
			className="flex min-w-0 shrink-0 md:flex-1 flex-col h-[30vh] md:h-[60vh] border-t md:border-t-0 md:border-l border-border bg-surface-1"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-text-secondary">
				<span className="min-w-0 flex-1 truncate font-mono" title={path ?? undefined}>
					{path ?? "Preview"}
					{line ? `:${line}` : ""}
				</span>
				<span className="shrink-0 text-text-tertiary">Read-only</span>
			</div>
			{message ? (
				<div role="status" className="flex flex-1 items-center justify-center p-4 text-sm text-text-tertiary">
					{message}
				</div>
			) : content && path ? (
				<>
					{content.truncated ? (
						<div className="px-3 py-1 text-xs text-status-orange">
							Preview truncated; matches beyond the loaded content cannot be shown.
						</div>
					) : null}
					<SourceEditor
						key={path}
						path={path}
						language={content.language}
						value={content.content}
						readOnly
						wordWrap={false}
						scrollToLine={line ?? 1}
						onChange={ignoreChange}
					/>
				</>
			) : null}
		</section>
	);
}
