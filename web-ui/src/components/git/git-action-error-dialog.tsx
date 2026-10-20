import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getGitActionErrorPresentation } from "./git-action-error";

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
	const { summary, details } = getGitActionErrorPresentation(message, output);

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
				<AlertDialogDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">
					{summary}
				</AlertDialogDescription>
				{details ? (
					<details key={details} className="min-w-0">
						<summary className="cursor-pointer rounded-sm text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus">
							Show details
						</summary>
						<pre
							role="region"
							tabIndex={0}
							aria-label="Git command output"
							className="mt-2 max-h-[220px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-border-focus"
						>
							{details}
						</pre>
					</details>
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
