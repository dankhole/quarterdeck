import type { DropResult } from "@hello-pangea/dnd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import { isApprovalState } from "@/utils/session-status";

interface UseProjectNavigationPanelInput {
	projects: RuntimeProjectSummary[];
	removingProjectId: string | null;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onReorderProjects?: (projectOrder: string[]) => Promise<void>;
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	notificationWorkspaceIds: Record<string, string>;
}

export interface UseProjectNavigationPanelResult {
	canReorder: boolean;
	displayedProjects: RuntimeProjectSummary[];
	needsInputByProject: Record<string, number>;
	pendingProjectRemoval: RuntimeProjectSummary | null;
	pendingProjectTaskCount: number;
	isProjectRemovalPending: boolean;
	requestProjectRemoval: (projectId: string) => void;
	closeProjectRemovalDialog: () => void;
	confirmProjectRemoval: () => Promise<void>;
	handleDragEnd: (result: DropResult) => void;
}

export function useProjectNavigationPanel({
	projects,
	removingProjectId,
	onRemoveProject,
	onReorderProjects,
	notificationSessions,
	notificationWorkspaceIds,
}: UseProjectNavigationPanelInput): UseProjectNavigationPanelResult {
	const canReorder = projects.length > 1 && onReorderProjects !== undefined;
	const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);
	const previousProjectIdsRef = useRef("");
	const projectIdsSignature = useMemo(() => projects.map((project) => project.id).join(","), [projects]);

	const needsInputByProject = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const [taskId, session] of Object.entries(notificationSessions)) {
			if (!isApprovalState(session)) {
				continue;
			}
			const projectId = notificationWorkspaceIds[taskId];
			if (projectId) {
				counts[projectId] = (counts[projectId] ?? 0) + 1;
			}
		}
		return counts;
	}, [notificationSessions, notificationWorkspaceIds]);

	useEffect(() => {
		if (optimisticOrder && previousProjectIdsRef.current !== projectIdsSignature) {
			setOptimisticOrder(null);
		}
		previousProjectIdsRef.current = projectIdsSignature;
	}, [optimisticOrder, projectIdsSignature]);

	const displayedProjects = useMemo(() => {
		if (!optimisticOrder) {
			return projects;
		}
		const projectsById = new Map(projects.map((project) => [project.id, project]));
		const orderedProjects: RuntimeProjectSummary[] = [];
		for (const projectId of optimisticOrder) {
			const project = projectsById.get(projectId);
			if (project) {
				orderedProjects.push(project);
			}
		}
		for (const project of projects) {
			if (!optimisticOrder.includes(project.id)) {
				orderedProjects.push(project);
			}
		}
		return orderedProjects;
	}, [optimisticOrder, projects]);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			if (!result.destination || result.source.index === result.destination.index || !onReorderProjects) {
				return;
			}
			const reorderedProjects = Array.from(displayedProjects);
			const [movedProject] = reorderedProjects.splice(result.source.index, 1);
			if (movedProject === undefined) {
				return;
			}
			reorderedProjects.splice(result.destination.index, 0, movedProject);
			const nextOrder = reorderedProjects.map((project) => project.id);
			previousProjectIdsRef.current = projectIdsSignature;
			setOptimisticOrder(nextOrder);
			void onReorderProjects(nextOrder);
		},
		[displayedProjects, onReorderProjects, projectIdsSignature],
	);

	const requestProjectRemoval = useCallback(
		(projectId: string) => {
			const project = displayedProjects.find((item) => item.id === projectId) ?? null;
			setPendingProjectRemoval(project);
		},
		[displayedProjects],
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
		? pendingProjectRemoval.taskCounts.backlog +
			pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	return {
		canReorder,
		displayedProjects,
		needsInputByProject,
		pendingProjectRemoval,
		pendingProjectTaskCount,
		isProjectRemovalPending,
		requestProjectRemoval,
		closeProjectRemovalDialog,
		confirmProjectRemoval,
		handleDragEnd,
	};
}
