import {
	applyRuntimeProjectNotificationDelta,
	pruneRuntimeProjectNotificationStateMap,
	type RuntimeProjectNotificationStateMap,
	replaceRuntimeProjectNotificationStateMap,
	seedRuntimeProjectNotificationStateMapFromProjectState,
} from "@/runtime/runtime-notification-projects";
import type {
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamSnapshotMessage,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

export interface RuntimeNotificationMemory {
	projects: RuntimeProjectNotificationStateMap;
	revisionsByProject: Record<string, number>;
}

export interface RuntimeNotificationDelta {
	projectId: string;
	notificationRevision: number;
	summaries: readonly RuntimeTaskSessionSummary[];
	removedTaskIds?: readonly string[];
	replace?: boolean;
}

export function createRuntimeNotificationMemory(): RuntimeNotificationMemory {
	return {
		projects: {},
		revisionsByProject: {},
	};
}

/** Resets connection-local ordering without discarding the last visible projection. */
export function resetRuntimeNotificationOrdering(memory: RuntimeNotificationMemory): RuntimeNotificationMemory {
	if (Object.keys(memory.revisionsByProject).length === 0) {
		return memory;
	}
	return {
		...memory,
		revisionsByProject: {},
	};
}

/** Applies one project delta only when it is not older than the current project fence. */
export function applyRuntimeNotificationDelta(
	memory: RuntimeNotificationMemory,
	delta: RuntimeNotificationDelta,
): RuntimeNotificationMemory {
	const currentRevision = memory.revisionsByProject[delta.projectId] ?? 0;
	if (delta.notificationRevision < currentRevision) {
		return memory;
	}

	const removedTaskIds = delta.removedTaskIds ?? [];
	const hasSessionChanges = delta.summaries.length > 0 || removedTaskIds.length > 0;
	let projects = memory.projects;
	if (delta.replace) {
		projects = replaceRuntimeProjectNotificationStateMap(memory.projects, delta.projectId, delta.summaries);
	} else if (hasSessionChanges) {
		projects = applyRuntimeProjectNotificationDelta(
			memory.projects,
			delta.projectId,
			delta.summaries,
			removedTaskIds,
		);
	}

	if (projects === memory.projects && delta.notificationRevision === currentRevision) {
		return memory;
	}
	return {
		projects,
		revisionsByProject: {
			...memory.revisionsByProject,
			[delta.projectId]: delta.notificationRevision,
		},
	};
}

/** Adds a preload hint without replacing an already versioned notification bucket. */
export function seedRuntimeNotificationMemoryFromProjectState(
	memory: RuntimeNotificationMemory,
	projectId: string | null,
	projectState: RuntimeProjectStateResponse | null,
): RuntimeNotificationMemory {
	const projects = seedRuntimeProjectNotificationStateMapFromProjectState(memory.projects, projectId, projectState);
	return projects === memory.projects ? memory : { ...memory, projects };
}

/** Replaces each project bucket using the snapshot's matching ordering fence. */
export function replaceRuntimeNotificationMemoryFromSnapshot(
	memory: RuntimeNotificationMemory,
	projects: readonly RuntimeProjectSummary[],
	summariesByProject: RuntimeStateStreamSnapshotMessage["notificationSummariesByProject"],
	revisionsByProject: RuntimeStateStreamSnapshotMessage["notificationRevisionsByProject"],
): RuntimeNotificationMemory {
	return projects.reduce(
		(current, project) =>
			applyRuntimeNotificationDelta(current, {
				projectId: project.id,
				notificationRevision: revisionsByProject?.[project.id] ?? 0,
				summaries: summariesByProject?.[project.id] ?? [],
				replace: true,
			}),
		memory,
	);
}

export function pruneRuntimeNotificationMemory(
	memory: RuntimeNotificationMemory,
	projects: readonly RuntimeProjectSummary[],
): RuntimeNotificationMemory {
	const projectIds = new Set(projects.map((project) => project.id));
	return {
		projects: pruneRuntimeProjectNotificationStateMap(memory.projects, projects),
		revisionsByProject: Object.fromEntries(
			Object.entries(memory.revisionsByProject).filter(([projectId]) => projectIds.has(projectId)),
		),
	};
}
