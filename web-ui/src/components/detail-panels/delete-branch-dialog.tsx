import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";

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
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Delete branch?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					This will delete the local branch{" "}
					<code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{branchName}</code>. If the branch
					has unmerged changes, git will refuse to delete it.
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={onConfirm}>
						Delete
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
