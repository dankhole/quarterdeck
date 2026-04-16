import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function ResetToRefDialog({
	open,
	targetRef,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	targetRef: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Reset to here?"
			confirmLabel="Reset"
			confirmVariant="danger"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				This will hard reset to{" "}
				<code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{targetRef}</code>. All commits after
				this point and any uncommitted changes will be permanently discarded.
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
