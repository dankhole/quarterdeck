import { ArrowRight, GitMerge } from "lucide-react";

import { useConflictState, useHomeConflictState } from "@/stores/project-metadata-store";

export function ConflictBanner({
	taskId,
	onNavigateToResolver,
}: {
	taskId: string | null;
	onNavigateToResolver: () => void;
}): React.ReactElement | null {
	const taskConflictState = useConflictState(taskId);
	const homeConflictState = useHomeConflictState();
	const conflictState = taskId ? taskConflictState : homeConflictState;

	const remainingCount = conflictState?.conflictedFiles.length ?? 0;

	// Hide when no conflict, or when all conflicts are resolved (user just needs to click "Complete")
	if (!conflictState || remainingCount === 0) {
		return null;
	}

	return (
		<button
			type="button"
			onClick={onNavigateToResolver}
			className="flex items-center gap-2 w-full px-3 py-1.5 bg-status-orange/10 border-0 border-b border-border cursor-pointer hover:bg-status-orange/15 transition-colors shrink-0"
		>
			<GitMerge size={14} className="text-status-orange shrink-0" />
			<span className="text-[12px] text-text-primary font-medium">
				{conflictState.operation === "merge" ? "Merge" : "Rebase"} in progress
			</span>
			<span className="text-[12px] text-text-secondary">
				&mdash; {remainingCount} {remainingCount === 1 ? "conflict" : "conflicts"} remaining
			</span>
			<span className="flex items-center gap-1 ml-auto text-[11px] text-accent font-medium">
				Resolve <ArrowRight size={11} />
			</span>
		</button>
	);
}
