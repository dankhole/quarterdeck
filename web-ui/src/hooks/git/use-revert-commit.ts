import { useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitCommit, RuntimeGitRef } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

export interface UseRevertCommitResult {
	target: RuntimeGitRef | null;
	pending: boolean;
	error: string | null;
	open: (head: RuntimeGitRef | null) => void;
	close: () => void;
	confirm: () => Promise<void>;
}

export function useRevertCommit({
	projectId,
	taskScope,
	commit,
	onRefresh,
}: {
	projectId: string;
	taskScope: { taskId: string; baseRef: string } | null;
	commit: RuntimeGitCommit;
	onRefresh: () => void;
}): UseRevertCommitResult {
	const [target, setTarget] = useState<RuntimeGitRef | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pendingRef = useRef(false);
	const confirm = async () => {
		if (!target || pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			const result = await getRuntimeTrpcClient(projectId).project.revertCommit.mutate({
				commitHash: commit.hash,
				expectedHead: target.hash,
				expectedBranch: target.name,
				taskScope,
			});
			if (result.ok || result.conflictState) {
				setTarget(null);
				showAppToast({
					intent: result.ok ? "success" : "warning",
					message: result.ok
						? `Reverted ${commit.shortHash} on ${target.name}`
						: result.conflictState?.conflictedFiles.length === 0 && result.error
							? `Revert is in progress: ${result.error} Open Git to complete or abort it.`
							: "Revert is in progress. Open Git to resolve conflicts, complete the revert, or abort.",
				});
				onRefresh();
			} else setError(result.error ?? "Revert failed.");
		} catch (cause) {
			setError(toErrorMessage(cause));
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	};
	return {
		target,
		pending,
		error,
		confirm,
		open: (head) => {
			setError(null);
			setTarget(head);
		},
		close: () => {
			if (!pendingRef.current) setTarget(null);
		},
	};
}
