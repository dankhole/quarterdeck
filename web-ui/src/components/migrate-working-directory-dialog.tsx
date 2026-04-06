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
import type { MigrateDirection } from "@/hooks/use-migrate-working-directory";

interface MigrateWorkingDirectoryDialogProps {
	open: boolean;
	direction: MigrateDirection;
	isMigrating: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

export function MigrateWorkingDirectoryDialog({
	open,
	direction,
	isMigrating,
	onCancel,
	onConfirm,
}: MigrateWorkingDirectoryDialogProps): ReactElement {
	const isIsolate = direction === "isolate";

	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen && !isMigrating) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{isIsolate ? "Isolate to worktree?" : "Move to main checkout?"}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					{isIsolate
						? "This will pause the session, create an isolated worktree, and move your uncommitted changes into it. The agent will start a fresh session — use /resume to find the previous conversation."
						: "This will pause the session and start a fresh agent session in your main checkout. Use /resume to find the previous conversation (there is a shortcut in the resume menu to show worktree conversations). Uncommitted changes will stay in the worktree for recovery — commit them first if you want to keep them."}
				</AlertDialogDescription>
				<p className="mt-2 text-[11px] text-text-tertiary">
					This feature is experimental and may behave unexpectedly. Open terminals may need to be reopened after
					migration.
				</p>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" disabled={isMigrating} onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="primary" disabled={isMigrating} onClick={onConfirm}>
						{isMigrating ? "Migrating..." : isIsolate ? "Isolate" : "Move"}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
