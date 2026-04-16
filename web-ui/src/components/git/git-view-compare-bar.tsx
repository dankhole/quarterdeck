import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { ArrowRight, Check, CornerDownLeft } from "lucide-react";
import { useState } from "react";

import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

export interface CompareBarProps {
	sourceRef: string | null;
	targetRef: string | null;
	isBrowsing: boolean;
	hasOverride: boolean;
	branches: RuntimeGitRef[] | null;
	worktreeBranches: Map<string, string>;
	includeUncommitted: boolean;
	threeDotDiff: boolean;
	onSourceRefChange: (ref: string) => void;
	onTargetRefChange: (ref: string) => void;
	onResetToDefaults: () => void;
	onIncludeUncommittedChange: (value: boolean) => void;
	onThreeDotDiffChange: (value: boolean) => void;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
}

export function CompareBar({
	sourceRef,
	targetRef,
	isBrowsing,
	hasOverride,
	branches,
	worktreeBranches,
	includeUncommitted,
	threeDotDiff,
	onSourceRefChange,
	onTargetRefChange,
	onResetToDefaults,
	onIncludeUncommittedChange,
	onThreeDotDiffChange,
	pinnedBranches,
	onTogglePinBranch,
}: CompareBarProps): React.ReactElement {
	const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);
	const [targetPopoverOpen, setTargetPopoverOpen] = useState(false);

	return (
		<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
			{isBrowsing && <span className="text-[11px] font-medium text-status-purple">Browsing</span>}

			<BranchSelectorPopover
				isOpen={sourcePopoverOpen}
				onOpenChange={setSourcePopoverOpen}
				branches={branches}
				currentBranch={sourceRef}
				worktreeBranches={worktreeBranches}
				pinnedBranches={pinnedBranches}
				onTogglePinBranch={onTogglePinBranch}
				disableContextMenu
				onSelectBranchView={(ref) => {
					onSourceRefChange(ref);
					setSourcePopoverOpen(false);
				}}
				trigger={<BranchPillTrigger label={sourceRef ?? "select branch"} />}
			/>

			<ArrowRight size={12} className="text-text-tertiary shrink-0" />

			<BranchSelectorPopover
				isOpen={targetPopoverOpen}
				onOpenChange={setTargetPopoverOpen}
				branches={branches}
				currentBranch={targetRef}
				worktreeBranches={worktreeBranches}
				pinnedBranches={pinnedBranches}
				onTogglePinBranch={onTogglePinBranch}
				disableContextMenu
				onSelectBranchView={(ref) => {
					onTargetRefChange(ref);
					setTargetPopoverOpen(false);
				}}
				trigger={<BranchPillTrigger label={targetRef ?? "select branch"} />}
			/>

			{hasOverride && (
				<Tooltip content="Return to context">
					<button
						type="button"
						onClick={onResetToDefaults}
						className="flex items-center justify-center w-6 h-6 rounded-md border-0 cursor-pointer bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2"
					>
						<CornerDownLeft size={13} />
					</button>
				</Tooltip>
			)}

			<label
				htmlFor="compare-three-dot-diff"
				className="flex items-center gap-1.5 ml-auto text-[12px] text-text-secondary cursor-pointer select-none"
			>
				<RadixCheckbox.Root
					id="compare-three-dot-diff"
					checked={threeDotDiff}
					onCheckedChange={(checked) => onThreeDotDiffChange(checked === true)}
					className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
				>
					<RadixCheckbox.Indicator>
						<Check size={10} className="text-white" />
					</RadixCheckbox.Indicator>
				</RadixCheckbox.Root>
				Only branch changes
			</label>

			<label
				htmlFor="compare-include-uncommitted"
				className="flex items-center gap-1.5 text-[12px] text-text-secondary cursor-pointer select-none"
			>
				<RadixCheckbox.Root
					id="compare-include-uncommitted"
					checked={includeUncommitted}
					onCheckedChange={(checked) => onIncludeUncommittedChange(checked === true)}
					className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
				>
					<RadixCheckbox.Indicator>
						<Check size={10} className="text-white" />
					</RadixCheckbox.Indicator>
				</RadixCheckbox.Root>
				Include uncommitted work
			</label>
		</div>
	);
}
