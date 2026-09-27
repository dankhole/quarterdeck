import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";

export function GitInitDialog({
	open,
	path,
	isInitializing,
	onCancel,
	onConfirm,
	onAddFolder,
}: {
	open: boolean;
	path: string | null;
	isInitializing: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	onAddFolder?: () => void;
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
					<p>
						This folder does not have its own Git repository. Initialize one here for Git history and isolated
						task worktrees. A parent folder’s repository will not be used.
					</p>
					{path ? <p className="font-mono text-xs text-text-secondary break-all">{path}</p> : null}
					<p>
						You can also add a folder project without Git. It has its own task board, and tasks run directly in
						the folder.
					</p>
					{onAddFolder ? (
						<Button disabled={isInitializing} onClick={onAddFolder}>
							Add without Git
						</Button>
					) : null}
				</div>
			</AlertDialogDescription>
		</ConfirmationDialog>
	);
}
