import { ArrowDown, ArrowUp, CircleArrowDown } from "lucide-react";
import type { ReactElement } from "react";
import { GitBranchStatusControl } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeGitSyncAction, RuntimeGitSyncSummary } from "@/runtime/types";

/** Branch status slot for the home context git view tab bar. */
export function HomeBranchStatus({
	homeGitSummary,
	isGitHistoryOpen,
	onToggleGitHistory,
	runningGitAction,
	onGitFetch,
	onGitPull,
	onGitPush,
}: {
	homeGitSummary: RuntimeGitSyncSummary;
	isGitHistoryOpen: boolean;
	onToggleGitHistory: () => void;
	runningGitAction: RuntimeGitSyncAction | null;
	onGitFetch: () => void;
	onGitPull: () => void;
	onGitPush: () => void;
}): ReactElement {
	const branchLabel = homeGitSummary.currentBranch ?? "detached HEAD";
	const pullCount = homeGitSummary.behindCount ?? 0;
	const pushCount = homeGitSummary.aheadCount ?? 0;
	const pullTooltip =
		pullCount > 0
			? `Pull ${pullCount} commit${pullCount === 1 ? "" : "s"} from upstream into your local branch.`
			: "Pull from upstream. Branch is already up to date.";
	const pushTooltip =
		pushCount > 0
			? `Push ${pushCount} local commit${pushCount === 1 ? "" : "s"} to upstream.`
			: "Push local commits to upstream. No local commits are pending.";

	return (
		<div className="flex items-center gap-1">
			<GitBranchStatusControl
				branchLabel={branchLabel}
				changedFiles={homeGitSummary.changedFiles ?? 0}
				additions={homeGitSummary.additions ?? 0}
				deletions={homeGitSummary.deletions ?? 0}
				onToggleGitHistory={onToggleGitHistory}
				isGitHistoryOpen={isGitHistoryOpen}
			/>
			<div className="flex gap-0">
				<Tooltip
					side="bottom"
					content="Fetch latest refs from upstream without changing your local branch or files."
				>
					<Button
						variant="ghost"
						size="sm"
						icon={runningGitAction === "fetch" ? <Spinner size={14} /> : <CircleArrowDown size={18} />}
						onClick={onGitFetch}
						disabled={runningGitAction === "fetch"}
						aria-label="Fetch from upstream"
					/>
				</Tooltip>
				<Tooltip side="bottom" content={pullTooltip}>
					<Button
						variant="ghost"
						size="sm"
						icon={runningGitAction === "pull" ? <Spinner size={14} /> : <ArrowDown size={14} />}
						onClick={onGitPull}
						disabled={runningGitAction === "pull"}
						aria-label="Pull from upstream"
					>
						<span className="text-text-tertiary">{pullCount}</span>
					</Button>
				</Tooltip>
				<Tooltip side="bottom" content={pushTooltip}>
					<Button
						variant="ghost"
						size="sm"
						icon={runningGitAction === "push" ? <Spinner size={14} /> : <ArrowUp size={14} />}
						onClick={onGitPush}
						disabled={runningGitAction === "push"}
						aria-label="Push to upstream"
					>
						<span className="text-text-tertiary">{pushCount}</span>
					</Button>
				</Tooltip>
			</div>
		</div>
	);
}
