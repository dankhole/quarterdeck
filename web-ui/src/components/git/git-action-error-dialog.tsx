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
import { Spinner } from "@/components/ui/spinner";

export function GitActionErrorDialog({
	open,
	title,
	message,
	output,
	onClose,
	onStashAndRetry,
	isStashAndRetrying,
}: {
	open: boolean;
	title: string;
	message: string;
	output: string | null;
	onClose: () => void;
	onStashAndRetry?: () => void;
	isStashAndRetrying?: boolean;
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
				{onStashAndRetry ? (
					<Button variant="primary" size="sm" disabled={isStashAndRetrying} onClick={onStashAndRetry}>
						{isStashAndRetrying ? <Spinner size={14} /> : "Stash & Pull"}
					</Button>
				) : null}
				<AlertDialogAction asChild>
					<Button variant="default" disabled={isStashAndRetrying} onClick={onClose}>
						Close
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
