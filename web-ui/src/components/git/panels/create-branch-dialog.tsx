import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toErrorMessage } from "@/utils/to-error-message";

export interface CreateBranchDialogState {
	type: "closed" | "open";
	sourceRef?: string;
}

interface CreateBranchDialogProps {
	state: CreateBranchDialogState;
	projectId: string | null;
	onClose: () => void;
	onBranchCreated?: (branchName: string) => void;
}

/**
 * Dialog for creating a new branch from a given ref (branch, tag, or commit).
 * Used from both the BranchSelectorPopover context menu and the GitRefsPanel.
 */
export function CreateBranchDialog({
	state,
	projectId,
	onClose,
	onBranchCreated,
}: CreateBranchDialogProps): React.ReactElement | null {
	const [branchName, setBranchName] = useState("");
	const [isCreating, setIsCreating] = useState(false);

	useEffect(() => {
		if (state.type === "open") {
			setBranchName("");
			setIsCreating(false);
		}
	}, [state.type]);

	const handleCreate = useCallback(async () => {
		const trimmedName = branchName.trim();
		if (!trimmedName || !state.sourceRef || !projectId) {
			return;
		}
		setIsCreating(true);
		try {
			const trpc = getRuntimeTrpcClient(projectId);
			const result = await trpc.project.createBranch.mutate({
				branchName: trimmedName,
				startRef: state.sourceRef,
			});
			if (result.ok) {
				showAppToast({ intent: "success", message: `Branch "${trimmedName}" created from ${state.sourceRef}` });
				onBranchCreated?.(trimmedName);
				onClose();
			} else {
				showAppToast({ intent: "danger", message: result.error ?? "Failed to create branch." });
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: `Failed to create branch: ${toErrorMessage(error)}`,
			});
		} finally {
			setIsCreating(false);
		}
	}, [branchName, state.sourceRef, projectId, onBranchCreated, onClose]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && branchName.trim() && !isCreating) {
				e.preventDefault();
				void handleCreate();
			}
		},
		[branchName, isCreating, handleCreate],
	);

	if (state.type === "closed") {
		return null;
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			contentStyle={{ maxWidth: "24rem" }}
			contentAriaDescribedBy="create-branch-description"
		>
			<DialogHeader title="Create branch" icon={<GitBranch size={16} />} />
			<DialogBody>
				<div className="flex flex-col gap-3">
					<div>
						<p id="create-branch-description" className="text-xs text-text-secondary mb-3">
							Create a new branch from{" "}
							<code className="text-xs bg-surface-2 px-1 py-0.5 rounded font-mono">{state.sourceRef}</code>
						</p>
						<label htmlFor="new-branch-name" className="text-xs text-text-secondary mb-1.5 block">
							Branch name
						</label>
						<input
							id="new-branch-name"
							type="text"
							autoFocus
							value={branchName}
							onChange={(e) => setBranchName(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="feature/my-branch"
							className="w-full h-8 rounded-md border border-border bg-surface-2 px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none font-mono"
							disabled={isCreating}
						/>
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" size="sm" onClick={onClose} disabled={isCreating}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					onClick={() => void handleCreate()}
					disabled={!branchName.trim() || isCreating}
				>
					{isCreating ? "Creating..." : "Create branch"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
