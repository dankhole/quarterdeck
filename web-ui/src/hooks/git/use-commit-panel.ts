import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	canPerformCommit,
	computeSelectedPaths,
	computeSelectionSync,
	formatCommitSuccessMessage,
} from "@/hooks/git/commit-panel";
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
	isStashing: boolean;
	isGeneratingMessage: boolean;
	generateMessage: () => Promise<void>;
	stashMessage: string;
	setStashMessage: (msg: string) => void;
	stashChanges: () => Promise<void>;
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
	const [isStashing, setIsStashing] = useState(false);

	// Stash message — separate from commit message.
	const [stashMessage, setStashMessage] = useState("");

	// Commit message generation.
	const [isGeneratingMessage, setIsGeneratingMessage] = useState(false);

	// Last error — shown inline in the commit panel so large hook output is readable.
	const [lastError, setLastError] = useState<string | null>(null);
	const clearError = useCallback(() => setLastError(null), []);
	const isMutating = isCommitting || isDiscarding || isRollingBack || isStashing;
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
		const result = computeSelectionSync(files, prevPathsRef.current, selection);
		if (result.changed) {
			setSelection(result.selection);
		}
		prevPathsRef.current = new Set(files.map((f) => f.path));
	}, [files]);

	// Derived selection state.
	const selectedPaths = useMemo(() => computeSelectedPaths(files, selection), [files, selection]);

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
	const canCommit = canPerformCommit(selectedPaths.length, message, isCommitting);
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
				if (pushAfterCommit && !result.pushOk) {
					const hashLabel = result.commitHash ? ` (${result.commitHash.slice(0, 7)})` : "";
					showAppToast({
						intent: "warning",
						message: `Committed${hashLabel} but push failed: ${result.pushError ?? "unknown error"}`,
						timeout: 7000,
					});
				} else {
					showAppToast({
						intent: "success",
						message: formatCommitSuccessMessage(result.commitHash, pushAfterCommit),
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

	// Stash changes action.
	const stashChanges = useCallback(async () => {
		if (!workspaceId || isStashing) return;
		setIsStashing(true);
		setLastError(null);
		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const paths = selectedPaths.length === files?.length ? [] : selectedPaths;
			const result = await trpcClient.workspace.stashPush.mutate({
				taskScope,
				paths,
				message: stashMessage || undefined,
			});
			if (result.ok) {
				showAppToast({
					intent: "success",
					message: `Changes stashed${stashMessage ? `: ${stashMessage}` : ""}`,
					timeout: 4000,
				});
				setStashMessage("");
			} else {
				const fullError = result.error ?? "Stash failed.";
				setLastError(fullError);
				showAppToast({ intent: "danger", message: fullError, timeout: 5000 });
			}
		} catch (error) {
			const fullError = error instanceof Error ? error.message : "Stash failed.";
			setLastError(fullError);
			showAppToast({ intent: "danger", message: fullError, timeout: 5000 });
		} finally {
			setIsStashing(false);
		}
	}, [workspaceId, isStashing, taskScope, selectedPaths, files?.length, stashMessage]);

	// Generate commit message via LLM.
	const generateMessage = useCallback(async () => {
		if (!workspaceId || isGeneratingMessage || selectedPaths.length === 0) return;
		setIsGeneratingMessage(true);
		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const result = await trpcClient.workspace.generateCommitMessage.mutate({
				taskScope,
				paths: selectedPaths,
			});
			if (result.ok && result.message) {
				setMessage(result.message);
			} else {
				showAppToast({ intent: "warning", message: "Could not generate commit message.", timeout: 4000 });
			}
		} catch {
			showAppToast({ intent: "danger", message: "Commit message generation failed.", timeout: 5000 });
		} finally {
			setIsGeneratingMessage(false);
		}
	}, [workspaceId, isGeneratingMessage, selectedPaths, taskScope]);

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
		isStashing,
		isGeneratingMessage,
		generateMessage,
		stashMessage,
		setStashMessage,
		stashChanges,
		lastError,
		clearError,
		commitFiles,
		commitAndPush,
		discardAll,
		rollbackFile,
	};
}
