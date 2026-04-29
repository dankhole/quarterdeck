import { useCallback, useMemo, useState } from "react";
import { type UseGitHistoryDataResult, useGitHistoryData } from "@/components/git/history";
import { buildTaskGitActionPrompt, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import {
	computeNextTaskGitActionLoading,
	deriveLoadingByTaskId,
	type GitActionErrorState,
	getGitActionErrorTitle,
	getGitSyncSuccessLabel,
	isTaskGitActionInFlight,
	matchesWorktreeInfoSelection,
	showGitErrorToast,
	showGitSuccessToast,
	showGitWarningToast,
	type TaskGitActionLoadingState,
	type TaskGitActionSource,
} from "@/hooks/git/git-actions";
import { isTaskBaseRefResolved } from "@/hooks/git/git-view";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitSyncAction, RuntimeTaskWorktreeInfoResponse } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	getTaskWorktreeInfo,
	getTaskWorktreeSnapshot,
	setHomeGitSummary,
	setTaskWorktreeInfo,
	useHomeGitStateVersionValue,
	useHomeGitSummaryValue,
	useTaskWorktreeSnapshotValue,
	useTaskWorktreeStateVersionValue,
} from "@/stores/project-metadata-store";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardData, CardSelection } from "@/types";
import { useLoadingGuard } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";

interface UseGitActionsInput {
	currentProjectId: string | null;
	board: BoardData;
	selectedCard: CardSelection | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	fetchTaskWorktreeInfo: (task: BoardCard) => Promise<RuntimeTaskWorktreeInfoResponse | null>;
	isGitHistoryOpen: boolean;
	refreshProjectState: () => Promise<void>;
}

export interface UseGitActionsResult {
	runningGitAction: RuntimeGitSyncAction | null;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingState>;
	commitTaskLoadingById: Record<string, boolean>;
	openPrTaskLoadingById: Record<string, boolean>;
	agentCommitTaskLoadingById: Record<string, boolean>;
	agentOpenPrTaskLoadingById: Record<string, boolean>;
	isSwitchingHomeBranch: boolean;
	isDiscardingHomeWorkingChanges: boolean;
	isStashAndRetryingPull: boolean;
	gitActionError: GitActionErrorState | null;
	gitActionErrorTitle: string;
	clearGitActionError: () => void;
	onStashAndRetry: (() => void) | undefined;
	gitHistory: UseGitHistoryDataResult;
	gitHistoryTaskScope: { taskId: string; baseRef: string } | null;
	runGitAction: (
		action: RuntimeGitSyncAction,
		taskScope?: { taskId: string; baseRef: string } | null,
		branch?: string | null,
	) => Promise<void>;
	switchHomeBranch: (branch: string) => Promise<void>;
	discardHomeWorkingChanges: () => Promise<void>;
	handleCommitTask: (taskId: string) => void;
	handleOpenPrTask: (taskId: string) => void;
	handleAgentCommitTask: (taskId: string) => void;
	handleAgentOpenPrTask: (taskId: string) => void;
	resetGitActionState: () => void;
}

export function useGitActions({
	currentProjectId,
	board,
	selectedCard,
	runtimeProjectConfig,
	sendTaskSessionInput,
	fetchTaskWorktreeInfo,
	isGitHistoryOpen,
	refreshProjectState,
}: UseGitActionsInput): UseGitActionsResult {
	const [runningGitAction, setRunningGitAction] = useState<RuntimeGitSyncAction | null>(null);
	const [taskGitActionLoadingByTaskId, setTaskGitActionLoadingByTaskId] = useState<
		Record<string, TaskGitActionLoadingState>
	>({});
	const switchHomeBranchGuard = useLoadingGuard();
	const discardHomeChangesGuard = useLoadingGuard();
	const stashAndRetryPullGuard = useLoadingGuard();
	const isSwitchingHomeBranch = switchHomeBranchGuard.isLoading;
	const isDiscardingHomeWorkingChanges = discardHomeChangesGuard.isLoading;
	const isStashAndRetryingPull = stashAndRetryPullGuard.isLoading;
	const [gitActionError, setGitActionError] = useState<GitActionErrorState | null>(null);
	const homeGitSummary = useHomeGitSummaryValue();
	const homeGitStateVersion = useHomeGitStateVersionValue();
	const selectedTaskWorktreeSnapshot = useTaskWorktreeSnapshotValue(
		selectedCard?.card.id ?? null,
		selectedCard?.card.baseRef,
	);
	const selectedTaskWorktreeStateVersion = useTaskWorktreeStateVersionValue(selectedCard?.card.id ?? null);

	const gitHistoryTaskScope = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return {
			taskId: selectedCard.card.id,
			baseRef: selectedCard.card.baseRef,
		};
	}, [selectedCard?.card.baseRef, selectedCard?.card.id]);

	const gitHistorySummary = useMemo(() => {
		if (!selectedCard) {
			return homeGitSummary;
		}
		if (!selectedTaskWorktreeSnapshot) {
			return null;
		}
		return {
			currentBranch: selectedTaskWorktreeSnapshot.branch,
			upstreamBranch: null,
			changedFiles: selectedTaskWorktreeSnapshot.changedFiles ?? 0,
			additions: selectedTaskWorktreeSnapshot.additions ?? 0,
			deletions: selectedTaskWorktreeSnapshot.deletions ?? 0,
			aheadCount: 0,
			behindCount: 0,
		};
	}, [homeGitSummary, selectedCard, selectedTaskWorktreeSnapshot]);
	const gitHistoryStateVersion = selectedCard ? selectedTaskWorktreeStateVersion : homeGitStateVersion;

	const gitHistory = useGitHistoryData({
		projectId: currentProjectId,
		taskScope: gitHistoryTaskScope,
		gitSummary: gitHistorySummary,
		stateVersion: gitHistoryStateVersion,
		enabled: isGitHistoryOpen,
	});
	const refreshGitHistory = gitHistory.refresh;

	const setTaskGitActionLoading = useCallback(
		(taskId: string, action: TaskGitAction, source: TaskGitActionSource | null) => {
			const actionKey = action === "commit" ? "commitSource" : "prSource";
			setTaskGitActionLoadingByTaskId((current) => {
				return computeNextTaskGitActionLoading(current, taskId, actionKey, source) ?? current;
			});
		},
		[],
	);

	const commitTaskLoadingById = useMemo(
		() => deriveLoadingByTaskId(taskGitActionLoadingByTaskId, "commitSource", "card"),
		[taskGitActionLoadingByTaskId],
	);
	const openPrTaskLoadingById = useMemo(
		() => deriveLoadingByTaskId(taskGitActionLoadingByTaskId, "prSource", "card"),
		[taskGitActionLoadingByTaskId],
	);
	const agentCommitTaskLoadingById = useMemo(
		() => deriveLoadingByTaskId(taskGitActionLoadingByTaskId, "commitSource", "agent"),
		[taskGitActionLoadingByTaskId],
	);
	const agentOpenPrTaskLoadingById = useMemo(
		() => deriveLoadingByTaskId(taskGitActionLoadingByTaskId, "prSource", "agent"),
		[taskGitActionLoadingByTaskId],
	);

	const runTaskGitAction = useCallback(
		async (taskId: string, action: TaskGitAction, source: TaskGitActionSource) => {
			const actionKey = action === "commit" ? "commitSource" : "prSource";
			if (isTaskGitActionInFlight(taskGitActionLoadingByTaskId, taskId, actionKey)) {
				return false;
			}
			setTaskGitActionLoading(taskId, action, source);
			try {
				const selection = findCardSelection(board, taskId);
				if (!selection) {
					showGitErrorToast("Could not find the selected task card.", { timeout: 5000 });
					return false;
				}
				if (selection.column.id !== "review") {
					showGitWarningToast("Commit and PR actions are only available for tasks in Review.", 5000);
					return false;
				}
				if (!isTaskBaseRefResolved(taskId, selection.card.baseRef)) {
					showGitWarningToast("Select a base branch before committing or opening a PR for this task.", 5000);
					return false;
				}

				const snapshot = getTaskWorktreeSnapshot(taskId, selection.card.baseRef);
				const snapshotWorktreeInfo = snapshot
					? {
							taskId,
							path: snapshot.path,
							exists: true,
							baseRef: selection.card.baseRef,
							branch: snapshot.branch,
							isDetached: snapshot.isDetached,
							headCommit: snapshot.headCommit,
						}
					: null;
				const storedWorktreeInfo = getTaskWorktreeInfo(selection.card.id, selection.card.baseRef);
				const worktreeInfo = matchesWorktreeInfoSelection(storedWorktreeInfo, selection.card)
					? storedWorktreeInfo
					: (snapshotWorktreeInfo ?? (await fetchTaskWorktreeInfo(selection.card)));
				if (!worktreeInfo) {
					showGitErrorToast("Could not resolve task worktree details.", { timeout: 6000 });
					return false;
				}
				setTaskWorktreeInfo(worktreeInfo);

				const prompt = buildTaskGitActionPrompt({
					action,
					worktreeInfo,
					templates: runtimeProjectConfig
						? {
								commitPromptTemplate: runtimeProjectConfig.commitPromptTemplate,
								openPrPromptTemplate: runtimeProjectConfig.openPrPromptTemplate,
								commitPromptTemplateDefault: runtimeProjectConfig.commitPromptTemplateDefault,
								openPrPromptTemplateDefault: runtimeProjectConfig.openPrPromptTemplateDefault,
							}
						: null,
				});
				const typed = await sendTaskSessionInput(taskId, prompt, { appendNewline: false, mode: "paste" });
				if (!typed.ok) {
					showGitErrorToast(typed.message ?? "Could not send instructions to the task session.");
					return false;
				}
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 200);
				});
				const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
				if (!submitted.ok) {
					showGitErrorToast(submitted.message ?? "Could not submit instructions to the task session.");
					return false;
				}
				getTerminalController(taskId)?.focus?.();
				return true;
			} finally {
				setTaskGitActionLoading(taskId, action, null);
			}
		},
		[
			board,
			fetchTaskWorktreeInfo,
			runtimeProjectConfig,
			sendTaskSessionInput,
			setTaskGitActionLoading,
			taskGitActionLoadingByTaskId,
		],
	);

	const handleCommitTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "commit", "card");
		},
		[runTaskGitAction],
	);

	const handleOpenPrTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "pr", "card");
		},
		[runTaskGitAction],
	);

	const handleAgentCommitTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "commit", "agent");
		},
		[runTaskGitAction],
	);

	const handleAgentOpenPrTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "pr", "agent");
		},
		[runTaskGitAction],
	);

	const runGitAction = useCallback(
		async (
			action: RuntimeGitSyncAction,
			taskScope?: { taskId: string; baseRef: string } | null,
			branch?: string | null,
		) => {
			if (!currentProjectId || runningGitAction || isSwitchingHomeBranch) {
				return;
			}
			setRunningGitAction(action);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.project.runGitSyncAction.mutate({
					action,
					taskScope: taskScope ?? null,
					branch: branch ?? null,
				});
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? `${action} failed.`;
					const output = payload.output ?? "";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary && !taskScope) {
						setHomeGitSummary(fallbackSummary);
					}
					setGitActionError({
						action,
						message: errorMessage,
						output,
						dirtyTree: payload.dirtyTree || undefined,
					});
					return;
				}
				if (!taskScope) {
					setHomeGitSummary(payload.summary);
				}
				refreshGitHistory();
				showGitSuccessToast(getGitSyncSuccessLabel(action));
			} catch (error) {
				const message = toErrorMessage(error);
				setGitActionError({
					action,
					message,
					output: "",
				});
			} finally {
				setRunningGitAction(null);
			}
		},
		[currentProjectId, isSwitchingHomeBranch, refreshGitHistory, runningGitAction],
	);

	const switchHomeBranch = useCallback(
		async (branch: string) => {
			const normalizedBranch = branch.trim();
			const currentBranch = homeGitSummary?.currentBranch ?? null;
			if (!currentProjectId || !normalizedBranch || normalizedBranch === currentBranch) {
				return;
			}
			await switchHomeBranchGuard.run(async () => {
				try {
					const trpcClient = getRuntimeTrpcClient(currentProjectId);
					const payload = await trpcClient.project.checkoutGitBranch.mutate({
						branch: normalizedBranch,
					});
					if (!payload.ok || !payload.summary) {
						const errorMessage = payload.error ?? "Switch branch failed.";
						const fallbackSummary = payload.summary ?? null;
						if (fallbackSummary) {
							setHomeGitSummary(fallbackSummary);
						}
						if (payload.dirtyTree) {
							showGitErrorToast(`Could not switch to ${normalizedBranch}. ${errorMessage}`, {
								timeout: 12000,
								action: {
									label: "Stash & Switch",
									onClick: () => {
										void (async () => {
											try {
												const stashClient = getRuntimeTrpcClient(currentProjectId);
												const stashResult = await stashClient.project.stashPush.mutate({
													taskScope: null,
													paths: [],
												});
												if (!stashResult.ok) {
													showGitErrorToast(`Stash failed: ${stashResult.error ?? "Unknown error"}`);
													return;
												}
												await switchHomeBranch(normalizedBranch);
											} catch (stashError) {
												showGitErrorToast(`Stash failed: ${toErrorMessage(stashError)}`);
											}
										})();
									},
								},
							});
						} else {
							showGitErrorToast(`Could not switch to ${normalizedBranch}. ${errorMessage}`);
						}
						return;
					}
					setHomeGitSummary(payload.summary);
					refreshGitHistory();
					await refreshProjectState();
				} catch (error) {
					showGitErrorToast(`Could not switch to ${normalizedBranch}. ${toErrorMessage(error)}`);
				}
			});
		},
		[
			currentProjectId,
			switchHomeBranchGuard.run,
			homeGitSummary?.currentBranch,
			refreshGitHistory,
			refreshProjectState,
		],
	);

	const discardHomeWorkingChanges = useCallback(async () => {
		if (!currentProjectId) return;
		await discardHomeChangesGuard.run(async () => {
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.project.discardGitChanges.mutate(null);
				if (!payload.ok) {
					if (payload.summary) {
						setHomeGitSummary(payload.summary);
					}
					showGitErrorToast(payload.error ?? "Could not discard working copy changes.");
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
				showGitSuccessToast("Discarded working copy changes.", 4000);
			} catch (error) {
				showGitErrorToast(`Could not discard working copy changes. ${toErrorMessage(error)}`);
			}
		});
	}, [currentProjectId, discardHomeChangesGuard.run, refreshGitHistory]);

	const stashAndRetryPull = useCallback(async () => {
		if (!currentProjectId) return;
		await stashAndRetryPullGuard.run(async () => {
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);

				const stashResult = await trpcClient.project.stashPush.mutate({
					taskScope: null,
					paths: [],
				});
				if (!stashResult.ok) {
					showGitErrorToast(`Stash failed: ${stashResult.error ?? "Unknown error"}`);
					return;
				}

				const pullResult = await trpcClient.project.runGitSyncAction.mutate({ action: "pull" });
				if (!pullResult.ok || !pullResult.summary) {
					const fallbackSummary = pullResult.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					setGitActionError({
						action: "pull",
						message: pullResult.error ?? "Pull failed after stash",
						output: pullResult.output ?? "",
						dirtyTree: false,
					});
					showGitErrorToast(
						`Pull failed after stash: ${pullResult.error ?? "Unknown error"}. Your changes are still stashed.`,
						{ timeout: 10000 },
					);
					return;
				}
				setHomeGitSummary(pullResult.summary);

				const popResult = await trpcClient.project.stashPop.mutate({
					taskScope: null,
					index: 0,
				});
				if (!popResult.ok) {
					if (popResult.conflicted) {
						showGitWarningToast(
							"Pull succeeded. Stash pop has conflicts \u2014 resolve them in the commit panel.",
							10000,
						);
					} else {
						showGitErrorToast(`Pull succeeded but stash pop failed: ${popResult.error ?? "Unknown error"}`, {
							timeout: 10000,
						});
					}
				} else {
					showGitSuccessToast("Pull succeeded. Stashed changes restored.", 5000);
				}

				setGitActionError(null);
				refreshGitHistory();
			} catch (error) {
				showGitErrorToast(`Stash & Pull failed: ${toErrorMessage(error)}`);
			}
		});
	}, [currentProjectId, stashAndRetryPullGuard.run, refreshGitHistory]);

	const resetGitActionState = useCallback(() => {
		setRunningGitAction(null);
		setTaskGitActionLoadingByTaskId({});
		switchHomeBranchGuard.reset();
		discardHomeChangesGuard.reset();
		stashAndRetryPullGuard.reset();
		setGitActionError(null);
	}, [switchHomeBranchGuard, discardHomeChangesGuard, stashAndRetryPullGuard]);

	const onStashAndRetry =
		gitActionError?.dirtyTree && gitActionError.action === "pull" ? stashAndRetryPull : undefined;

	const gitActionErrorTitle = useMemo(() => getGitActionErrorTitle(gitActionError), [gitActionError]);

	return {
		runningGitAction,
		taskGitActionLoadingByTaskId,
		commitTaskLoadingById,
		openPrTaskLoadingById,
		agentCommitTaskLoadingById,
		agentOpenPrTaskLoadingById,
		isSwitchingHomeBranch,
		isDiscardingHomeWorkingChanges,
		isStashAndRetryingPull,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError: () => {
			setGitActionError(null);
		},
		onStashAndRetry,
		gitHistory,
		gitHistoryTaskScope,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		handleCommitTask,
		handleOpenPrTask,
		handleAgentCommitTask,
		handleAgentOpenPrTask,
		resetGitActionState,
	};
}
