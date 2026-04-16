import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function RebaseBranchDialog({
	open,
	onto,
	currentBranch,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	onto: string;
	currentBranch: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Rebase onto?"
			confirmLabel="Rebase"
			confirmVariant="primary"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				This will rebase <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{currentBranch}</code>{" "}
				onto <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{onto}</code>. This rewrites
				commit history. If there are conflicts you will be able to resolve them.
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
