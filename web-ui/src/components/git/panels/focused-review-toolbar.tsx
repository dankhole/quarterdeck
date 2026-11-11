import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffLayoutSelector } from "./diff-layout-selector";
import type { DiffViewMode } from "./diff-viewer-utils";

export function FocusedReviewToolbar({
	path,
	fileIndex,
	fileCount,
	hunkIndex,
	hunkCount,
	hunkStatus,
	viewMode,
	onViewModeChange,
	onStepFile,
	onStepHunk,
}: {
	path: string | null;
	fileIndex: number;
	fileCount: number;
	hunkIndex: number;
	hunkCount: number | null;
	hunkStatus?: string;
	viewMode: DiffViewMode;
	onViewModeChange: (mode: DiffViewMode) => void;
	onStepFile: (direction: -1 | 1) => void;
	onStepHunk: (direction: -1 | 1) => void;
}): React.ReactElement {
	return (
		<div className="shrink-0 border-b border-border bg-surface-1 px-3 py-2">
			<nav aria-label="Review navigation" className="flex flex-wrap items-center gap-2">
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						icon={<ChevronLeft size={14} />}
						aria-label="Previous file"
						aria-keyshortcuts="Alt+ArrowLeft"
						title="Previous file (Alt+Left)"
						disabled={fileIndex <= 0}
						onClick={() => onStepFile(-1)}
					/>
					<span className="whitespace-nowrap text-xs text-text-secondary">
						File {fileIndex + 1} of {fileCount}
					</span>
					<Button
						size="sm"
						variant="ghost"
						icon={<ChevronRight size={14} />}
						aria-label="Next file"
						aria-keyshortcuts="Alt+ArrowRight"
						title="Next file (Alt+Right)"
						disabled={fileIndex < 0 || fileIndex >= fileCount - 1}
						onClick={() => onStepFile(1)}
					/>
				</div>
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						icon={<ChevronUp size={14} />}
						aria-label="Previous difference"
						aria-keyshortcuts="Alt+ArrowUp"
						title="Previous difference (Alt+Up)"
						disabled={hunkIndex <= 0}
						onClick={() => onStepHunk(-1)}
					/>
					<span className="whitespace-nowrap text-xs text-text-secondary" aria-live="polite">
						{hunkCount === null
							? (hunkStatus ?? "Differences pending")
							: `Difference ${hunkIndex + 1} of ${hunkCount}`}
					</span>
					<Button
						size="sm"
						variant="ghost"
						icon={<ChevronDown size={14} />}
						aria-label="Next difference"
						aria-keyshortcuts="Alt+ArrowDown"
						title="Next difference (Alt+Down)"
						disabled={hunkIndex < 0 || hunkCount === null || hunkIndex >= hunkCount - 1}
						onClick={() => onStepHunk(1)}
					/>
				</div>
				<div className="ml-auto">
					<DiffLayoutSelector viewMode={viewMode} onViewModeChange={onViewModeChange} />
				</div>
			</nav>
			<div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
				<span className="min-w-0 flex-1 truncate text-text-primary" title={path ?? undefined}>
					{path ?? "No file selected"}
				</span>
				<span
					className="shrink-0 text-text-tertiary"
					title="Read-only review. Comment drafts stay in the main window."
				>
					Read-only
				</span>
			</div>
		</div>
	);
}
