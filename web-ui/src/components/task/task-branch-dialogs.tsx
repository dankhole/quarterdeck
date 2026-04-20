import {
	CheckoutConfirmationDialog,
	CreateBranchDialog,
	DeleteBranchDialog,
	MergeBranchDialog,
} from "@/components/git/panels";
import type { UseBranchActionsResult } from "@/hooks/git/use-branch-actions";

interface TaskBranchDialogsProps {
	taskBranchActions: UseBranchActionsResult;
	currentProjectId: string | null;
	onSkipTaskCheckoutConfirmationChange?: (skip: boolean) => void;
}

export function TaskBranchDialogs({
	taskBranchActions,
	currentProjectId,
	onSkipTaskCheckoutConfirmationChange,
}: TaskBranchDialogsProps): React.ReactElement {
	return (
		<>
			<CheckoutConfirmationDialog
				state={taskBranchActions.checkoutDialogState}
				onClose={taskBranchActions.closeCheckoutDialog}
				onConfirmCheckout={taskBranchActions.handleConfirmCheckout}
				onSkipTaskConfirmationChange={onSkipTaskCheckoutConfirmationChange}
				onStashAndCheckout={taskBranchActions.handleStashAndCheckout}
				isStashingAndCheckingOut={taskBranchActions.isStashingAndCheckingOut}
			/>
			<CreateBranchDialog
				state={taskBranchActions.createBranchDialogState}
				projectId={currentProjectId}
				onClose={taskBranchActions.closeCreateBranchDialog}
				onBranchCreated={taskBranchActions.handleBranchCreated}
			/>
			<DeleteBranchDialog
				open={taskBranchActions.deleteBranchDialogState.type === "open"}
				branchName={
					taskBranchActions.deleteBranchDialogState.type === "open"
						? (taskBranchActions.deleteBranchDialogState.branchName ?? "")
						: ""
				}
				onCancel={taskBranchActions.closeDeleteBranchDialog}
				onConfirm={taskBranchActions.handleConfirmDeleteBranch}
			/>
			<MergeBranchDialog
				open={taskBranchActions.mergeBranchDialogState.type === "open"}
				branchName={
					taskBranchActions.mergeBranchDialogState.type === "open"
						? (taskBranchActions.mergeBranchDialogState.branchName ?? "")
						: ""
				}
				currentBranch={taskBranchActions.currentBranch ?? "current branch"}
				onCancel={taskBranchActions.closeMergeBranchDialog}
				onConfirm={taskBranchActions.handleConfirmMergeBranch}
			/>
		</>
	);
}
