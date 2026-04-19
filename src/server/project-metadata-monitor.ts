import pLimit from "p-limit";

import type { RuntimeBoardData, RuntimeProjectMetadata } from "../core";
import { ProjectMetadataController } from "./project-metadata-controller";

export type { ProjectMetadataPollIntervals } from "./project-metadata-loaders";

const GIT_PROBE_CONCURRENCY_LIMIT = 3;

export interface CreateProjectMetadataMonitorDependencies {
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
}

export interface ProjectMetadataMonitor {
	connectProject: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
		pollIntervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number };
	}) => Promise<RuntimeProjectMetadata>;
	updateProjectState: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeProjectMetadata>;
	setFocusedTask: (projectId: string, taskId: string | null) => void;
	requestTaskRefresh: (projectId: string, taskId: string) => void;
	requestHomeRefresh: (projectId: string) => void;
	setPollIntervals: (
		projectId: string,
		intervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number },
	) => void;
	disconnectProject: (projectId: string) => void;
	disposeProject: (projectId: string) => void;
	close: () => void;
}

export function createProjectMetadataMonitor(deps: CreateProjectMetadataMonitorDependencies): ProjectMetadataMonitor {
	const projects = new Map<string, ProjectMetadataController>();
	const taskProbeLimit = pLimit(GIT_PROBE_CONCURRENCY_LIMIT);

	const getOrCreateController = (projectId: string, projectPath: string): ProjectMetadataController => {
		const existing = projects.get(projectId);
		if (existing) {
			return existing;
		}
		const controller = new ProjectMetadataController({
			projectId,
			projectPath,
			limitTaskProbe: async <T>(probe: () => Promise<T>) => {
				return await taskProbeLimit(probe);
			},
			onMetadataUpdated: deps.onMetadataUpdated,
			onTaskBaseRefChanged: deps.onTaskBaseRefChanged,
			getProjectDefaultBaseRef: deps.getProjectDefaultBaseRef,
		});
		projects.set(projectId, controller);
		return controller;
	};

	return {
		connectProject: async ({ projectId, projectPath, board, pollIntervals }) => {
			const controller = getOrCreateController(projectId, projectPath);
			return await controller.connect({ projectPath, board, pollIntervals });
		},
		updateProjectState: async ({ projectId, projectPath, board }) => {
			const controller = getOrCreateController(projectId, projectPath);
			return await controller.updateProjectState({ projectPath, board });
		},
		setFocusedTask: (projectId, taskId) => {
			projects.get(projectId)?.setFocusedTask(taskId);
		},
		requestTaskRefresh: (projectId, taskId) => {
			projects.get(projectId)?.requestTaskRefresh(taskId);
		},
		requestHomeRefresh: (projectId) => {
			projects.get(projectId)?.requestHomeRefresh();
		},
		setPollIntervals: (projectId, intervals) => {
			projects.get(projectId)?.setPollIntervals(intervals);
		},
		disconnectProject: (projectId) => {
			const controller = projects.get(projectId);
			if (!controller) {
				return;
			}
			if (controller.disconnect()) {
				projects.delete(projectId);
			}
		},
		disposeProject: (projectId) => {
			const controller = projects.get(projectId);
			if (!controller) {
				return;
			}
			controller.dispose();
			projects.delete(projectId);
		},
		close: () => {
			for (const controller of projects.values()) {
				controller.dispose();
			}
			projects.clear();
		},
	};
}
