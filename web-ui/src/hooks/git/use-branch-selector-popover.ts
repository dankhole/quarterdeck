import { useCallback, useMemo, useRef, useState } from "react";
import { resolveBranchSelectorSections } from "@/hooks/git/branch-selector-popover";
import type { RuntimeGitRef } from "@/runtime/types";

interface UseBranchSelectorPopoverInput {
	branches: RuntimeGitRef[] | null;
	pinnedBranches?: string[];
	onOpenChange: (open: boolean) => void;
	onSelectBranchView: (ref: string) => void;
	onCheckoutBranch?: (branch: string) => void;
	onCompareWithBranch?: (branchName: string) => void;
	onMergeBranch?: (branchName: string) => void;
	onCreateBranch?: (sourceRef: string) => void;
	onDeleteBranch?: (branchName: string) => void;
	onRebaseBranch?: (onto: string) => void;
	onRenameBranch?: (branchName: string) => void;
	onResetToRef?: (ref: string) => void;
	onPull?: (branch: string) => void;
	onPush?: (branch: string) => void;
}

export function useBranchSelectorPopover({
	branches,
	pinnedBranches,
	onOpenChange,
	onSelectBranchView,
	onCheckoutBranch,
	onCompareWithBranch,
	onMergeBranch,
	onCreateBranch,
	onDeleteBranch,
	onRebaseBranch,
	onRenameBranch,
	onResetToRef,
	onPull,
	onPush,
}: UseBranchSelectorPopoverInput) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const sections = useMemo(
		() => resolveBranchSelectorSections(branches, pinnedBranches, query),
		[branches, pinnedBranches, query],
	);

	const resetQuery = useCallback(() => {
		setQuery("");
	}, []);

	const closePopover = useCallback(() => {
		onOpenChange(false);
		resetQuery();
	}, [onOpenChange, resetQuery]);

	const runBranchAction = useCallback(
		(callback?: (value: string) => void) => {
			return (value: string) => {
				callback?.(value);
				onOpenChange(false);
				resetQuery();
			};
		},
		[onOpenChange, resetQuery],
	);

	const handleOpenChange = useCallback(
		(open: boolean) => {
			onOpenChange(open);
			if (!open) {
				resetQuery();
			}
		},
		[onOpenChange, resetQuery],
	);

	const handleSelectBranch = useMemo(() => runBranchAction(onSelectBranchView), [onSelectBranchView, runBranchAction]);
	const handleCheckout = useMemo(() => runBranchAction(onCheckoutBranch), [onCheckoutBranch, runBranchAction]);
	const handleCompare = useMemo(() => runBranchAction(onCompareWithBranch), [onCompareWithBranch, runBranchAction]);
	const handleMerge = useMemo(() => runBranchAction(onMergeBranch), [onMergeBranch, runBranchAction]);
	const handleCreateBranch = useMemo(() => runBranchAction(onCreateBranch), [onCreateBranch, runBranchAction]);
	const handleDeleteBranch = useMemo(() => runBranchAction(onDeleteBranch), [onDeleteBranch, runBranchAction]);
	const handleRebase = useMemo(() => runBranchAction(onRebaseBranch), [onRebaseBranch, runBranchAction]);
	const handleRename = useMemo(() => runBranchAction(onRenameBranch), [onRenameBranch, runBranchAction]);
	const handleReset = useMemo(() => runBranchAction(onResetToRef), [onResetToRef, runBranchAction]);
	const handlePull = useMemo(() => runBranchAction(onPull), [onPull, runBranchAction]);
	const handlePush = useMemo(() => runBranchAction(onPush), [onPush, runBranchAction]);

	return {
		query,
		setQuery,
		inputRef,
		closePopover,
		handleOpenChange,
		handleSelectBranch,
		handleCheckout,
		handleCompare,
		handleMerge,
		handleCreateBranch,
		handleDeleteBranch,
		handleRebase,
		handleRename,
		handleReset,
		handlePull,
		handlePush,
		...sections,
	};
}
