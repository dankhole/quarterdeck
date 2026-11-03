import { useEffect, useState } from "react";
import { SourceEditor } from "@/components/editor/source-editor";
import { Spinner } from "@/components/ui/spinner";
import type { CodeNavigationLocation, RuntimeFileContentResponse } from "@/runtime/types";

export type CodeNavigationFileReader = (path: string) => Promise<RuntimeFileContentResponse | null>;

/** Reads only the selected result, without opening an editable workspace or saving anything. */
export function CodeNavigationPreview({
	location,
	readFile,
}: {
	location: CodeNavigationLocation;
	readFile: CodeNavigationFileReader;
}): React.ReactElement {
	const [preview, setPreview] = useState<{ path: string; content: RuntimeFileContentResponse | null } | null>(null);
	useEffect(() => {
		let current = true;
		setPreview(null);
		void readFile(location.path).then(
			(content) => {
				if (current) setPreview({ path: location.path, content });
			},
			() => {
				if (current) setPreview({ path: location.path, content: null });
			},
		);
		return () => {
			current = false;
		};
	}, [location.path, readFile]);
	const content = preview?.path === location.path ? preview.content : undefined;
	return (
		<div
			role="region"
			aria-label="Usage preview"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border sm:border-l sm:border-t-0"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-text-secondary">
				<span className="min-w-0 flex-1 truncate font-mono" title={location.path}>
					{location.path}
				</span>
				<span className="shrink-0 text-[10px] text-text-tertiary">Read-only · disk snapshot</span>
			</div>
			{content === undefined ? (
				<p role="status" className="flex items-center gap-2 p-3 text-text-secondary">
					<Spinner size={12} />
					Loading preview…
				</p>
			) : !content || content.binary || content.truncated ? (
				<p role="status" className="p-3 text-text-secondary">
					Preview unavailable. Open the result to inspect its source.
				</p>
			) : (
				<SourceEditor
					path={location.path}
					language=""
					value={content.content}
					readOnly
					wordWrap={false}
					scrollToRange={location.range}
					focusOnScrollToRange={false}
					onChange={() => {}}
				/>
			)}
		</div>
	);
}
