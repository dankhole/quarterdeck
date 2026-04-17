import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import { useDisplaySummaryOnHover, useTitleActions } from "@/hooks/board";
import { useMigrateTaskDialog } from "@/hooks/terminal";
import type { BoardContextValue } from "@/providers/board-provider";
import type { GitContextValue } from "@/providers/git-provider";
import type { InteractionsContextValue } from "@/providers/interactions-provider";
import type { ProjectContextValue } from "@/providers/project-provider";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toggleTaskPinned } from "@/state/board-state";
import type { ReactiveCardState, StableCardActions } from "@/state/card-actions-context";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { cancelWarmup, warmup } from "@/terminal/terminal-pool";
import { createIdleTaskSession } from "@/utils/app-utils";
import { isApprovalState } from "@/utils/session-status";

interface UseAppActionModelsInput {
	project: ProjectContextValue;
	board: BoardContextValue;
	git: GitContextValue;
	interactions: InteractionsContextValue;
	serverMutationInFlightRef: MutableRefObject<boolean>;
}

export interface UseAppActionModelsResult {
	stableCardActions: StableCardActions;
	reactiveCardState: ReactiveCardState;
	pendingMigrate: { taskId: string; direction: "isolate" | "de-isolate" } | null;
	migratingTaskId: string | null;
	handleConfirmMigrate: () => void;
	cancelMigrate: () => void;
	handleMainViewChange: (view: MainViewId) => void;
	handleCardSelectWithFocus: (taskId: string) => void;
	handleCardDoubleClick: (taskId: string) => void;
	handleBack: () => void;
	projectsBadgeColor: "orange" | undefined;
	boardBadgeColor: "orange" | undefined;
	detailSession: ReturnType<typeof createIdleTaskSession> | null;
}

export function useAppActionModels({
	project,
	board,
	git,
	interactions,
	serverMutationInFlightRef,
}: UseAppActionModelsInput): UseAppActionModelsResult {
	const handleRequestDisplaySummary = useDisplaySummaryOnHover(
		project.currentProjectId,
		project.runtimeProjectConfig?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		project.runtimeProjectConfig?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		project.llmConfigured,
	);

	const handleTerminalWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) warmup(taskId, project.currentProjectId);
		},
		[project.currentProjectId],
	);

	const handleTerminalCancelWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) cancelWarmup(taskId);
		},
		[project.currentProjectId],
	);

	const { handleRegenerateTitleTask, handleUpdateTaskTitle } = useTitleActions({
		currentProjectId: project.currentProjectId,
	});

	const handleToggleTaskPinned = useCallback(
		(taskId: string) => {
			board.setBoard((current) => toggleTaskPinned(current, taskId).board);
		},
		[board.setBoard],
	);

	const { pendingMigrate, migratingTaskId, handleMigrateWorkingDirectory, handleConfirmMigrate, cancelMigrate } =
		useMigrateTaskDialog({
			currentProjectId: project.currentProjectId,
			serverMutationInFlightRef,
			stopTaskSession: board.stopTaskSession,
			refreshWorkspaceState: project.refreshWorkspaceState,
		});

	const handleMainViewChange = useCallback(
		(view: MainViewId) => {
			git.setMainView(view, { setSelectedTaskId: board.setSelectedTaskId });
		},
		[board.setSelectedTaskId, git.setMainView],
	);

	const handleCardSelectWithFocus = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			if (git.mainView === "terminal") {
				requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
			}
		},
		[git.mainView, interactions.handleCardSelect],
	);

	const handleCardDoubleClick = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			git.setMainView("terminal", { setSelectedTaskId: board.setSelectedTaskId });
			requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
		},
		[board.setSelectedTaskId, git.setMainView, interactions.handleCardSelect],
	);

	const handleFlagForDebug = useCallback(
		(taskId: string) => {
			if (!project.currentProjectId) return;
			getRuntimeTrpcClient(project.currentProjectId)
				.runtime.flagTaskForDebug.mutate({ taskId })
				.then((result) => {
					if (result.ok) showAppToast({ message: "Flagged in event log", intent: "success", timeout: 2000 });
				})
				.catch(() => {});
		},
		[project.currentProjectId],
	);

	const stableCardActions = useMemo<StableCardActions>(
		() => ({
			onStartTask: interactions.handleStartTaskFromBoard,
			onRestartSessionTask: interactions.handleRestartTaskSession,
			onMoveToTrashTask: interactions.handleMoveReviewCardToTrash,
			onRestoreFromTrashTask: interactions.handleRestoreTaskFromTrash,
			onHardDeleteTrashTask: interactions.handleHardDeleteTrashTask,
			onCancelAutomaticTaskAction: interactions.handleCancelAutomaticTaskAction,
			onRegenerateTitleTask: handleRegenerateTitleTask,
			onUpdateTaskTitle: handleUpdateTaskTitle,
			onTogglePinTask: handleToggleTaskPinned,
			onMigrateWorkingDirectory: handleMigrateWorkingDirectory,
			onRequestDisplaySummary: handleRequestDisplaySummary,
			onTerminalWarmup: handleTerminalWarmup,
			onTerminalCancelWarmup: handleTerminalCancelWarmup,
			onFlagForDebug: project.runtimeProjectConfig?.eventLogEnabled ? handleFlagForDebug : undefined,
		}),
		[
			handleFlagForDebug,
			handleMigrateWorkingDirectory,
			handleRegenerateTitleTask,
			handleRequestDisplaySummary,
			handleTerminalCancelWarmup,
			handleTerminalWarmup,
			handleToggleTaskPinned,
			handleUpdateTaskTitle,
			interactions.handleCancelAutomaticTaskAction,
			interactions.handleHardDeleteTrashTask,
			interactions.handleMoveReviewCardToTrash,
			interactions.handleRestartTaskSession,
			interactions.handleRestoreTaskFromTrash,
			interactions.handleStartTaskFromBoard,
			project.runtimeProjectConfig?.eventLogEnabled,
		],
	);

	const reactiveCardState = useMemo<ReactiveCardState>(
		() => ({
			moveToTrashLoadingById: interactions.moveToTrashLoadingById ?? {},
			migratingTaskId: migratingTaskId ?? null,
			isLlmGenerationDisabled: project.isLlmGenerationDisabled,
			showSummaryOnCards: project.runtimeProjectConfig?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
			uncommittedChangesOnCardsEnabled:
				project.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled ??
				CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
			showRunningTaskEmergencyActions:
				project.runtimeProjectConfig?.showRunningTaskEmergencyActions ??
				CONFIG_DEFAULTS.showRunningTaskEmergencyActions,
		}),
		[
			interactions.moveToTrashLoadingById,
			migratingTaskId,
			project.isLlmGenerationDisabled,
			project.runtimeProjectConfig?.showRunningTaskEmergencyActions,
			project.runtimeProjectConfig?.showSummaryOnCards,
			project.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled,
		],
	);

	const projectsBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationWorkspaceIds[taskId] !== project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.currentProjectId, project.notificationSessions, project.notificationWorkspaceIds],
	);

	const boardBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationWorkspaceIds[taskId] === project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.currentProjectId, project.notificationSessions, project.notificationWorkspaceIds],
	);

	const handleBack = useCallback(() => {
		board.setSelectedTaskId(null);
		git.setIsGitHistoryOpen(false);
	}, [board.setSelectedTaskId, git.setIsGitHistoryOpen]);

	const detailSession = board.selectedCard
		? (board.sessions[board.selectedCard.card.id] ?? createIdleTaskSession(board.selectedCard.card.id))
		: null;

	return {
		stableCardActions,
		reactiveCardState,
		pendingMigrate,
		migratingTaskId,
		handleConfirmMigrate,
		cancelMigrate,
		handleMainViewChange,
		handleCardSelectWithFocus,
		handleCardDoubleClick,
		handleBack,
		projectsBadgeColor,
		boardBadgeColor,
		detailSession,
	};
}
