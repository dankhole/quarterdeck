import { useCallback, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { type UseGitHistoryDataResult, useGitHistoryData } from "@/components/git-history/use-git-history-data";
import { buildTaskGitActionPrompt, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitSyncAction, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	setHomeGitSummary,
	setTaskWorkspaceInfo,
	useHomeGitStateVersionValue,
	useHomeGitSummaryValue,
	useTaskWorkspaceSnapshotValue,
	useTaskWorkspaceStateVersionValue,
} from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardData, CardSelection } from "@/types";

type TaskGitActionSource = "card" | "agent";

interface TaskGitActionLoadingState {
	commitSource: TaskGitActionSource | null;
	prSource: TaskGitActionSource | null;
}

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
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	isGitHistoryOpen: boolean;
	refreshWorkspaceState: () => Promise<void>;
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
	gitActionError: {
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
		dirtyTree?: boolean;
	} | null;
	gitActionErrorTitle: string;
	clearGitActionError: () => void;
	onStashAndRetry: (() => void) | undefined;
	gitHistory: UseGitHistoryDataResult;
	gitHistoryTaskScope: { taskId: string; baseRef: string } | null;
	runGitAction: (
		action: RuntimeGitSyncAction,
		taskScope?: { taskId: string; baseRef: string } | null,
	) => Promise<void>;
	switchHomeBranch: (branch: string) => Promise<void>;
	discardHomeWorkingChanges: () => Promise<void>;
	handleCommitTask: (taskId: string) => void;
	handleOpenPrTask: (taskId: string) => void;
	handleAgentCommitTask: (taskId: string) => void;
	handleAgentOpenPrTask: (taskId: string) => void;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	resetGitActionState: () => void;
}

function matchesWorkspaceInfoSelection(
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse | null,
	card: BoardCard | null,
): workspaceInfo is RuntimeTaskWorkspaceInfoResponse {
	if (!workspaceInfo || !card) {
		return false;
	}
	return workspaceInfo.taskId === card.id && workspaceInfo.baseRef === card.baseRef;
}

export function useGitActions({
	currentProjectId,
	board,
	selectedCard,
	runtimeProjectConfig,
	sendTaskSessionInput,
	fetchTaskWorkspaceInfo,
	isGitHistoryOpen,
	refreshWorkspaceState,
}: UseGitActionsInput): UseGitActionsResult {
	const [runningGitAction, setRunningGitAction] = useState<RuntimeGitSyncAction | null>(null);
	const [taskGitActionLoadingByTaskId, setTaskGitActionLoadingByTaskId] = useState<
		Record<string, TaskGitActionLoadingState>
	>({});
	const [isSwitchingHomeBranch, setIsSwitchingHomeBranch] = useState(false);
	const [isDiscardingHomeWorkingChanges, setIsDiscardingHomeWorkingChanges] = useState(false);
	const [isStashAndRetryingPull, setIsStashAndRetryingPull] = useState(false);
	const [gitActionError, setGitActionError] = useState<{
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
		dirtyTree?: boolean;
	} | null>(null);
	const homeGitSummary = useHomeGitSummaryValue();
	const homeGitStateVersion = useHomeGitStateVersionValue();
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id ?? null);
	const selectedTaskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(selectedCard?.card.id ?? null);

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
		if (!selectedTaskWorkspaceSnapshot) {
			return null;
		}
		return {
			currentBranch: selectedTaskWorkspaceSnapshot.branch,
			upstreamBranch: null,
			changedFiles: selectedTaskWorkspaceSnapshot.changedFiles ?? 0,
			additions: selectedTaskWorkspaceSnapshot.additions ?? 0,
			deletions: selectedTaskWorkspaceSnapshot.deletions ?? 0,
			aheadCount: 0,
			behindCount: 0,
		};
	}, [homeGitSummary, selectedCard, selectedTaskWorkspaceSnapshot]);
	const gitHistoryStateVersion = selectedCard ? selectedTaskWorkspaceStateVersion : homeGitStateVersion;

	const gitHistory = useGitHistoryData({
		workspaceId: currentProjectId,
		taskScope: gitHistoryTaskScope,
		gitSummary: gitHistorySummary,
		stateVersion: gitHistoryStateVersion,
		enabled: isGitHistoryOpen,
	});
	const refreshGitHistory = gitHistory.refresh;

	const setTaskGitActionLoading = useCallback(
		(taskId: string, action: TaskGitAction, source: TaskGitActionSource | null) => {
			setTaskGitActionLoadingByTaskId((current) => {
				const existing = current[taskId] ?? { commitSource: null, prSource: null };
				const key = action === "commit" ? "commitSource" : "prSource";
				if (existing[key] === source) {
					return current;
				}
				const nextEntry: TaskGitActionLoadingState = {
					...existing,
					[key]: source,
				};
				if (nextEntry.commitSource === null && nextEntry.prSource === null) {
					const { [taskId]: _removed, ...rest } = current;
					return rest;
				}
				return {
					...current,
					[taskId]: nextEntry,
				};
			});
		},
		[],
	);

	const commitTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.commitSource === "card") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const openPrTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.prSource === "card") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const agentCommitTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.commitSource === "agent") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const agentOpenPrTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.prSource === "agent") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const runTaskGitAction = useCallback(
		async (taskId: string, action: TaskGitAction, source: TaskGitActionSource) => {
			const taskLoadingState = taskGitActionLoadingByTaskId[taskId];
			const actionInFlightSource = action === "commit" ? taskLoadingState?.commitSource : taskLoadingState?.prSource;
			if (actionInFlightSource !== null && actionInFlightSource !== undefined) {
				return false;
			}
			setTaskGitActionLoading(taskId, action, source);
			try {
				const selection = findCardSelection(board, taskId);
				if (!selection) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: "Could not find the selected task card.",
						timeout: 5000,
					});
					return false;
				}
				if (selection.column.id !== "review") {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: "Commit and PR actions are only available for tasks in Review.",
						timeout: 5000,
					});
					return false;
				}

				const snapshot = getTaskWorkspaceSnapshot(taskId);
				const snapshotWorkspaceInfo = snapshot
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
				const storedWorkspaceInfo = getTaskWorkspaceInfo(selection.card.id, selection.card.baseRef);
				const workspaceInfo = matchesWorkspaceInfoSelection(storedWorkspaceInfo, selection.card)
					? storedWorkspaceInfo
					: (snapshotWorkspaceInfo ?? (await fetchTaskWorkspaceInfo(selection.card)));
				if (!workspaceInfo) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: "Could not resolve task workspace details.",
						timeout: 6000,
					});
					return false;
				}
				setTaskWorkspaceInfo(workspaceInfo);

				const prompt = buildTaskGitActionPrompt({
					action,
					workspaceInfo,
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
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: typed.message ?? "Could not send instructions to the task session.",
						timeout: 7000,
					});
					return false;
				}
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 200);
				});
				const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
				if (!submitted.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: submitted.message ?? "Could not submit instructions to the task session.",
						timeout: 7000,
					});
					return false;
				}
				return true;
			} finally {
				setTaskGitActionLoading(taskId, action, null);
			}
		},
		[
			board,
			fetchTaskWorkspaceInfo,
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
		async (action: RuntimeGitSyncAction, taskScope?: { taskId: string; baseRef: string } | null) => {
			if (!currentProjectId || runningGitAction || isSwitchingHomeBranch) {
				return;
			}
			setRunningGitAction(action);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.runGitSyncAction.mutate({
					action,
					taskScope: taskScope ?? null,
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
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
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
			if (!currentProjectId || isSwitchingHomeBranch || !normalizedBranch || normalizedBranch === currentBranch) {
				return;
			}
			setIsSwitchingHomeBranch(true);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.checkoutGitBranch.mutate({
					branch: normalizedBranch,
				});
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? "Switch branch failed.";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					if (payload.dirtyTree) {
						showAppToast({
							intent: "danger",
							icon: "warning-sign",
							message: `Could not switch to ${normalizedBranch}. ${errorMessage}`,
							timeout: 12000,
							action: {
								label: "Stash & Switch",
								onClick: () => {
									void (async () => {
										try {
											const stashClient = getRuntimeTrpcClient(currentProjectId);
											const stashResult = await stashClient.workspace.stashPush.mutate({
												taskScope: null,
												paths: [],
											});
											if (!stashResult.ok) {
												showAppToast({
													intent: "danger",
													icon: "warning-sign",
													message: `Stash failed: ${stashResult.error ?? "Unknown error"}`,
													timeout: 7000,
												});
												return;
											}
											await switchHomeBranch(normalizedBranch);
										} catch (stashError) {
											const stashMsg = stashError instanceof Error ? stashError.message : String(stashError);
											showAppToast({
												intent: "danger",
												icon: "warning-sign",
												message: `Stash failed: ${stashMsg}`,
												timeout: 7000,
											});
										}
									})();
								},
							},
						});
					} else {
						showAppToast({
							intent: "danger",
							icon: "warning-sign",
							message: `Could not switch to ${normalizedBranch}. ${errorMessage}`,
							timeout: 7000,
						});
					}
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
				await refreshWorkspaceState();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Could not switch to ${normalizedBranch}. ${message}`,
					timeout: 7000,
				});
			} finally {
				setIsSwitchingHomeBranch(false);
			}
		},
		[
			currentProjectId,
			homeGitSummary?.currentBranch,
			isSwitchingHomeBranch,
			refreshGitHistory,
			refreshWorkspaceState,
		],
	);

	const discardHomeWorkingChanges = useCallback(async () => {
		if (!currentProjectId || isDiscardingHomeWorkingChanges) {
			return;
		}
		setIsDiscardingHomeWorkingChanges(true);
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const payload = await trpcClient.workspace.discardGitChanges.mutate(null);
			if (!payload.ok) {
				if (payload.summary) {
					setHomeGitSummary(payload.summary);
				}
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: payload.error ?? "Could not discard working copy changes.",
					timeout: 7000,
				});
				return;
			}
			setHomeGitSummary(payload.summary);
			refreshGitHistory();
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Discarded working copy changes.",
				timeout: 4000,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not discard working copy changes. ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsDiscardingHomeWorkingChanges(false);
		}
	}, [currentProjectId, isDiscardingHomeWorkingChanges, refreshGitHistory]);

	const runAutoReviewGitAction = useCallback(
		async (taskId: string, action: TaskGitAction) => {
			return await runTaskGitAction(taskId, action, "card");
		},
		[runTaskGitAction],
	);

	const stashAndRetryPull = useCallback(async () => {
		if (!currentProjectId || isStashAndRetryingPull) {
			return;
		}
		setIsStashAndRetryingPull(true);
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);

			// Step 1: Stash all changes
			const stashResult = await trpcClient.workspace.stashPush.mutate({
				taskScope: null,
				paths: [],
			});
			if (!stashResult.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Stash failed: ${stashResult.error ?? "Unknown error"}`,
					timeout: 7000,
				});
				return;
			}

			// Step 2: Retry pull
			const pullResult = await trpcClient.workspace.runGitSyncAction.mutate({ action: "pull" });
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
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Pull failed after stash: ${pullResult.error ?? "Unknown error"}. Your changes are still stashed.`,
					timeout: 10000,
				});
				return;
			}
			setHomeGitSummary(pullResult.summary);

			// Step 3: Auto-pop stash on pull success
			const popResult = await trpcClient.workspace.stashPop.mutate({
				taskScope: null,
				index: 0,
			});
			if (!popResult.ok) {
				if (popResult.conflicted) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: "Pull succeeded. Stash pop has conflicts — resolve them in the commit panel.",
						timeout: 10000,
					});
				} else {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: `Pull succeeded but stash pop failed: ${popResult.error ?? "Unknown error"}`,
						timeout: 10000,
					});
				}
			} else {
				showAppToast({
					intent: "success",
					icon: "tick",
					message: "Pull succeeded. Stashed changes restored.",
					timeout: 5000,
				});
			}

			setGitActionError(null);
			refreshGitHistory();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Stash & Pull failed: ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsStashAndRetryingPull(false);
		}
	}, [currentProjectId, isStashAndRetryingPull, refreshGitHistory]);

	const resetGitActionState = useCallback(() => {
		setRunningGitAction(null);
		setTaskGitActionLoadingByTaskId({});
		setIsSwitchingHomeBranch(false);
		setIsDiscardingHomeWorkingChanges(false);
		setIsStashAndRetryingPull(false);
		setGitActionError(null);
	}, []);

	const onStashAndRetry =
		gitActionError?.dirtyTree && gitActionError.action === "pull" ? stashAndRetryPull : undefined;

	const gitActionErrorTitle = useMemo(() => {
		if (!gitActionError) {
			return "Git action failed";
		}
		if (gitActionError.action === "fetch") {
			return "Fetch failed";
		}
		if (gitActionError.action === "pull") {
			return "Pull failed";
		}
		return "Push failed";
	}, [gitActionError]);

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
		runAutoReviewGitAction,
		resetGitActionState,
	};
}
