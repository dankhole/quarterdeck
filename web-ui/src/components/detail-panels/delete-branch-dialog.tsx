import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function DeleteBranchDialog({
	open,
	branchName,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	branchName: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Delete branch?"
			confirmLabel="Delete"
			confirmVariant="danger"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				This will delete the local branch{" "}
				<code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{branchName}</code>. If the branch has
				unmerged changes, git will refuse to delete it.
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
