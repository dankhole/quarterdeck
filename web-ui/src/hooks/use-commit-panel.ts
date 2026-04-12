import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import {
	useHomeGitStateVersionValue,
	useHomeGitSummaryValue,
	useTaskWorkspaceSnapshotValue,
	useTaskWorkspaceStateVersionValue,
} from "@/stores/workspace-metadata-store";

export interface UseCommitPanelResult {
	files: RuntimeWorkspaceFileChange[] | null;
	selectedPaths: string[];
	isAllSelected: boolean;
	isIndeterminate: boolean;
	toggleFile: (path: string) => void;
	toggleAll: () => void;
	message: string;
	setMessage: (msg: string) => void;
	canCommit: boolean;
	canPush: boolean;
	isLoading: boolean;
	isCommitting: boolean;
	isPushing: boolean;
	isDiscarding: boolean;
	isRollingBack: boolean;
	lastError: string | null;
	clearError: () => void;
	commitFiles: () => Promise<void>;
	commitAndPush: () => Promise<void>;
	discardAll: () => Promise<void>;
	rollbackFile: (path: string, fileStatus: string) => Promise<void>;
}

export function useCommitPanel(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
): UseCommitPanelResult {
	// State version — call both hooks unconditionally (React rules of hooks).
	const taskStateVersion = useTaskWorkspaceStateVersionValue(taskId);
	const homeStateVersion = useHomeGitStateVersionValue();
	const stateVersion = taskId ? taskStateVersion : homeStateVersion;

	// Branch awareness — determine if push is possible (requires a named branch, not detached HEAD).
	const homeGitSummary = useHomeGitSummaryValue();
	const taskSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const isOnNamedBranch = taskId
		? !!(taskSnapshot?.branch && !taskSnapshot.isDetached)
		: !!homeGitSummary?.currentBranch;

	// Mutation loading flags — suppress polling while any mutation is in flight.
	const [isCommitting, setIsCommitting] = useState(false);
	const [isPushing, setIsPushing] = useState(false);
	const [isDiscarding, setIsDiscarding] = useState(false);
	const [isRollingBack, setIsRollingBack] = useState(false);

	// Last error — shown inline in the commit panel so large hook output is readable.
	const [lastError, setLastError] = useState<string | null>(null);
	const clearError = useCallback(() => setLastError(null), []);
	const isMutating = isCommitting || isDiscarding || isRollingBack;
	const pollIntervalMs = isMutating ? null : 1000;

	// File list data via shared hook.
	const { changes, isLoading } = useRuntimeWorkspaceChanges(
		taskId,
		workspaceId,
		baseRef,
		"working_copy",
		stateVersion,
		pollIntervalMs,
	);
	const files = changes?.files ?? null;

	// Selection state — Map<path, checked>.
	const [selection, setSelection] = useState<Map<string, boolean>>(() => new Map());

	// Sync selection when file list changes: add new files as checked, remove departed files.
	const prevPathsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!files) return;
		const currentPaths = new Set(files.map((f) => f.path));
		const prevPaths = prevPathsRef.current;

		// Detect actual changes to avoid unnecessary re-renders.
		const added = files.filter((f) => !prevPaths.has(f.path));
		const removed = [...prevPaths].filter((p) => !currentPaths.has(p));

		if (added.length > 0 || removed.length > 0) {
			setSelection((prev) => {
				const next = new Map(prev);
				for (const f of added) {
					next.set(f.path, true);
				}
				for (const p of removed) {
					next.delete(p);
				}
				return next;
			});
		}

		// Initialize selection for first load (all checked).
		if (prevPaths.size === 0 && files.length > 0) {
			setSelection(new Map(files.map((f) => [f.path, true])));
		}

		prevPathsRef.current = currentPaths;
	}, [files]);

	// Derived selection state.
	const selectedPaths = useMemo(() => {
		if (!files) return [];
		return files.filter((f) => selection.get(f.path)).map((f) => f.path);
	}, [files, selection]);

	const isAllSelected = files !== null && files.length > 0 && selectedPaths.length === files.length;
	const isIndeterminate = selectedPaths.length > 0 && !isAllSelected;

	// Toggle individual file.
	const toggleFile = useCallback((path: string) => {
		setSelection((prev) => {
			const next = new Map(prev);
			next.set(path, !prev.get(path));
			return next;
		});
	}, []);

	// Toggle all files.
	const toggleAll = useCallback(() => {
		if (!files) return;
		setSelection((prev) => {
			const allChecked = files.every((f) => prev.get(f.path));
			const next = new Map(prev);
			for (const f of files) {
				next.set(f.path, !allChecked);
			}
			return next;
		});
	}, [files]);

	// Commit message.
	const [message, setMessage] = useState("");

	// Task scope helper — memoized to avoid recreating callbacks that depend on it.
	const taskScope = useMemo(() => (taskId && baseRef ? { taskId, baseRef } : null), [taskId, baseRef]);

	// Validation.
	const canCommit = selectedPaths.length > 0 && message.trim().length > 0 && !isCommitting;
	const canPush = canCommit && isOnNamedBranch;

	// Shared commit implementation — handles both commit-only and commit-and-push flows.
	const doCommit = useCallback(
		async (pushAfterCommit: boolean) => {
			if (!workspaceId) return;
			if (pushAfterCommit ? !canPush : !canCommit) return;

			setIsCommitting(true);
			if (pushAfterCommit) setIsPushing(true);
			setLastError(null);
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.commitSelectedFiles.mutate({
					taskScope,
					paths: selectedPaths,
					message: message.trim(),
					...(pushAfterCommit ? { pushAfterCommit: true } : {}),
				});
				if (!result.ok) {
					const fullError = result.error ?? "Commit failed.";
					setLastError(fullError);
					showAppToast({ intent: "danger", message: fullError, timeout: 5000 });
					return;
				}
				const hashLabel = result.commitHash ? ` (${result.commitHash.slice(0, 7)})` : "";
				if (pushAfterCommit) {
					if (result.pushOk) {
						showAppToast({
							intent: "success",
							message: `Committed${hashLabel} and pushed`,
							timeout: 4000,
						});
					} else {
						showAppToast({
							intent: "warning",
							message: `Committed${hashLabel} but push failed: ${result.pushError ?? "unknown error"}`,
							timeout: 7000,
						});
					}
				} else {
					showAppToast({
						intent: "success",
						message: `Committed${hashLabel}`,
						timeout: 4000,
					});
				}
				setMessage("");
			} catch (error) {
				const label = pushAfterCommit ? "Commit & push failed." : "Commit failed.";
				const fullError = error instanceof Error ? error.message : label;
				setLastError(fullError);
				showAppToast({ intent: "danger", message: fullError, timeout: 5000 });
			} finally {
				setIsCommitting(false);
				if (pushAfterCommit) setIsPushing(false);
			}
		},
		[workspaceId, canCommit, canPush, taskScope, selectedPaths, message],
	);

	// Commit action.
	const commitFiles = useCallback(() => doCommit(false), [doCommit]);

	// Commit & push action.
	const commitAndPush = useCallback(() => doCommit(true), [doCommit]);

	// Discard all action.
	const discardAll = useCallback(async () => {
		if (!workspaceId || isDiscarding) return;
		setIsDiscarding(true);
		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const result = await trpcClient.workspace.discardGitChanges.mutate(taskScope);
			if (result.ok) {
				showAppToast({ intent: "success", message: "All changes discarded.", timeout: 4000 });
			} else {
				showAppToast({
					intent: "danger",
					message: result.error ?? "Discard failed.",
					timeout: 7000,
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Discard failed.",
				timeout: 7000,
			});
		} finally {
			setIsDiscarding(false);
		}
	}, [workspaceId, isDiscarding, taskScope]);

	// Per-file rollback action.
	const rollbackFile = useCallback(
		async (path: string, fileStatus: string) => {
			if (!workspaceId || isRollingBack) return;
			setIsRollingBack(true);
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.discardFile.mutate({
					taskScope,
					path,
					fileStatus: fileStatus as
						| "modified"
						| "added"
						| "deleted"
						| "renamed"
						| "copied"
						| "untracked"
						| "unknown",
				});
				if (result.ok) {
					showAppToast({
						intent: "success",
						message: `Discarded changes to ${path.split("/").pop()}`,
						timeout: 4000,
					});
				} else {
					showAppToast({
						intent: "danger",
						message: result.error ?? "Rollback failed.",
						timeout: 7000,
					});
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Rollback failed.",
					timeout: 7000,
				});
			} finally {
				setIsRollingBack(false);
			}
		},
		[workspaceId, isRollingBack, taskScope],
	);

	return {
		files,
		selectedPaths,
		isAllSelected,
		isIndeterminate,
		toggleFile,
		toggleAll,
		message,
		setMessage,
		canCommit,
		canPush,
		isLoading,
		isCommitting,
		isPushing,
		isDiscarding,
		isRollingBack,
		lastError,
		clearError,
		commitFiles,
		commitAndPush,
		discardAll,
		rollbackFile,
	};
}
