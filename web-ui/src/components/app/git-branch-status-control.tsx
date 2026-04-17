import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { TruncateTooltip } from "@/components/ui/tooltip";

export function GitBranchStatusControl({
	branchLabel,
	changedFiles,
	additions,
	deletions,
	onToggleGitHistory,
	isGitHistoryOpen,
}: {
	branchLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
	onToggleGitHistory?: () => void;
	isGitHistoryOpen?: boolean;
}): React.ReactElement {
	if (onToggleGitHistory) {
		return (
			<div className="flex items-center min-w-0 overflow-hidden">
				<Button
					variant={isGitHistoryOpen ? "primary" : "default"}
					size="sm"
					icon={<GitBranch size={12} />}
					onClick={onToggleGitHistory}
					className={cn(
						"font-mono text-xs shrink min-w-0 max-w-full overflow-hidden",
						isGitHistoryOpen ? "ring-1 ring-accent" : "kb-navbar-btn",
					)}
				>
					<TruncateTooltip content={branchLabel} side="bottom">
						<span className="truncate w-full text-left">{branchLabel}</span>
					</TruncateTooltip>
				</Button>
				<span className="font-mono text-xs text-text-tertiary ml-1.5 shrink-0 whitespace-nowrap">
					({changedFiles} {changedFiles === 1 ? "file" : "files"}
					<span className="text-status-green"> +{additions}</span>
					<span className="text-status-red"> -{deletions}</span>)
				</span>
			</div>
		);
	}

	return (
		<span className="font-mono text-xs text-text-secondary mr-1 whitespace-nowrap">
			<GitBranch size={12} className="inline-block mr-1" style={{ verticalAlign: -1 }} />
			<span className="text-text-primary">{branchLabel}</span>
			<span className="ml-1.5">
				<span className="text-text-tertiary">
					({changedFiles} {changedFiles === 1 ? "file" : "files"}
				</span>
				<span className="text-status-green"> +{additions}</span>
				<span className="text-status-red"> -{deletions}</span>
				<span className="text-text-tertiary">)</span>
			</span>
		</span>
	);
}
