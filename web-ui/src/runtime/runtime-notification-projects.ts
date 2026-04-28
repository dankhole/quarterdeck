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

function collectProjectStateBoardTaskIds(projectState: RuntimeProjectStateResponse): Set<string> {
	const taskIds = new Set<string>();
	for (const column of projectState.board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function selectBoardLinkedProjectStateSummaries(
	projectState: RuntimeProjectStateResponse,
): RuntimeTaskSessionSummary[] {
	const boardTaskIds = collectProjectStateBoardTaskIds(projectState);
	return Object.values(projectState.sessions ?? {}).filter((summary) => boardTaskIds.has(summary.taskId));
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
		Object.values(projectState.sessions ?? {}),
	);
}

export function replaceRuntimeProjectNotificationStateMapFromProjectState(
	currentProjects: RuntimeProjectNotificationStateMap,
	projectId: string | null,
	projectState: RuntimeProjectStateResponse | null,
): RuntimeProjectNotificationStateMap {
	if (!projectId || !projectState) {
		return currentProjects;
	}

	return replaceRuntimeProjectNotificationStateMap(
		currentProjects,
		projectId,
		selectBoardLinkedProjectStateSummaries(projectState),
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

export function replaceRuntimeProjectNotificationStateMapFromProjectSummaries(
	currentProjects: RuntimeProjectNotificationStateMap,
	projects: readonly RuntimeProjectSummary[],
	summariesByProject: RuntimeProjectNotificationSummariesByProject | null | undefined,
): RuntimeProjectNotificationStateMap {
	let nextProjects = currentProjects;
	for (const project of projects) {
		nextProjects = replaceRuntimeProjectNotificationStateMap(
			nextProjects,
			project.id,
			summariesByProject?.[project.id] ?? [],
		);
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
