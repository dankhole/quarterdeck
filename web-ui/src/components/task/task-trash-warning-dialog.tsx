import type { ReactElement } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

export interface TaskTrashWarningViewModel {
	taskTitle: string;
	fileCount: number;
	worktreeInfo: RuntimeTaskRepositoryInfoResponse | null;
	isNonIsolated: boolean;
}

export function TaskTrashWarningDialog({
	open,
	warning,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	warning: TaskTrashWarningViewModel | null;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const hasChanges = (warning?.fileCount ?? 0) > 0;
	const title = warning?.isNonIsolated
		? "Trash task?"
		: hasChanges
			? "Trash task with uncommitted changes?"
			: "Trash task?";

	return (
		<ConfirmationDialog
			open={open}
			title={title}
			confirmLabel="Move to Trash"
			confirmVariant="danger"
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			{warning?.isNonIsolated ? (
				<>
					<AlertDialogDescription>
						{warning.taskTitle} has an active session in the shared project folder.
					</AlertDialogDescription>
					<p>Moving to Trash will stop this task's session. Restore the task to resume it.</p>
				</>
			) : hasChanges ? (
				<>
					<AlertDialogDescription>
						{warning
							? `${warning.taskTitle} has ${warning.fileCount} changed file(s).`
							: "This task has uncommitted changes."}
					</AlertDialogDescription>
					<p>
						Moving to Trash will stop this task's session and keep its worktree, including uncommitted work.
						Restore the task to resume it in the same worktree.
					</p>
					{warning?.worktreeInfo?.path ? (
						<pre className="overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
							{formatPathForDisplay(warning.worktreeInfo.path)}
						</pre>
					) : null}
				</>
			) : (
				<AlertDialogDescription>
					Moving {warning?.taskTitle ?? "this task"} to Trash will stop its session and keep its worktree. Restore
					the task to resume it.
				</AlertDialogDescription>
			)}
		</ConfirmationDialog>
	);
}
