import pLimit from "p-limit";
import type { DiagnosticCaptureScope, RuntimeBoardData, RuntimeProjectMetadata } from "../core";
import {
	ProjectMetadataController,
	type ProjectMetadataControllerDiagnosticSnapshot,
} from "./project-metadata-controller";
import { createEmptyProjectMetadata } from "./project-metadata-entry";
import type { ProjectMetadataRemoteFetchResult } from "./project-metadata-remote-fetch";
import {
	connectProjectMetadataClient,
	disconnectProjectMetadataClient,
	type ProjectMetadataVisibilityReports,
	setProjectMetadataClientVisibility,
} from "./project-metadata-visibility";

const GLOBAL_METADATA_PROBE_CONCURRENCY_LIMIT = 4;
const PROJECT_METADATA_PROBE_CONCURRENCY_LIMIT = 2;
/**
 * How long a project's controller (and its cached home/task Git metadata) is
 * retained after the last client disconnects, with polling stopped. A
 * reconnect inside this window reuses the retained controller and serves its
 * cache immediately instead of re-probing from empty. Set to 0 to restore the
 * previous immediate-retirement behavior.
 */
export const PROJECT_METADATA_IDLE_RETIREMENT_GRACE_MS = 10 * 60_000;

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
		folderOnly?: boolean;
		metadataRevision?: number;
		available?: boolean;
		clientId?: string | null;
		isDocumentVisible?: boolean;
	}) => Promise<RuntimeProjectMetadata>;
	updateProjectState: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
		folderOnly?: boolean;
		metadataRevision?: number;
		available?: boolean;
	}) => Promise<RuntimeProjectMetadata>;
	setFocusedTask: (projectId: string, taskId: string | null) => void;
	setDocumentVisible: (projectId: string, clientId: string | null | undefined, isDocumentVisible: boolean) => void;
	requestTaskRefresh: (projectId: string, taskId: string) => void;
	requestHomeRefresh: (projectId: string) => void;
	disconnectProject: (projectId: string, clientId?: string | null) => void;
	disposeProject: (projectId: string) => void;
	/**
	 * Immediately drops a project's retained controller/cache (home + task
	 * worktree Git metadata) and cancels its queued probes and any pending
	 * idle-grace retirement timer. Call this when a project relocates or is
	 * removed: the grace-retained cache holds worktree paths that become
	 * wrong once the project's location changes, so it must not be served to
	 * a later reconnect. Safe to call whether or not the project currently
	 * has connected clients.
	 */
	purgeProject: (projectId: string) => void;
	suspendProject: (projectId: string) => Promise<void>;
	getDiagnosticSnapshot: (scope?: Readonly<DiagnosticCaptureScope>) => ProjectMetadataMonitorDiagnosticSnapshot;
	close: () => void;
}

export function createProjectMetadataMonitor(deps: CreateProjectMetadataMonitorDependencies): ProjectMetadataMonitor {
	const projects = new Map<string, ProjectMetadataController>();
	const projectScopes = new Map<string, { path: string; revision: number }>();
	const retiringControllers = new Map<string, Set<Promise<void>>>();
	const clients = new Map<string, ProjectMetadataVisibilityReports>();
	const globalMetadataProbeLimit = pLimit(GLOBAL_METADATA_PROBE_CONCURRENCY_LIMIT);
	const projectMetadataProbeLimits = new Map<string, ReturnType<typeof pLimit>>();
	const idleRetirementTimers = new Map<string, NodeJS.Timeout>();

	const cancelScheduledIdleRetirement = (projectId: string): void => {
		const timer = idleRetirementTimers.get(projectId);
		if (!timer) return;
		clearTimeout(timer);
		idleRetirementTimers.delete(projectId);
	};

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

	const retireController = (projectId: string): void => {
		// Cancel any pending idle-grace timer unconditionally: a controller can
		// be retired through this function via several paths (explicit
		// suspend/dispose/purge, or a path/revision scope change), and a stale
		// timer left running must never later retire a *replacement* controller
		// created for the same project ID.
		cancelScheduledIdleRetirement(projectId);
		const controller = projects.get(projectId);
		if (!controller) return;
		controller.dispose();
		projects.delete(projectId);
		projectScopes.delete(projectId);
		const pending = retiringControllers.get(projectId) ?? new Set<Promise<void>>();
		retiringControllers.set(projectId, pending);
		const drained = controller.waitForIdle().finally(() => {
			pending.delete(drained);
			if (pending.size === 0 && retiringControllers.get(projectId) === pending)
				retiringControllers.delete(projectId);
		});
		pending.add(drained);
	};

	const suspendProject = async (projectId: string): Promise<void> => {
		retireController(projectId);
		await Promise.allSettled(Array.from(retiringControllers.get(projectId) ?? []));
		projectMetadataProbeLimits.delete(projectId);
	};

	/** Immediately and fully tears down a project's controller, cache, and queued probes. */
	const purgeProjectState = (projectId: string): void => {
		cancelScheduledIdleRetirement(projectId);
		clients.delete(projectId);
		retireController(projectId);
		projectMetadataProbeLimits.delete(projectId);
	};

	/**
	 * Keeps the controller (and its cached home/task Git metadata) alive for a
	 * grace window after the last client disconnects, with polling already
	 * stopped by `controller.disconnect`. A reconnect before the timer fires
	 * cancels it via `cancelScheduledIdleRetirement` and reuses the retained
	 * controller; if it fires, this is the same teardown `disconnectProject`
	 * used to run immediately.
	 */
	const scheduleIdleRetirement = (projectId: string): void => {
		cancelScheduledIdleRetirement(projectId);
		if (PROJECT_METADATA_IDLE_RETIREMENT_GRACE_MS <= 0) {
			retireController(projectId);
			projectMetadataProbeLimits.delete(projectId);
			return;
		}
		const timer = setTimeout(() => {
			idleRetirementTimers.delete(projectId);
			retireController(projectId);
			projectMetadataProbeLimits.delete(projectId);
		}, PROJECT_METADATA_IDLE_RETIREMENT_GRACE_MS);
		timer.unref();
		idleRetirementTimers.set(projectId, timer);
	};

	const getOrCreateController = (
		projectId: string,
		projectPath: string,
		metadataRevision = 0,
	): ProjectMetadataController => {
		const existing = projects.get(projectId);
		const scope = projectScopes.get(projectId);
		if (existing && scope?.path === projectPath && scope.revision === metadataRevision) {
			return existing;
		}
		retireController(projectId);
		const controller = new ProjectMetadataController({
			projectId,
			projectPath,
			limitMetadataProbe: async <T>(probe: () => Promise<T>) => {
				return await limitProjectMetadataProbe(projectId, probe);
			},
			limitTaskProbe: async <T>(probe: () => Promise<T>) => {
				return await limitProjectMetadataProbe(projectId, probe);
			},
			onMetadataUpdated: (id, metadata) => {
				if (projects.get(id) === controller) deps.onMetadataUpdated(id, { ...metadata, metadataRevision });
			},
			onTaskBaseRefChanged: (id, taskId, baseRef) => {
				if (projects.get(id) === controller) deps.onTaskBaseRefChanged?.(id, taskId, baseRef);
			},
			onRemoteFetchCompleted: (id, result) => {
				if (projects.get(id) === controller) deps.onRemoteFetchCompleted?.(id, result);
			},
			getProjectDefaultBaseRef: deps.getProjectDefaultBaseRef,
		});
		projects.set(projectId, controller);
		projectScopes.set(projectId, { path: projectPath, revision: metadataRevision });
		return controller;
	};

	const folderMetadata = (projectId: string, folderOnly?: boolean, metadataRevision = 0) => {
		if (!folderOnly) return null;
		retireController(projectId);
		projectMetadataProbeLimits.delete(projectId);
		const metadata = { ...createEmptyProjectMetadata(), metadataRevision };
		deps.onMetadataUpdated(projectId, metadata);
		return metadata;
	};
	const restoreClientConnections = (
		controller: ProjectMetadataController,
		projectId: string,
		projectPath: string,
		board: RuntimeBoardData,
	): Promise<RuntimeProjectMetadata>[] => {
		// Restore all counts before yielding: a disconnect during a refresh
		// must never be followed by another connect.
		const connections: Promise<RuntimeProjectMetadata>[] = [];
		for (const [clientId, report] of clients.get(projectId) ?? []) {
			for (let connection = 0; connection < report.activeConnectionCount; connection++) {
				connections.push(
					controller.connect({ projectPath, board, clientId, isDocumentVisible: report.isDocumentVisible }),
				);
			}
		}
		return connections;
	};
	return {
		connectProject: async ({
			projectId,
			projectPath,
			board,
			clientId,
			isDocumentVisible,
			folderOnly,
			metadataRevision,
			available = true,
		}) => {
			// Any connect means the project is active again: a retained idle
			// controller must not retire out from under this reconnect.
			cancelScheduledIdleRetirement(projectId);
			const reports = clients.get(projectId) ?? new Map();
			clients.set(projectId, reports);
			connectProjectMetadataClient(reports, clientId, isDocumentVisible);
			if (!available) {
				await suspendProject(projectId);
				return createEmptyProjectMetadata();
			}
			const disabled = folderMetadata(projectId, folderOnly, metadataRevision);
			if (disabled) return disabled;
			const previous = projects.get(projectId);
			const controller = getOrCreateController(projectId, projectPath, metadataRevision);
			if (previous !== controller) {
				const snapshots = await Promise.all(restoreClientConnections(controller, projectId, projectPath, board));
				return snapshots[snapshots.length - 1] ?? createEmptyProjectMetadata();
			}
			return await controller.connect({ projectPath, board, clientId, isDocumentVisible });
		},
		updateProjectState: async ({ projectId, projectPath, board, folderOnly, metadataRevision, available = true }) => {
			// Defensive: the hub only calls updateProjectState while clients are
			// connected, but cancel any pending grace timer anyway so this never
			// races a retirement that was scheduled a moment earlier.
			cancelScheduledIdleRetirement(projectId);
			if (!available) {
				await suspendProject(projectId);
				return createEmptyProjectMetadata();
			}
			const disabled = folderMetadata(projectId, folderOnly, metadataRevision);
			if (disabled) return disabled;
			const previous = projects.get(projectId);
			const controller = getOrCreateController(projectId, projectPath, metadataRevision);
			if (previous !== controller) {
				const connections = restoreClientConnections(controller, projectId, projectPath, board);
				if (connections.length > 0) {
					const snapshots = await Promise.all(connections);
					return snapshots[snapshots.length - 1] ?? createEmptyProjectMetadata();
				}
			}
			return await controller.updateProjectState({ projectPath, board });
		},
		setFocusedTask: (projectId, taskId) => {
			projects.get(projectId)?.setFocusedTask(taskId);
		},
		setDocumentVisible: (projectId, clientId, isDocumentVisible) => {
			const reports = clients.get(projectId);
			if (reports) setProjectMetadataClientVisibility(reports, clientId, isDocumentVisible);
			projects.get(projectId)?.setDocumentVisible(clientId, isDocumentVisible);
		},
		requestTaskRefresh: (projectId, taskId) => {
			projects.get(projectId)?.requestTaskRefresh(taskId);
		},
		requestHomeRefresh: (projectId) => {
			projects.get(projectId)?.requestHomeRefresh();
		},
		disconnectProject: (projectId, clientId) => {
			const reports = clients.get(projectId);
			if (reports) {
				disconnectProjectMetadataClient(reports, clientId);
				if (!reports.size) clients.delete(projectId);
			}
			const controller = projects.get(projectId);
			if (!controller) {
				return;
			}
			if (controller.disconnect(clientId)) {
				// Keep the controller's cached Git metadata warm for a grace
				// window instead of retiring it immediately: a reconnect within
				// that window (e.g. switching back to this project) reuses it
				// and gets the cache delivered immediately. See
				// PROJECT_METADATA_IDLE_RETIREMENT_GRACE_MS.
				scheduleIdleRetirement(projectId);
			}
		},
		disposeProject: purgeProjectState,
		purgeProject: purgeProjectState,
		suspendProject,
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
			clients.clear();
			for (const projectId of projects.keys()) retireController(projectId);
			projectMetadataProbeLimits.clear();
			for (const timer of idleRetirementTimers.values()) clearTimeout(timer);
			idleRetirementTimers.clear();
		},
	};
}
