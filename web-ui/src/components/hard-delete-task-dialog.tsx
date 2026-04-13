import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function HardDeleteTaskDialog({
	open,
	taskTitle,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	taskTitle: string | null;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Delete task permanently?"
			confirmLabel="Delete Permanently"
			confirmVariant="danger"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				{taskTitle ? (
					<>
						This will permanently delete <strong>{taskTitle}</strong>.
					</>
				) : (
					"This will permanently delete this task."
				)}
			</AlertDialogDescription>
			<p className="text-text-primary">This action cannot be undone.</p>
		</ConfirmationDialog>
	);
}
