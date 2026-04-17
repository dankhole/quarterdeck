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
import type { RuntimeProjectSummary } from "@/runtime/types";

export function ProjectNavigationRemovalDialog({
	pendingProjectRemoval,
	pendingProjectTaskCount,
	isProjectRemovalPending,
	onClearPendingProjectRemoval,
	onConfirmProjectRemoval,
}: {
	pendingProjectRemoval: RuntimeProjectSummary | null;
	pendingProjectTaskCount: number;
	isProjectRemovalPending: boolean;
	onClearPendingProjectRemoval: () => void;
	onConfirmProjectRemoval: () => Promise<void>;
}): React.ReactElement {
	return (
		<AlertDialog
			open={pendingProjectRemoval !== null}
			onOpenChange={(open) => {
				if (!open && !isProjectRemovalPending) {
					onClearPendingProjectRemoval();
				}
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Remove Project</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription asChild>
					<div className="flex flex-col gap-3">
						<p>{pendingProjectRemoval ? pendingProjectRemoval.name : "This project"}</p>
						<p className="text-text-primary">
							This will delete all project tasks ({pendingProjectTaskCount}), remove task worktrees, and stop any
							running processes for this project.
						</p>
						<p className="text-text-primary">This action cannot be undone.</p>
					</div>
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button
						variant="default"
						disabled={isProjectRemovalPending}
						onClick={() => {
							if (!isProjectRemovalPending) {
								onClearPendingProjectRemoval();
							}
						}}
					>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" disabled={isProjectRemovalPending} onClick={onConfirmProjectRemoval}>
						{isProjectRemovalPending ? (
							<>
								<Spinner size={14} />
								Removing...
							</>
						) : (
							"Remove Project"
						)}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
