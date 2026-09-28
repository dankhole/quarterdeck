import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useRevertCommit } from "@/hooks/git/use-revert-commit";
import type { RuntimeGitCommit, RuntimeGitRef } from "@/runtime/types";

export function RevertCommitAction({
	projectId,
	taskScope,
	commit,
	headRef,
	onRefresh,
}: {
	projectId: string;
	taskScope: { taskId: string; baseRef: string } | null;
	commit: RuntimeGitCommit;
	headRef: RuntimeGitRef | null;
	onRefresh: () => void;
}): React.ReactElement {
	const { target, pending, error, open, close, confirm } = useRevertCommit({
		projectId,
		taskScope,
		commit,
		onRefresh,
	});
	const isMerge = commit.parentHashes.length > 1;
	return (
		<>
			<Button
				size="sm"
				icon={<Undo2 size={12} />}
				disabled={isMerge || !headRef || pending}
				title={
					isMerge
						? "Reverting merge commits requires a mainline choice and is not supported here."
						: !headRef
							? "Check out a branch before reverting."
							: "Undo this commit with a new commit on the checked-out branch"
				}
				onClick={() => open(headRef)}
			>
				Revert commit
			</Button>
			<Dialog
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) close();
				}}
			>
				<DialogHeader title="Revert commit" />
				<DialogBody>
					<p className="text-sm text-text-secondary">
						Create a new commit on <strong>{target?.name}</strong> that undoes <code>{commit.shortHash}</code>?
					</p>
					<p className="mt-2 text-sm text-text-primary">{commit.message}</p>
					<p className="mt-2 text-xs text-text-secondary">
						Existing history is preserved. Commit or stash working changes first. If conflicts occur, resolve them
						in Git, then complete or abort the revert.
					</p>
					{error && (
						<p role="alert" className="mt-2 text-sm text-status-red">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button disabled={pending} onClick={close}>
						Cancel
					</Button>
					<Button variant="primary" disabled={pending} onClick={() => void confirm()}>
						{pending ? "Reverting…" : "Create revert commit"}
					</Button>
				</DialogFooter>
			</Dialog>
		</>
	);
}
