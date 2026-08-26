import { deriveTaskIndicatorState } from "@runtime-contract";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export interface FlattenedProjectNotificationTask {
	projectId: string;
	taskId: string;
	summary: RuntimeTaskSessionSummary;
}

export interface ProjectNotificationProjection {
	needsInputByProject: Record<string, number>;
	currentProjectHasNeedsInput: boolean;
	otherProjectsHaveNeedsInput: boolean;
}

/** Collision-safe identity for state that spans more than one project. */
export function createProjectTaskNotificationKey(projectId: string, taskId: string): string {
	return JSON.stringify([projectId, taskId]);
}

export function flattenProjectNotificationTasks(
	notificationProjects: RuntimeProjectNotificationStateMap,
): Record<string, FlattenedProjectNotificationTask> {
	const flattened: Record<string, FlattenedProjectNotificationTask> = {};

	for (const [projectId, projectState] of Object.entries(notificationProjects)) {
		for (const [taskId, summary] of Object.entries(projectState.sessions)) {
			flattened[createProjectTaskNotificationKey(projectId, taskId)] = {
				projectId,
				taskId,
				summary,
			};
		}
	}

	return flattened;
}

export function buildProjectNotificationProjection(
	notificationProjects: RuntimeProjectNotificationStateMap,
	currentProjectId: string | null,
): ProjectNotificationProjection {
	const needsInputByProject: Record<string, number> = {};
	let currentProjectHasNeedsInput = false;
	let otherProjectsHaveNeedsInput = false;

	for (const [projectId, projectState] of Object.entries(notificationProjects)) {
		for (const summary of Object.values(projectState.sessions)) {
			if (!deriveTaskIndicatorState(summary).needsInput) {
				continue;
			}

			needsInputByProject[projectId] = (needsInputByProject[projectId] ?? 0) + 1;
			if (projectId === currentProjectId) {
				currentProjectHasNeedsInput = true;
			} else {
				otherProjectsHaveNeedsInput = true;
			}
		}
	}

	return {
		needsInputByProject,
		currentProjectHasNeedsInput,
		otherProjectsHaveNeedsInput,
	};
}
