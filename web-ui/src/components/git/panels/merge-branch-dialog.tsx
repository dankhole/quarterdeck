import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function MergeBranchDialog({
	open,
	branchName,
	currentBranch,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	branchName: string;
	currentBranch: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Merge branch?"
			confirmLabel="Merge"
			confirmVariant="primary"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				This will merge <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{branchName}</code>{" "}
				into <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{currentBranch}</code>. If there
				are conflicts you will be able to resolve them.
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
