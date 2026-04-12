import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";

export function GitActionErrorDialog({
	open,
	title,
	message,
	output,
	onClose,
}: {
	open: boolean;
	title: string;
	message: string;
	output: string | null;
	onClose: () => void;
}): ReactElement {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) {
					onClose();
				}
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{title}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<p>{message}</p>
				{output ? (
					<pre className="max-h-[220px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
						{output}
					</pre>
				) : null}
			</AlertDialogBody>
			<AlertDialogFooter className="justify-end">
				<AlertDialogAction asChild>
					<Button variant="default" onClick={onClose}>
						Close
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
