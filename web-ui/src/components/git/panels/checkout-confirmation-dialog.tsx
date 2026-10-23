import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import { AlertTriangle, GitBranch, Info } from "lucide-react";
import { useCallback } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogBody, AlertDialogFooter, AlertDialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export type CheckoutDialogState =
	| { type: "closed" }
	| { type: "confirm"; branch: string; scope: "home" | "task"; taskId?: string; baseRef?: string }
	| { type: "blocked"; branch: string; taskTitle: string }
	| { type: "dirty_warning"; branch: string; scope: "home" | "task"; taskId?: string; baseRef?: string };

interface CheckoutConfirmationDialogProps {
	state: CheckoutDialogState;
	onClose: () => void;
	onConfirmCheckout: (branch: string, scope: "home" | "task", taskId?: string, baseRef?: string) => void;
	onNavigateToTask?: (taskTitle: string) => void;
	onStashAndCheckout?: () => void;
	isStashingAndCheckingOut?: boolean;
}

export function CheckoutConfirmationDialog({
	state,
	onClose,
	onConfirmCheckout,
	onNavigateToTask,
	onStashAndCheckout,
	isStashingAndCheckingOut,
}: CheckoutConfirmationDialogProps): React.ReactElement | null {
	// Safe from Radix onOpenChange double-fire: onConfirmCheckout runs synchronously before handleCancel fires.
	const handleConfirm = useCallback(() => {
		if (state.type === "confirm" || state.type === "dirty_warning") {
			onConfirmCheckout(state.branch, state.scope, state.taskId, state.baseRef);
		}
		onClose();
	}, [state, onConfirmCheckout, onClose]);

	const handleCancel = useCallback(() => {
		onClose();
	}, [onClose]);

	if (state.type === "closed") {
		return null;
	}

	// Branch is locked by another worktree
	if (state.type === "blocked") {
		return (
			<AlertDialog open onOpenChange={handleCancel}>
				<AlertDialogHeader>
					<div className="flex items-center gap-2 text-sm font-medium text-text-primary">
						<Info size={16} className="text-status-blue" />
						Branch in use
					</div>
				</AlertDialogHeader>
				<AlertDialogBody>
					<p>
						<code className="text-xs bg-surface-2 px-1 py-0.5 rounded">{state.branch}</code> is checked out by{" "}
						<strong>Task: {state.taskTitle}</strong>.
					</p>
					<p className="text-text-tertiary text-xs">
						Git does not allow the same branch to be checked out in multiple worktrees.
					</p>
				</AlertDialogBody>
				<AlertDialogFooter>
					{onNavigateToTask ? (
						<RadixAlertDialog.Action asChild>
							<Button
								variant="primary"
								size="sm"
								onClick={() => {
									onNavigateToTask(state.taskTitle);
									onClose();
								}}
							>
								Go to task
							</Button>
						</RadixAlertDialog.Action>
					) : null}
					<RadixAlertDialog.Cancel asChild>
						<Button variant="default" size="sm" onClick={handleCancel}>
							Close
						</Button>
					</RadixAlertDialog.Cancel>
				</AlertDialogFooter>
			</AlertDialog>
		);
	}

	// Dirty working tree warning
	if (state.type === "dirty_warning") {
		return (
			<AlertDialog open onOpenChange={handleCancel}>
				<AlertDialogHeader>
					<div className="flex items-center gap-2 text-sm font-medium text-text-primary">
						<AlertTriangle size={16} className="text-status-orange" />
						Uncommitted changes
					</div>
				</AlertDialogHeader>
				<AlertDialogBody>
					<p>
						You have uncommitted changes that may conflict with checking out{" "}
						<code className="text-xs bg-surface-2 px-1 py-0.5 rounded">{state.branch}</code>.
					</p>
					<p className="text-text-tertiary text-xs">Proceeding may cause merge conflicts or lost changes.</p>
				</AlertDialogBody>
				<AlertDialogFooter>
					<RadixAlertDialog.Cancel asChild>
						<Button variant="default" size="sm" onClick={handleCancel} disabled={isStashingAndCheckingOut}>
							Cancel
						</Button>
					</RadixAlertDialog.Cancel>
					{onStashAndCheckout ? (
						<Button variant="primary" size="sm" onClick={onStashAndCheckout} disabled={isStashingAndCheckingOut}>
							{isStashingAndCheckingOut ? <Spinner size={14} /> : null}
							Stash & Switch
						</Button>
					) : null}
					<RadixAlertDialog.Action asChild>
						<Button
							variant="primary"
							size="sm"
							className="bg-status-orange border-status-orange hover:bg-status-orange hover:opacity-90"
							onClick={handleConfirm}
							disabled={isStashingAndCheckingOut}
						>
							Proceed anyway
						</Button>
					</RadixAlertDialog.Action>
				</AlertDialogFooter>
			</AlertDialog>
		);
	}

	// Standard confirmation (confirm type)
	const isHome = state.scope === "home";
	const title = isHome ? "Switch home repository branch" : "Switch task worktree branch";
	const description = isHome
		? "This changes the branch checked out in the home repository."
		: "This changes the working directory for this task only.";

	return (
		<AlertDialog open onOpenChange={handleCancel}>
			<AlertDialogHeader>
				<div className="flex items-center gap-2 text-sm font-medium text-text-primary">
					<GitBranch size={16} className={isHome ? "text-text-secondary" : "text-accent"} />
					{title}
				</div>
			</AlertDialogHeader>
			<AlertDialogBody>
				<p>
					Switch to <code className="text-xs bg-surface-2 px-1 py-0.5 rounded">{state.branch}</code>?
				</p>
				<p className="text-text-tertiary text-xs">{description}</p>
			</AlertDialogBody>
			<AlertDialogFooter>
				<RadixAlertDialog.Cancel asChild>
					<Button variant="default" size="sm" onClick={handleCancel}>
						Cancel
					</Button>
				</RadixAlertDialog.Cancel>
				<RadixAlertDialog.Action asChild>
					<Button variant="primary" size="sm" onClick={handleConfirm}>
						Switch branch
					</Button>
				</RadixAlertDialog.Action>
			</AlertDialogFooter>
		</AlertDialog>
	);
}

/**
 * Determines what dialog state to show before a checkout attempt.
 * Keeps the dialog closed when the requested branch is already checked out.
 */
export function resolveCheckoutDialogState(options: {
	branch: string;
	scope: "home" | "task";
	currentBranch: string | null;
	dirtyWorkingTree: boolean;
	worktreeBranches: Map<string, string>;
	taskId?: string;
	baseRef?: string;
}): CheckoutDialogState {
	const { branch, scope, currentBranch, dirtyWorkingTree, worktreeBranches } = options;

	// Already on this branch
	if (currentBranch === branch) {
		showAppToast({ message: `Already on ${branch}` });
		return { type: "closed" };
	}

	// Branch locked by a worktree
	const lockedByTask = worktreeBranches.get(branch);
	if (lockedByTask) {
		return { type: "blocked", branch, taskTitle: lockedByTask };
	}

	// Dirty working tree
	if (dirtyWorkingTree) {
		return {
			type: "dirty_warning",
			branch,
			scope,
			taskId: options.taskId,
			baseRef: options.baseRef,
		};
	}

	return { type: "confirm", branch, scope, taskId: options.taskId, baseRef: options.baseRef };
}
