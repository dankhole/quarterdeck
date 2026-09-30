import { useCallback, useState } from "react";
import type { RuntimeProjectSummary } from "@/runtime/types";

interface UseProjectNavigationPanelInput {
	projects: RuntimeProjectSummary[];
	removingProjectId: string | null;
	onRemoveProject: (projectId: string) => Promise<boolean>;
}

export interface UseProjectNavigationPanelResult {
	pendingProjectRemoval: RuntimeProjectSummary | null;
	pendingProjectTaskCount: number;
	isProjectRemovalPending: boolean;
	requestProjectRemoval: (projectId: string) => void;
	closeProjectRemovalDialog: () => void;
	confirmProjectRemoval: () => Promise<void>;
}

export function useProjectNavigationPanel({
	projects,
	removingProjectId,
	onRemoveProject,
}: UseProjectNavigationPanelInput): UseProjectNavigationPanelResult {
	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);

	const requestProjectRemoval = useCallback(
		(projectId: string) => {
			const project = projects.find((item) => item.id === projectId) ?? null;
			setPendingProjectRemoval(project);
		},
		[projects],
	);

	const isProjectRemovalPending = pendingProjectRemoval !== null && removingProjectId === pendingProjectRemoval.id;

	const closeProjectRemovalDialog = useCallback(() => {
		if (!isProjectRemovalPending) {
			setPendingProjectRemoval(null);
		}
	}, [isProjectRemovalPending]);

	const confirmProjectRemoval = useCallback(async () => {
		if (!pendingProjectRemoval) {
			return;
		}
		const removed = await onRemoveProject(pendingProjectRemoval.id);
		if (removed) {
			setPendingProjectRemoval(null);
		}
	}, [onRemoveProject, pendingProjectRemoval]);

	const pendingProjectTaskCount = pendingProjectRemoval
		? pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	return {
		pendingProjectRemoval,
		pendingProjectTaskCount,
		isProjectRemovalPending,
		requestProjectRemoval,
		closeProjectRemovalDialog,
		confirmProjectRemoval,
	};
}
