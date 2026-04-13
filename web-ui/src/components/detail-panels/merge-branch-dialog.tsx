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
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Merge branch?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					This will merge <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{branchName}</code>{" "}
					into <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{currentBranch}</code>. If
					there are conflicts you will be able to resolve them.
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="primary" onClick={onConfirm}>
						Merge
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
