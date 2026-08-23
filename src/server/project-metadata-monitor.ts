import pLimit from "p-limit";

import type { DiagnosticCaptureScope, RuntimeBoardData, RuntimeProjectMetadata } from "../core";
import {
	ProjectMetadataController,
	type ProjectMetadataControllerDiagnosticSnapshot,
} from "./project-metadata-controller";
import type { ProjectMetadataRemoteFetchResult } from "./project-metadata-remote-fetch";

const GLOBAL_METADATA_PROBE_CONCURRENCY_LIMIT = 4;
const PROJECT_METADATA_PROBE_CONCURRENCY_LIMIT = 2;

export interface CreateProjectMetadataMonitorDependencies {
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	onRemoteFetchCompleted?: (projectId: string, result: ProjectMetadataRemoteFetchResult) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
}

interface MetadataProbeLimitDiagnosticSnapshot {
	activeCount: number;
	pendingCount: number;
	concurrency: number;
}

export interface ProjectMetadataMonitorDiagnosticSnapshot {
	globalProbeLimit: MetadataProbeLimitDiagnosticSnapshot;
	projects: Array<ProjectMetadataControllerDiagnosticSnapshot & { probeLimit: MetadataProbeLimitDiagnosticSnapshot }>;
}

export interface ProjectMetadataMonitor {
	connectProject: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
		clientId?: string | null;
		isDocumentVisible?: boolean;
	}) => Promise<RuntimeProjectMetadata>;
	updateProjectState: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeProjectMetadata>;
	setFocusedTask: (projectId: string, taskId: string | null) => void;
	setDocumentVisible: (projectId: string, clientId: string | null | undefined, isDocumentVisible: boolean) => void;
	requestTaskRefresh: (projectId: string, taskId: string) => void;
	requestHomeRefresh: (projectId: string) => void;
	disconnectProject: (projectId: string, clientId?: string | null) => void;
	disposeProject: (projectId: string) => void;
	getDiagnosticSnapshot: (scope?: Readonly<DiagnosticCaptureScope>) => ProjectMetadataMonitorDiagnosticSnapshot;
	close: () => void;
}

export function createProjectMetadataMonitor(deps: CreateProjectMetadataMonitorDependencies): ProjectMetadataMonitor {
	const projects = new Map<string, ProjectMetadataController>();
	const globalMetadataProbeLimit = pLimit(GLOBAL_METADATA_PROBE_CONCURRENCY_LIMIT);
	const projectMetadataProbeLimits = new Map<string, ReturnType<typeof pLimit>>();

	const getProjectMetadataProbeLimit = (projectId: string): ReturnType<typeof pLimit> => {
		const existing = projectMetadataProbeLimits.get(projectId);
		if (existing) {
			return existing;
		}
		const next = pLimit(PROJECT_METADATA_PROBE_CONCURRENCY_LIMIT);
		projectMetadataProbeLimits.set(projectId, next);
		return next;
	};

	const limitProjectMetadataProbe = async <T>(projectId: string, probe: () => Promise<T>): Promise<T> => {
		const projectLimit = getProjectMetadataProbeLimit(projectId);
		return await projectLimit(async () => {
			return await globalMetadataProbeLimit(probe);
		});
	};

	const getOrCreateController = (projectId: string, projectPath: string): ProjectMetadataController => {
		const existing = projects.get(projectId);
		if (existing) {
			return existing;
		}
		const controller = new ProjectMetadataController({
			projectId,
			projectPath,
			limitMetadataProbe: async <T>(probe: () => Promise<T>) => {
				return await limitProjectMetadataProbe(projectId, probe);
			},
			limitTaskProbe: async <T>(probe: () => Promise<T>) => {
				return await limitProjectMetadataProbe(projectId, probe);
			},
			onMetadataUpdated: deps.onMetadataUpdated,
			onTaskBaseRefChanged: deps.onTaskBaseRefChanged,
			onRemoteFetchCompleted: deps.onRemoteFetchCompleted,
			getProjectDefaultBaseRef: deps.getProjectDefaultBaseRef,
		});
		projects.set(projectId, controller);
		return controller;
	};

	return {
		connectProject: async ({ projectId, projectPath, board, clientId, isDocumentVisible }) => {
			const controller = getOrCreateController(projectId, projectPath);
			return await controller.connect({ projectPath, board, clientId, isDocumentVisible });
		},
		updateProjectState: async ({ projectId, projectPath, board }) => {
			const controller = getOrCreateController(projectId, projectPath);
			return await controller.updateProjectState({ projectPath, board });
		},
		setFocusedTask: (projectId, taskId) => {
			projects.get(projectId)?.setFocusedTask(taskId);
		},
		setDocumentVisible: (projectId, clientId, isDocumentVisible) => {
			projects.get(projectId)?.setDocumentVisible(clientId, isDocumentVisible);
		},
		requestTaskRefresh: (projectId, taskId) => {
			projects.get(projectId)?.requestTaskRefresh(taskId);
		},
		requestHomeRefresh: (projectId) => {
			projects.get(projectId)?.requestHomeRefresh();
		},
		disconnectProject: (projectId, clientId) => {
			const controller = projects.get(projectId);
			if (!controller) {
				return;
			}
			if (controller.disconnect(clientId)) {
				projects.delete(projectId);
				projectMetadataProbeLimits.delete(projectId);
			}
		},
		disposeProject: (projectId) => {
			const controller = projects.get(projectId);
			if (!controller) {
				return;
			}
			controller.dispose();
			projects.delete(projectId);
			projectMetadataProbeLimits.delete(projectId);
		},
		getDiagnosticSnapshot: (scope = {}) => {
			const scopedProjects = Array.from(projects.entries()).flatMap(([projectId, controller]) => {
				if (scope.projectId && projectId !== scope.projectId) return [];
				const projectLimit = projectMetadataProbeLimits.get(projectId);
				const snapshot = controller.getDiagnosticSnapshot();
				if (scope.taskId && !scope.projectId && snapshot.focusedTaskId !== scope.taskId) return [];
				return [
					{
						...snapshot,
						focusedTaskId:
							!scope.taskId || snapshot.focusedTaskId === scope.taskId ? snapshot.focusedTaskId : null,
						probeLimit: {
							activeCount: projectLimit?.activeCount ?? 0,
							pendingCount: projectLimit?.pendingCount ?? 0,
							concurrency: PROJECT_METADATA_PROBE_CONCURRENCY_LIMIT,
						},
					},
				];
			});
			const scopedProbeCounts = scopedProjects.reduce(
				(counts, project) => ({
					activeCount: counts.activeCount + project.probeLimit.activeCount,
					pendingCount: counts.pendingCount + project.probeLimit.pendingCount,
				}),
				{ activeCount: 0, pendingCount: 0 },
			);
			return {
				globalProbeLimit: {
					activeCount:
						scope.projectId || scope.taskId
							? scopedProbeCounts.activeCount
							: globalMetadataProbeLimit.activeCount,
					pendingCount:
						scope.projectId || scope.taskId
							? scopedProbeCounts.pendingCount
							: globalMetadataProbeLimit.pendingCount,
					concurrency: GLOBAL_METADATA_PROBE_CONCURRENCY_LIMIT,
				},
				projects: scopedProjects,
			};
		},
		close: () => {
			for (const controller of projects.values()) {
				controller.dispose();
			}
			projects.clear();
			projectMetadataProbeLimits.clear();
		},
	};
}
