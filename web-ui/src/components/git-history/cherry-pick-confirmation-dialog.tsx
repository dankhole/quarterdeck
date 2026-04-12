import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import { GitCommitHorizontal } from "lucide-react";
import { useCallback, useRef } from "react";
import { AlertDialog, AlertDialogBody, AlertDialogFooter, AlertDialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export type CherryPickDialogState =
	| { type: "closed" }
	| {
			type: "confirm";
			commitHash: string;
			shortHash: string;
			commitMessage: string;
			targetBranch: string;
	  };

interface CherryPickConfirmationDialogProps {
	state: CherryPickDialogState;
	isLoading: boolean;
	onClose: () => void;
	onConfirm: (commitHash: string, targetBranch: string) => void;
}

export function CherryPickConfirmationDialog({
	state,
	isLoading,
	onClose,
	onConfirm,
}: CherryPickConfirmationDialogProps): React.ReactElement | null {
	// Radix AlertDialog onOpenChange gotcha: Action triggers onOpenChange(false) synchronously
	// after onClick, before React re-renders with isLoading=true. The ref guards the cancel
	// path so the dialog stays open during the async operation. See AGENTS.md.
	const confirmFiredRef = useRef(false);

	const handleConfirm = useCallback(() => {
		if (state.type !== "confirm") {
			return;
		}
		confirmFiredRef.current = true;
		onConfirm(state.commitHash, state.targetBranch);
	}, [state, onConfirm]);

	const handleCancel = useCallback(() => {
		if (confirmFiredRef.current) {
			return;
		}
		if (!isLoading) {
			onClose();
		}
	}, [isLoading, onClose]);

	if (state.type === "closed") {
		return null;
	}

	return (
		<AlertDialog open onOpenChange={handleCancel}>
			<AlertDialogHeader>
				<div className="flex items-center gap-2 text-sm font-medium text-text-primary">
					<GitCommitHorizontal size={16} className="text-accent" />
					Land commit on branch
				</div>
			</AlertDialogHeader>
			<AlertDialogBody>
				<p className="text-xs text-text-secondary">
					This will cherry-pick the following commit onto{" "}
					<code className="bg-surface-2 px-1 py-0.5 rounded">{state.targetBranch}</code>:
				</p>
				<div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-xs">
					<div className="flex items-center gap-2">
						<code className="font-mono text-text-tertiary">{state.shortHash}</code>
						<span className="text-text-primary">{state.commitMessage}</span>
					</div>
				</div>
				<p className="mt-2 text-xs text-text-tertiary">
					A new commit with the same changes will be created on the target branch. If there are conflicts, the
					operation will be aborted and no changes will be made.
				</p>
			</AlertDialogBody>
			<AlertDialogFooter>
				<RadixAlertDialog.Cancel asChild>
					<button
						type="button"
						onClick={handleCancel}
						disabled={isLoading}
						className="px-3 py-1.5 text-xs rounded-md bg-surface-3 text-text-secondary hover:bg-surface-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Cancel
					</button>
				</RadixAlertDialog.Cancel>
				<RadixAlertDialog.Action asChild>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={isLoading}
						className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
					>
						{isLoading ? (
							<>
								<Spinner size={12} />
								Landing...
							</>
						) : (
							"Land commit"
						)}
					</button>
				</RadixAlertDialog.Action>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
