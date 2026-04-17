import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function GitInitDialog({
	open,
	path,
	isInitializing,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	path: string | null;
	isInitializing: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<ConfirmationDialog
			open={open}
			title="Initialize git repository?"
			confirmLabel={isInitializing ? "Initializing..." : "Initialize git"}
			confirmVariant="primary"
			onCancel={onCancel}
			onConfirm={onConfirm}
			isLoading={isInitializing}
		>
			<AlertDialogDescription asChild>
				<div className="flex flex-col gap-3">
					<p>Quarterdeck requires git to manage worktrees for tasks. This folder is not a git repository yet.</p>
					{path ? <p className="font-mono text-xs text-text-secondary break-all">{path}</p> : null}
					<p>If you cancel, the project will not be added.</p>
				</div>
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
