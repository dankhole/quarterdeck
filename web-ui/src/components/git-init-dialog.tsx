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
import { Spinner } from "@/components/ui/spinner";

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
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) {
					onCancel();
				}
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Initialize git repository?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription asChild>
					<div className="flex flex-col gap-3">
						<p>
							Quarterdeck requires git to manage workspaces for tasks. This folder is not a git repository yet.
						</p>
						{path ? <p className="font-mono text-xs text-text-secondary break-all">{path}</p> : null}
						<p>If you cancel, the project will not be added.</p>
					</div>
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" disabled={isInitializing} onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="primary" disabled={isInitializing} onClick={onConfirm}>
						{isInitializing ? (
							<>
								<Spinner size={14} />
								Initializing...
							</>
						) : (
							"Initialize git"
						)}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
