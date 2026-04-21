import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import { useDisplaySummaryOnHover, useTitleActions } from "@/hooks/board";
import { useMigrateTaskDialog } from "@/hooks/terminal";
import type { BoardContextValue } from "@/providers/board-provider";
import type { InteractionsContextValue } from "@/providers/interactions-provider";
import type { ProjectContextValue } from "@/providers/project-provider";
import type { ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import type { SurfaceNavigationContextValue } from "@/providers/surface-navigation-provider";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toggleTaskPinned } from "@/state/board-state";
import type { ReactiveCardState, StableCardActions } from "@/state/card-actions-context";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { getTerminalPrewarmPolicy } from "@/terminal/terminal-prewarm-policy";
import { createIdleTaskSession } from "@/utils/app-utils";
import { isApprovalState } from "@/utils/session-status";

interface UseAppActionModelsInput {
	project: ProjectContextValue;
	projectRuntime: ProjectRuntimeContextValue;
	board: BoardContextValue;
	navigation: SurfaceNavigationContextValue;
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
	projectRuntime,
	board,
	navigation,
	interactions,
	serverMutationInFlightRef,
}: UseAppActionModelsInput): UseAppActionModelsResult {
	const terminalPrewarmPolicy = getTerminalPrewarmPolicy();
	const handleRequestDisplaySummary = useDisplaySummaryOnHover(
		project.currentProjectId,
		projectRuntime.runtimeProjectConfig?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		projectRuntime.runtimeProjectConfig?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		projectRuntime.llmConfigured,
	);

	const handleTerminalWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) {
				terminalPrewarmPolicy.requestTaskHoverPrewarm(taskId, project.currentProjectId);
			}
		},
		[project.currentProjectId, terminalPrewarmPolicy],
	);

	const handleTerminalCancelWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) {
				terminalPrewarmPolicy.cancelTaskHoverPrewarm(taskId);
			}
		},
		[project.currentProjectId, terminalPrewarmPolicy],
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
			refreshProjectState: project.refreshProjectState,
		});

	const handleMainViewChange = useCallback(
		(view: MainViewId) => {
			navigation.setMainView(view, { setSelectedTaskId: board.setSelectedTaskId });
		},
		[board.setSelectedTaskId, navigation.setMainView],
	);

	const handleCardSelectWithFocus = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			if (navigation.mainView === "terminal") {
				requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
			}
		},
		[navigation.mainView, interactions.handleCardSelect],
	);

	const handleCardDoubleClick = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			navigation.setMainView("terminal", { setSelectedTaskId: board.setSelectedTaskId });
			requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
		},
		[board.setSelectedTaskId, navigation.setMainView, interactions.handleCardSelect],
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
			onFlagForDebug: projectRuntime.runtimeProjectConfig?.eventLogEnabled ? handleFlagForDebug : undefined,
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
			projectRuntime.runtimeProjectConfig?.eventLogEnabled,
		],
	);

	const reactiveCardState = useMemo<ReactiveCardState>(
		() => ({
			moveToTrashLoadingById: interactions.moveToTrashLoadingById ?? {},
			migratingTaskId: migratingTaskId ?? null,
			isLlmGenerationDisabled: projectRuntime.isLlmGenerationDisabled,
			showSummaryOnCards:
				projectRuntime.runtimeProjectConfig?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
			uncommittedChangesOnCardsEnabled:
				projectRuntime.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled ??
				CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
			showRunningTaskEmergencyActions:
				projectRuntime.runtimeProjectConfig?.showRunningTaskEmergencyActions ??
				CONFIG_DEFAULTS.showRunningTaskEmergencyActions,
		}),
		[
			interactions.moveToTrashLoadingById,
			migratingTaskId,
			projectRuntime.isLlmGenerationDisabled,
			projectRuntime.runtimeProjectConfig?.showRunningTaskEmergencyActions,
			projectRuntime.runtimeProjectConfig?.showSummaryOnCards,
			projectRuntime.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled,
		],
	);

	const projectsBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationProjectIds[taskId] !== project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.currentProjectId, project.notificationSessions, project.notificationProjectIds],
	);

	const boardBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationProjectIds[taskId] === project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.currentProjectId, project.notificationSessions, project.notificationProjectIds],
	);

	const handleBack = useCallback(() => {
		board.setSelectedTaskId(null);
		navigation.closeGitHistory();
	}, [board.setSelectedTaskId, navigation.closeGitHistory]);

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
