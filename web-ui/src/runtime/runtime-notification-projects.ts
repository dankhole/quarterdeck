import type { RuntimeProjectStateResponse, RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import { mergeTaskSessionSummaryMap } from "@/utils/session-summary-utils";

export interface RuntimeProjectNotificationState {
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

export type RuntimeProjectNotificationStateMap = Record<string, RuntimeProjectNotificationState>;
export type RuntimeProjectNotificationSummariesByProject = Record<string, readonly RuntimeTaskSessionSummary[]>;

function mergeProjectSessions(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	summaries: readonly RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return currentSessions;
	}
	return mergeTaskSessionSummaryMap(currentSessions, summaries);
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
		Object.values(projectState.sessions ?? {}),
	);
}

export function seedRuntimeProjectNotificationStateMapFromProjectSummaries(
	currentProjects: RuntimeProjectNotificationStateMap,
	summariesByProject: RuntimeProjectNotificationSummariesByProject | null | undefined,
): RuntimeProjectNotificationStateMap {
	if (!summariesByProject) {
		return currentProjects;
	}

	let nextProjects = currentProjects;
	for (const [projectId, summaries] of Object.entries(summariesByProject)) {
		nextProjects = mergeRuntimeProjectNotificationStateMap(nextProjects, projectId, summaries);
	}
	return nextProjects;
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
