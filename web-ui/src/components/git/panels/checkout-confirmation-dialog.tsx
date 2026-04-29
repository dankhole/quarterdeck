import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { AlertTriangle, Check, GitBranch, Info } from "lucide-react";
import { useCallback, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
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
	onSkipTaskConfirmationChange?: (skip: boolean) => void;
	onStashAndCheckout?: () => void;
	isStashingAndCheckingOut?: boolean;
}

export function CheckoutConfirmationDialog({
	state,
	onClose,
	onConfirmCheckout,
	onNavigateToTask,
	onSkipTaskConfirmationChange,
	onStashAndCheckout,
	isStashingAndCheckingOut,
}: CheckoutConfirmationDialogProps): React.ReactElement | null {
	const [dontShowAgain, setDontShowAgain] = useState(false);

	// Safe from Radix onOpenChange double-fire: onConfirmCheckout runs synchronously before handleCancel fires.
	const handleConfirm = useCallback(() => {
		if (state.type === "confirm" || state.type === "dirty_warning") {
			if (state.scope === "task" && dontShowAgain && onSkipTaskConfirmationChange) {
				onSkipTaskConfirmationChange(true);
			}
			onConfirmCheckout(state.branch, state.scope, state.taskId, state.baseRef);
		}
		onClose();
		setDontShowAgain(false);
	}, [state, dontShowAgain, onSkipTaskConfirmationChange, onConfirmCheckout, onClose]);

	const handleCancel = useCallback(() => {
		onClose();
		setDontShowAgain(false);
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
				{!isHome && onSkipTaskConfirmationChange ? (
					<label htmlFor="skip-checkout-confirm" className="flex items-center gap-2 mt-1 cursor-pointer">
						<RadixCheckbox.Root
							id="skip-checkout-confirm"
							checked={dontShowAgain}
							onCheckedChange={(checked) => setDontShowAgain(checked === true)}
							className={cn(
								"flex h-3.5 w-3.5 shrink-0 translate-y-px items-center justify-center rounded border",
								dontShowAgain ? "bg-accent border-accent" : "bg-surface-2 border-border-bright",
							)}
						>
							<RadixCheckbox.Indicator className="flex items-center justify-center">
								<Check size={10} className="block text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						<span className="text-xs text-text-tertiary">Don't show again</span>
					</label>
				) : null}
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
 * Returns "skip" if no dialog is needed (setting enabled or already on branch).
 */
export function resolveCheckoutDialogState(options: {
	branch: string;
	scope: "home" | "task";
	currentBranch: string | null;
	dirtyWorkingTree: boolean;
	worktreeBranches: Map<string, string>;
	skipTaskConfirmation: boolean;
	skipHomeConfirmation: boolean;
	taskId?: string;
	baseRef?: string;
}): CheckoutDialogState | "skip" {
	const {
		branch,
		scope,
		currentBranch,
		dirtyWorkingTree,
		worktreeBranches,
		skipTaskConfirmation,
		skipHomeConfirmation,
	} = options;

	// Already on this branch
	if (currentBranch === branch) {
		showAppToast({ message: `Already on ${branch}` });
		return "skip";
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

	// Check skip settings
	if (scope === "task" && skipTaskConfirmation) {
		return "skip";
	}
	if (scope === "home" && skipHomeConfirmation) {
		return "skip";
	}

	return { type: "confirm", branch, scope, taskId: options.taskId, baseRef: options.baseRef };
}
