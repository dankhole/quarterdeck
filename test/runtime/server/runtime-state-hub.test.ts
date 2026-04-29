import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_CONFIG_STATE } from "../../../src/config";
import type {
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeTaskSessionSummary,
} from "../../../src/core";
import type { CreateRuntimeStateHubDependencies } from "../../../src/server";
import { RuntimeStateHubImpl } from "../../../src/server";
import { createBoard } from "../../utilities/board-factory";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

interface InitialSnapshot {
	currentProjectId: string | null;
	projects: RuntimeProjectsResponse["projects"];
	projectId: string | null;
	projectPath: string | null;
	projectState: RuntimeProjectStateResponse | null;
	projectStateError: string | null;
	notificationSummariesByProject: Record<string, RuntimeTaskSessionSummary[]>;
}

interface RuntimeStateHubInternals {
	clients: {
		registerGlobalClient: (client: {
			readyState: number;
			send: (payload: string) => void;
			terminate: () => void;
		}) => void;
	};
	loadInitialSnapshot: (resolved: {
		projectId: string | null;
		projectPath: string | null;
	}) => Promise<InitialSnapshot>;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] | null = null;
	let reject: Deferred<T>["reject"] | null = null;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	if (!resolve || !reject) {
		throw new Error("Failed to create deferred promise.");
	}
	return { promise, resolve, reject };
}

function createProjectsResponse(): RuntimeProjectsResponse {
	return {
		currentProjectId: "project-1",
		projects: [
			{
				id: "project-1",
				path: "/repo",
				name: "repo",
				taskCounts: {
					backlog: 0,
					in_progress: 0,
					review: 0,
					trash: 0,
				},
			},
		],
	};
}

function createProjectStateResponse(): RuntimeProjectStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createBoard("Task"),
		sessions: {},
		revision: 1,
	};
}

function createDependencies(input: {
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<RuntimeProjectsResponse>;
	buildProjectStateSnapshot: (projectId: string, projectPath: string) => Promise<RuntimeProjectStateResponse>;
	listManagedProjects: CreateRuntimeStateHubDependencies["projectRegistry"]["listManagedProjects"];
}): CreateRuntimeStateHubDependencies {
	return {
		projectRegistry: {
			resolveProjectForStream: async () => ({
				projectId: null,
				projectPath: null,
				removedRequestedProjectPath: null,
				didPruneProjects: false,
			}),
			buildProjectsPayload: input.buildProjectsPayload,
			buildProjectStateSnapshot: input.buildProjectStateSnapshot,
			resumeInterruptedSessions: async () => 0,
			getActiveRuntimeConfig: () => DEFAULT_RUNTIME_CONFIG_STATE,
			listManagedProjects: input.listManagedProjects,
		},
	};
}

describe("RuntimeStateHub", () => {
	it("broadcasts log level changes without reseeding recent log entries", async () => {
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
				buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
				listManagedProjects: vi.fn(() => []),
			}),
		);
		const client = {
			readyState: 1,
			send: vi.fn(),
			terminate: vi.fn(),
		};

		try {
			(hub as unknown as RuntimeStateHubInternals).clients.registerGlobalClient(client);

			hub.broadcastLogLevel("error");

			expect(client.send).toHaveBeenCalledOnce();
			const payload = client.send.mock.calls[0]?.[0];
			if (typeof payload !== "string") {
				throw new Error("Expected a JSON websocket payload.");
			}
			expect(JSON.parse(payload)).toEqual({
				type: "debug_logging_state",
				level: "error",
			});
		} finally {
			await hub.close();
		}
	});

	it("starts independent initial snapshot loads before awaiting project state", async () => {
		const projectsDeferred = createDeferred<RuntimeProjectsResponse>();
		const projectStateDeferred = createDeferred<RuntimeProjectStateResponse>();
		const buildProjectsPayload = vi.fn((_preferredCurrentProjectId: string | null) => projectsDeferred.promise);
		const buildProjectStateSnapshot = vi.fn(
			(_projectId: string, _projectPath: string) => projectStateDeferred.promise,
		);
		const listManagedProjects = vi.fn(() => []);
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload,
				buildProjectStateSnapshot,
				listManagedProjects,
			}),
		);

		try {
			const snapshotPromise = (hub as unknown as RuntimeStateHubInternals).loadInitialSnapshot({
				projectId: "project-1",
				projectPath: "/repo",
			});

			await Promise.resolve();

			expect(buildProjectsPayload).toHaveBeenCalledWith("project-1");
			expect(buildProjectStateSnapshot).toHaveBeenCalledWith("project-1", "/repo");
			expect(listManagedProjects).toHaveBeenCalledOnce();

			projectsDeferred.resolve(createProjectsResponse());
			projectStateDeferred.reject(new Error("state failed"));

			const snapshot = await snapshotPromise;
			expect(snapshot.currentProjectId).toBe("project-1");
			expect(snapshot.projects).toEqual(createProjectsResponse().projects);
			expect(snapshot.projectState).toBeNull();
			expect(snapshot.projectStateError).toBe("state failed");
			expect(snapshot.notificationSummariesByProject).toEqual({});
		} finally {
			await hub.close();
		}
	});

	it("loads the project list and notification summaries concurrently when no project is selected", async () => {
		const projectsDeferred = createDeferred<RuntimeProjectsResponse>();
		const buildProjectsPayload = vi.fn((_preferredCurrentProjectId: string | null) => projectsDeferred.promise);
		const buildProjectStateSnapshot = vi.fn(async () => createProjectStateResponse());
		const listManagedProjects = vi.fn(() => []);
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload,
				buildProjectStateSnapshot,
				listManagedProjects,
			}),
		);

		try {
			const snapshotPromise = (hub as unknown as RuntimeStateHubInternals).loadInitialSnapshot({
				projectId: null,
				projectPath: null,
			});

			await Promise.resolve();

			expect(buildProjectsPayload).toHaveBeenCalledWith(null);
			expect(buildProjectStateSnapshot).not.toHaveBeenCalled();
			expect(listManagedProjects).toHaveBeenCalledOnce();

			projectsDeferred.resolve({
				currentProjectId: null,
				projects: [],
			});

			const snapshot = await snapshotPromise;
			expect(snapshot).toMatchObject({
				currentProjectId: null,
				projects: [],
				projectId: null,
				projectPath: null,
				projectState: null,
				projectStateError: null,
				notificationSummariesByProject: {},
			});
		} finally {
			await hub.close();
		}
	});
});
