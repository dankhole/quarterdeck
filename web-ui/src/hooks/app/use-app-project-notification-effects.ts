import { useMemo } from "react";
import {
	useAudibleNotifications,
	useFocusedTaskNotification,
	useReviewReadyNotifications,
	useStreamErrorHandler,
} from "@/hooks/notifications";
import type { ProjectNotificationContextValue, ProjectRuntimeStreamContextValue } from "@/providers/project-provider";
import type { ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import type { BoardData } from "@/types";

interface UseAppProjectNotificationEffectsInput {
	board: BoardData;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	projectPath: string | null;
	latestTaskReadyForReview: ProjectRuntimeStreamContextValue["latestTaskReadyForReview"];
	streamError: ProjectRuntimeStreamContextValue["streamError"];
	isRuntimeDisconnected: ProjectRuntimeStreamContextValue["isRuntimeDisconnected"];
	notificationProjects: ProjectNotificationContextValue["notificationProjects"];
	audibleNotificationsEnabled: ProjectRuntimeContextValue["audibleNotificationsEnabled"];
	audibleNotificationVolume: ProjectRuntimeContextValue["audibleNotificationVolume"];
	audibleNotificationEvents: ProjectRuntimeContextValue["audibleNotificationEvents"];
	audibleNotificationsOnlyWhenHidden: ProjectRuntimeContextValue["audibleNotificationsOnlyWhenHidden"];
	audibleNotificationSuppressCurrentProject: ProjectRuntimeContextValue["audibleNotificationSuppressCurrentProject"];
}

export function useAppProjectNotificationEffects({
	board,
	selectedTaskId,
	currentProjectId,
	navigationCurrentProjectId,
	projectPath,
	latestTaskReadyForReview,
	streamError,
	isRuntimeDisconnected,
	notificationProjects,
	audibleNotificationsEnabled,
	audibleNotificationVolume,
	audibleNotificationEvents,
	audibleNotificationsOnlyWhenHidden,
	audibleNotificationSuppressCurrentProject,
}: UseAppProjectNotificationEffectsInput): void {
	useFocusedTaskNotification({ currentProjectId, selectedTaskId });
	useReviewReadyNotifications({
		activeProjectId: navigationCurrentProjectId,
		latestTaskReadyForReview,
		projectPath,
	});

	const trashTaskIdSet = useMemo(() => {
		const trashColumn = board.columns.find((column) => column.id === "trash");
		return trashColumn ? new Set(trashColumn.cards.map((card) => card.id)) : new Set<string>();
	}, [board.columns]);

	useAudibleNotifications({
		notificationProjects,
		audibleNotificationsEnabled,
		audibleNotificationVolume,
		audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject,
		currentProjectId,
		suppressedTaskIds: trashTaskIdSet,
	});

	useStreamErrorHandler({ streamError, isRuntimeDisconnected });
}
