import { pruneOrphanSessionsForNotification } from "@runtime-task-state";
import type { RuntimeProjectStateResponse, RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import { mergeTaskSessionSummaryMap } from "@/utils/session-summary-utils";

export interface RuntimeProjectNotificationState {
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

export type RuntimeProjectNotificationStateMap = Record<string, RuntimeProjectNotificationState>;

function mergeProjectSessions(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	summaries: readonly RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return currentSessions;
	}
	return mergeTaskSessionSummaryMap(currentSessions, summaries);
}

function selectActionableProjectStateSummaries(projectState: RuntimeProjectStateResponse): RuntimeTaskSessionSummary[] {
	return Object.values(pruneOrphanSessionsForNotification(projectState.sessions ?? {}, projectState.board));
}

function replaceProjectSessions(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string,
	summaries: readonly RuntimeTaskSessionSummary[],
): RuntimeProjectNotificationStateMap {
	const remainingProjects = { ...currentProjects };
	delete remainingProjects[projectId];
	if (summaries.length === 0) {
		return remainingProjects;
	}

	return {
		...remainingProjects,
		[projectId]: {
			sessions: Object.fromEntries(summaries.map((summary) => [summary.taskId, summary])),
		},
	};
}

export function mergeRuntimeProjectNotificationStateMap(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string,
	summaries: readonly RuntimeTaskSessionSummary[],
): RuntimeProjectNotificationStateMap {
	if (summaries.length === 0) {
		return currentProjects;
	}

	return {
		...currentProjects,
		[projectId]: {
			sessions: mergeProjectSessions(currentProjects[projectId]?.sessions ?? {}, summaries),
		},
	};
}

export function applyRuntimeProjectNotificationDelta(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string,
	summaries: readonly RuntimeTaskSessionSummary[],
	removedTaskIds: readonly string[] = [],
): RuntimeProjectNotificationStateMap {
	if (summaries.length === 0 && removedTaskIds.length === 0) {
		return currentProjects;
	}

	let nextProjects = currentProjects;
	if (removedTaskIds.length > 0) {
		const existingProject = nextProjects[projectId];
		if (existingProject) {
			const removedTaskIdSet = new Set(removedTaskIds);
			const nextSessions = Object.fromEntries(
				Object.entries(existingProject.sessions).filter(([taskId]) => !removedTaskIdSet.has(taskId)),
			);
			nextProjects = replaceProjectSessions(nextProjects, projectId, Object.values(nextSessions));
		}
	}
	return mergeRuntimeProjectNotificationStateMap(nextProjects, projectId, summaries);
}

export function replaceRuntimeProjectNotificationStateMap(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string,
	summaries: readonly RuntimeTaskSessionSummary[],
): RuntimeProjectNotificationStateMap {
	return replaceProjectSessions(currentProjects, projectId, summaries);
}

export function seedRuntimeProjectNotificationStateMapFromProjectState(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string | null,
	projectState: RuntimeProjectStateResponse | null,
): RuntimeProjectNotificationStateMap {
	if (!projectId || !projectState) {
		return currentProjects;
	}

	return mergeRuntimeProjectNotificationStateMap(
		currentProjects,
		projectId,
		selectActionableProjectStateSummaries(projectState),
	);
}

export function pruneRuntimeProjectNotificationStateMap(
	currentProjects: RuntimeProjectNotificationStateMap,
	projects: readonly RuntimeProjectSummary[],
): RuntimeProjectNotificationStateMap {
	const validProjectIds = new Set(projects.map((project) => project.id));
	const nextEntries = Object.entries(currentProjects).filter(([projectId]) => validProjectIds.has(projectId));

	if (nextEntries.length === Object.keys(currentProjects).length) {
		return currentProjects;
	}

	return Object.fromEntries(nextEntries);
}
