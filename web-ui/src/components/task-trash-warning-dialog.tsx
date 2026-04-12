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
import type { RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

export interface TaskTrashWarningViewModel {
	taskTitle: string;
	fileCount: number;
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse | null;
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
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>
					{warning?.isNonIsolated ? "Trash task?" : "Trash task with uncommitted changes?"}
				</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				{warning?.isNonIsolated ? (
					<>
						<AlertDialogDescription>
							{warning.taskTitle} has an active session in the shared home repo.
						</AlertDialogDescription>
						<p>
							Moving to Trash will stop this task's session. Uncommitted changes in the home repo will not be
							affected.
						</p>
					</>
				) : (
					<>
						<AlertDialogDescription>
							{warning
								? `${warning.taskTitle} has ${warning.fileCount} changed file(s).`
								: "This task has uncommitted changes."}
						</AlertDialogDescription>
						<p>
							Moving to Trash will delete this task's worktree. Uncommitted work will be captured in a patch file
							and can be recovered if you restore the task.
						</p>
						{warning?.workspaceInfo?.path ? (
							<pre className="overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
								{formatPathForDisplay(warning.workspaceInfo.path)}
							</pre>
						) : null}
						<p>The patch file is saved automatically — no action needed to preserve your work.</p>
					</>
				)}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={onConfirm}>
						{warning?.isNonIsolated ? "Move to Trash" : "Move to Trash Anyway"}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
