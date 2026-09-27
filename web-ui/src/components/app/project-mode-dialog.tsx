import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { useProjectMode } from "@/hooks/project/use-project-mode";

export function ProjectModeDialog({
	mode,
	folderOnly,
}: {
	mode: ReturnType<typeof useProjectMode>;
	folderOnly: boolean;
}) {
	return (
		<AlertDialog
			open={mode.open}
			onOpenChange={(open) => {
				if (!open) mode.close();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{folderOnly ? "Enable Git" : "Use as folder project"}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					{mode.requiresInitialization
						? "This folder needs its own Git repository. Initialize one here to enable Git?"
						: folderOnly
							? "Enable branches, commits, and isolated task worktrees for this project. Your tasks and files will be kept."
							: "Keep this board and its tasks. New tasks will work directly in this folder, and Quarterdeck will stop using Git for this project. Child projects keep their own repositories. Existing files and Git history will be kept."}
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<Button disabled={mode.saving} onClick={mode.close}>
					Cancel
				</Button>
				<Button
					variant="primary"
					disabled={mode.saving}
					onClick={() => {
						void mode.confirm();
					}}
				>
					{mode.saving
						? "Saving…"
						: mode.requiresInitialization
							? "Initialize Git"
							: folderOnly
								? "Enable Git"
								: "Use as folder project"}
				</Button>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
