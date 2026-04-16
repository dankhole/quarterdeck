import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function ClearTrashDialog({
	open,
	taskCount,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	taskCount: number;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const taskLabel = taskCount === 1 ? "task" : "tasks";

	return (
		<ConfirmationDialog
			open={open}
			title="Clear trash permanently?"
			confirmLabel="Clear Trash"
			confirmVariant="danger"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			<AlertDialogDescription>
				This will permanently delete {taskCount} {taskLabel} from Trash.
			</AlertDialogDescription>
			<p className="text-text-primary">This action cannot be undone.</p>
		</ConfirmationDialog>
	);
}
