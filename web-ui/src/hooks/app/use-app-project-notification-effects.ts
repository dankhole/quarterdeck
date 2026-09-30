import { useMemo } from "react";
import { findTrashTaskIds } from "@/hooks/board/trash-workflow";
import { useAudibleNotifications, useReviewReadyNotifications, useStreamErrorHandler } from "@/hooks/notifications";
import type { ProjectNotificationContextValue, ProjectRuntimeStreamContextValue } from "@/providers/project-provider";
import type { ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import type { BoardData } from "@/types";

interface UseAppProjectNotificationEffectsInput {
	board: BoardData;
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	projectName: string | null;
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
	currentProjectId,
	navigationCurrentProjectId,
	projectName,
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
	useReviewReadyNotifications({
		activeProjectId: navigationCurrentProjectId,
		latestTaskReadyForReview,
		projectName,
	});

	const trashTaskIdSet = useMemo(() => new Set(findTrashTaskIds(board)), [board]);

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
