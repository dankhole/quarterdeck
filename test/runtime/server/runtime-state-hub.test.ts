import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_CONFIG_STATE } from "../../../src/config";
import type {
	DiagnosticRecordEnvelope,
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeStateStreamMessage,
	RuntimeTaskSessionSummary,
} from "../../../src/core";
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import type { CreateRuntimeStateHubDependencies } from "../../../src/server";
import { RuntimeStateHubImpl } from "../../../src/server";
import * as state from "../../../src/state";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createBoard } from "../../utilities/board-factory";
import {
	createTestTaskHookActivity,
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

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
	notificationRevisionsByProject: Record<string, number>;
}

interface RuntimeStateHubInternals {
	clients: {
		registerGlobalClient: (client: TestRuntimeClient) => void;
		registerProjectClient: (projectId: string, client: TestRuntimeClient, clientId: string) => void;
	};
	batcher: {
		queueDiagnosticRecord: (record: DiagnosticRecordEnvelope) => void;
	};
	diagnosticClientBySocket: WeakMap<TestRuntimeClient, { clientId: string; capability: string; connectionId: string }>;
	loadInitialSnapshot: (resolved: {
		projectId: string | null;
		projectPath: string | null;
	}) => Promise<InitialSnapshot>;
	handleConnection: (
		client: TestRuntimeClient & { on: (event: string, listener: () => void) => void; close: () => void },
		context: unknown,
	) => Promise<void>;
	enqueueConnectionCatchupForClient: (
		client: TestRuntimeClient,
		input: { projectId: string | null; projectPath: string | null; projectIds: readonly string[] },
	) => void;
}

interface TestRuntimeClient {
	readyState: number;
	send: (payload: string) => void;
	terminate: () => void;
}

function createRuntimeClient(): { client: TestRuntimeClient; messages: RuntimeStateStreamMessage[] } {
	const messages: RuntimeStateStreamMessage[] = [];
	return {
		client: {
			readyState: 1,
			send: (payload) => {
				messages.push(JSON.parse(payload) as RuntimeStateStreamMessage);
			},
			terminate: vi.fn(),
		},
		messages,
	};
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
				boardRevision: 0,
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

function createDiagnosticsStub(): RuntimeDiagnostics {
	return {
		runtimeInstanceId: "runtime-test",
		recorder: {
			onRecord: () => () => undefined,
			onRecordingStateChange: () => () => undefined,
			getRecordingState: () => ({ active: false, startedAt: null, expiresAt: null, scope: null }),
		},
		registerSnapshotProvider: () => () => undefined,
		setBrowserSnapshotRequester: vi.fn(),
		issueBrowserCapability: () => "browser-capability",
		revokeBrowserCapability: vi.fn(),
		recordEvent: vi.fn(),
		getRecords: () => [],
	} as unknown as RuntimeDiagnostics;
}

function createDependencies(input: {
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<RuntimeProjectsResponse>;
	buildProjectStateSnapshot: (projectId: string, projectPath: string) => Promise<RuntimeProjectStateResponse>;
	listManagedProjects: CreateRuntimeStateHubDependencies["projectRegistry"]["listManagedProjects"];
}): CreateRuntimeStateHubDependencies {
	return {
		diagnostics: createDiagnosticsStub(),
		projectRegistry: {
			resolveProjectForStream: async () => ({
				projectId: null,
				projectPath: null,
				removedRequestedProjectPath: null,
				didPruneProjects: false,
			}),
			buildProjectsPayload: input.buildProjectsPayload,
			buildProjectStateSnapshot: input.buildProjectStateSnapshot,
			getActiveRuntimeConfig: () => DEFAULT_RUNTIME_CONFIG_STATE,
			listManagedProjects: input.listManagedProjects,
			getProjectPathById: (projectId) => (projectId === "project-1" ? "/repo" : null),
		},
		boardCommands: {
			reconcileRuntimeSessions: vi.fn(async () => createBoardCommandResult()),
			reconcileRuntimeMetadata: vi.fn(async () => createBoardCommandResult()),
			reconcileRuntimeTaskBaseRef: vi.fn(async () => createBoardCommandResult()),
		},
	};
}

function createBoardCommandResult() {
	return {
		state: createProjectStateResponse(),
		changed: false,
		acceptedChange: false,
		replayed: false,
	};
}

describe("RuntimeStateHub", () => {
	it("registers a client only after its snapshot and immediately schedules durable catch-up", async () => {
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
				buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
				listManagedProjects: vi.fn(() => []),
			}),
		);
		const internals = hub as unknown as RuntimeStateHubInternals;
		const snapshotDeferred = createDeferred<InitialSnapshot>();
		const timeline: string[] = [];
		const originalRegisterGlobalClient = internals.clients.registerGlobalClient.bind(internals.clients);
		const originalRegisterProjectClient = internals.clients.registerProjectClient.bind(internals.clients);
		vi.spyOn(internals, "loadInitialSnapshot").mockReturnValue(snapshotDeferred.promise);
		vi.spyOn(internals, "enqueueConnectionCatchupForClient").mockImplementation(() => {
			timeline.push("catch-up");
		});
		vi.spyOn(internals.clients, "registerGlobalClient").mockImplementation((client) => {
			timeline.push("register-global");
			originalRegisterGlobalClient(client);
		});
		vi.spyOn(internals.clients, "registerProjectClient").mockImplementation((projectId, client, clientId) => {
			timeline.push("register-project");
			originalRegisterProjectClient(projectId, client, clientId);
		});
		const client = {
			readyState: 1,
			send: (payload: string) => {
				const message = JSON.parse(payload) as RuntimeStateStreamMessage;
				timeline.push(`send-${message.type}`);
			},
			terminate: vi.fn(),
			close: vi.fn(),
			on: vi.fn(),
		};

		try {
			const connection = internals.handleConnection(client, {
				requestedProjectId: "project-1",
				clientId: "client-1",
				isDocumentVisible: true,
			});
			await vi.waitFor(() => expect(internals.loadInitialSnapshot).toHaveBeenCalledOnce());
			expect(timeline).toEqual([]);

			snapshotDeferred.resolve({
				currentProjectId: "project-1",
				projects: createProjectsResponse().projects,
				projectId: "project-1",
				projectPath: "/repo",
				projectState: createProjectStateResponse(),
				projectStateError: null,
				notificationSummariesByProject: {},
				notificationRevisionsByProject: {},
			});
			await connection;

			expect(timeline.slice(0, 4)).toEqual(["send-snapshot", "register-global", "register-project", "catch-up"]);
		} finally {
			await hub.close();
		}
	});

	it("broadcasts an already-committed authoritative snapshot without rebuilding it", async () => {
		const buildProjectStateSnapshot = vi.fn(async () => createProjectStateResponse());
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
				buildProjectStateSnapshot,
				listManagedProjects: vi.fn(() => []),
			}),
		);
		const projectClient = createRuntimeClient();
		const globalClient = createRuntimeClient();
		(hub as unknown as RuntimeStateHubInternals).clients.registerProjectClient(
			"project-1",
			projectClient.client,
			"client-1",
		);
		(hub as unknown as RuntimeStateHubInternals).clients.registerGlobalClient(globalClient.client);
		const committed = { ...createProjectStateResponse(), revision: 7 };

		try {
			hub.broadcastRuntimeProjectStateSnapshot("project-1", committed);

			expect(buildProjectStateSnapshot).not.toHaveBeenCalled();
			expect(projectClient.messages).toEqual([
				expect.objectContaining({
					type: "project_state_updated",
					projectId: "project-1",
					projectState: committed,
				}),
			]);
			await vi.waitFor(() => {
				expect(globalClient.messages).toContainEqual(
					expect.objectContaining({
						type: "projects_updated",
						projects: [
							expect.objectContaining({
								id: "project-1",
								boardRevision: 7,
								taskCounts: { backlog: 1, in_progress: 0, review: 0, trash: 0 },
							}),
						],
					}),
				);
			});
		} finally {
			await hub.close();
		}
	});

	it("persists terminal-store changes through the runtime board authority without a browser client", async () => {
		vi.useFakeTimers();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				sessionLaunchPath: "/repo",
			}),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			expect(reconcileRuntimeSessions).toHaveBeenLastCalledWith({
				projectId: "project-1",
				projectPath: "/repo",
			});

			store.update("task-1", { warningMessage: "Needs attention" });
			await vi.advanceTimersByTimeAsync(100);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			await hub.disposeProject("project-1");
			store.update("task-1", { warningMessage: "No longer tracked" });
			await vi.advanceTimersByTimeAsync(200);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("retries failed session persistence and converges a generation dirtied during an in-flight write", async () => {
		vi.useFakeTimers();
		const firstAttempt = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstAttempt.promise)
			.mockRejectedValueOnce(new Error("transient persistence failure"))
			.mockResolvedValue(createBoardCommandResult());
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(1);

			store.update("task-1", { warningMessage: "newest generation" });
			firstAttempt.resolve(createBoardCommandResult());
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(250);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(3);
		} finally {
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("waits for an in-flight session writer before project disposal completes", async () => {
		vi.useFakeTimers();
		const inFlightWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockImplementationOnce(async () => await inFlightWrite.promise);
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			let disposed = false;
			const disposal = hub.disposeProject("project-1").then(() => {
				disposed = true;
			});
			await Promise.resolve();
			expect(disposed).toBe(false);

			store.update("task-1", { warningMessage: "must not schedule after disposal" });
			inFlightWrite.resolve(createBoardCommandResult());
			await disposal;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("serializes concurrent explicit flushes without rejecting a hook acknowledgement", async () => {
		vi.useFakeTimers();
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const secondWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstWrite.promise)
			.mockImplementationOnce(async () => await secondWrite.promise)
			.mockResolvedValue(createBoardCommandResult());
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			const firstFlush = hub.persistRuntimeSessions("project-1");
			await Promise.resolve();
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();

			store.update("task-1", { warningMessage: "concurrent hook generation" });
			const secondFlush = hub.persistRuntimeSessions("project-1");
			firstWrite.resolve(createBoardCommandResult());
			await firstFlush;
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));

			let secondSettled = false;
			void secondFlush.finally(() => {
				secondSettled = true;
			});
			await Promise.resolve();
			expect(secondSettled).toBe(false);

			secondWrite.resolve(createBoardCommandResult());
			await expect(secondFlush).resolves.toBeUndefined();
		} finally {
			firstWrite.resolve(createBoardCommandResult());
			secondWrite.resolve(createBoardCommandResult());
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("keeps a late explicit persistence barrier durable while shutdown detaches store listeners", async () => {
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const secondWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstWrite.promise)
			.mockImplementationOnce(async () => await secondWrite.promise)
			.mockResolvedValue(createBoardCommandResult());
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		const firstFlush = hub.persistRuntimeSessions("project-1");
		await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledOnce());
		const closing = hub.close();
		store.update("task-1", { warningMessage: "late shutdown hook transition" });
		const lateFlush = hub.persistRuntimeSessions("project-1");

		firstWrite.resolve(createBoardCommandResult());
		await firstFlush;
		await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));
		let lateFlushSettled = false;
		void lateFlush.finally(() => {
			lateFlushSettled = true;
		});
		await Promise.resolve();
		expect(lateFlushSettled).toBe(false);

		secondWrite.resolve(createBoardCommandResult());
		await expect(lateFlush).resolves.toBeUndefined();
		await expect(closing).resolves.toBeUndefined();
		await expect(hub.persistRuntimeSessions("project-1")).rejects.toThrow("persistence is closed");
	});

	it("retries a failed final session flush before completing shutdown", async () => {
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockRejectedValueOnce(new Error("transient final persistence failure"))
			.mockResolvedValue(createBoardCommandResult());
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		await expect(hub.close()).resolves.toBeUndefined();
		expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
	});

	it("finishes hub cleanup but rejects shutdown when the newest session generation cannot persist", async () => {
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockRejectedValue(new Error("persistent final persistence failure"));
		const hub = new RuntimeStateHubImpl(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		await expect(hub.close()).rejects.toThrow("Runtime session persistence did not finish during shutdown");
		expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
	});

	it("delivers live diagnostic batches only to the explicitly subscribed connection", async () => {
		vi.useFakeTimers();
		const dependencies = createDependencies({
			buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
			buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
			listManagedProjects: vi.fn(() => []),
		});
		dependencies.diagnostics = {
			...dependencies.diagnostics,
			hasBrowserLiveSubscribers: () => true,
			isBrowserLiveSubscribed: (_clientId: string, capability: string) => capability === "subscribed-capability",
		} as unknown as RuntimeDiagnostics;
		const hub = new RuntimeStateHubImpl(dependencies);
		const subscribed = createRuntimeClient();
		const passive = createRuntimeClient();
		const internals = hub as unknown as RuntimeStateHubInternals;
		internals.clients.registerGlobalClient(subscribed.client);
		internals.clients.registerGlobalClient(passive.client);
		internals.diagnosticClientBySocket.set(subscribed.client, {
			clientId: "subscribed",
			capability: "subscribed-capability",
			connectionId: "connection-1",
		});
		internals.diagnosticClientBySocket.set(passive.client, {
			clientId: "passive",
			capability: "passive-capability",
			connectionId: "connection-2",
		});
		const record: DiagnosticRecordEnvelope = {
			version: 1,
			id: "runtime:1",
			sequence: 1,
			timestamp: 1,
			monotonicOffsetMs: 1,
			runtimeInstanceId: "runtime",
			source: "runtime",
			kind: "event",
			level: "warn",
			name: "runtime.test",
			context: {},
			payload: {},
		};

		try {
			internals.batcher.queueDiagnosticRecord(record);
			await vi.advanceTimersByTimeAsync(150);

			expect(subscribed.messages).toEqual([{ type: "diagnostic_record_batch", records: [record] }]);
			expect(passive.messages).toEqual([]);
		} finally {
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("keeps activity local while fanning semantic review changes and project counts across clients", async () => {
		vi.useFakeTimers();
		const board = createBoard("Tracked task");
		const loadProjectBoard = vi.spyOn(state, "loadProjectBoardById").mockResolvedValue(board);
		let isProjectedReview = true;
		const buildProjectsPayload = vi.fn(async (preferredCurrentProjectId: string | null) => ({
			currentProjectId: preferredCurrentProjectId,
			projects: [
				{
					id: "project-1",
					path: "/repo-1",
					name: "repo-1",
					boardRevision: 1,
					taskCounts: {
						backlog: 0,
						in_progress: isProjectedReview ? 0 : 1,
						review: isProjectedReview ? 1 : 0,
						trash: 0,
					},
				},
				{
					id: "project-2",
					path: "/repo-2",
					name: "repo-2",
					boardRevision: 0,
					taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
				},
			],
		}));
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload,
				buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
				listManagedProjects: vi.fn(() => []),
			}),
		);
		const project1Client = createRuntimeClient();
		const project2Client = createRuntimeClient();
		const clients = (hub as unknown as RuntimeStateHubInternals).clients;
		clients.registerGlobalClient(project1Client.client);
		clients.registerProjectClient("project-1", project1Client.client, "client-1");
		clients.registerGlobalClient(project2Client.client);
		clients.registerProjectClient("project-2", project2Client.client, "client-2");

		const initialSummary = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "running",
			agentId: "codex",
			sessionInstanceId: "process-1",
			sessionLaunchPath: "/repo-1",
			pid: 1234,
			startedAt: 1,
			nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
		});
		const store = new InMemorySessionSummaryStore();
		store.ensureEntry("task-1");
		store.update("task-1", initialSummary);
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			store.update("task-1", {
				lastHookAt: 2,
				latestHookActivity: createTestTaskHookActivity({
					activityText: "Reading files",
					hookEventName: "PreToolUse",
					toolName: "Read",
				}),
			});
			await vi.advanceTimersByTimeAsync(150);

			expect(project1Client.messages.map((message) => message.type)).toEqual(["task_sessions_updated"]);
			expect(project2Client.messages).toEqual([]);
			expect(loadProjectBoard).not.toHaveBeenCalled();
			expect(buildProjectsPayload).not.toHaveBeenCalled();

			project1Client.messages.length = 0;
			project2Client.messages.length = 0;
			const permissionActivity = createTestTaskHookActivity({
				activityText: "Waiting for approval",
				hookEventName: "PermissionRequest",
			});
			store.update("task-1", {
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: createTestTaskOutstandingInteraction({
					provider: "codex",
					kind: "permission",
					requestEventName: "PermissionRequest",
				}),
				lastHookAt: 3,
				latestHookActivity: permissionActivity,
			});
			await vi.advanceTimersByTimeAsync(150);
			await vi.waitFor(() => {
				expect(project2Client.messages.some((message) => message.type === "task_notification")).toBe(true);
				expect(project2Client.messages.some((message) => message.type === "projects_updated")).toBe(true);
			});

			expect(project1Client.messages.some((message) => message.type === "task_sessions_updated")).toBe(true);
			expect(project2Client.messages.some((message) => message.type === "task_sessions_updated")).toBe(false);
			for (const client of [project1Client, project2Client]) {
				const notification = client.messages.find((message) => message.type === "task_notification");
				expect(notification).toMatchObject({
					type: "task_notification",
					projectId: "project-1",
					notificationRevision: 1,
					summaries: [
						{
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "hook",
							latestHookActivity: permissionActivity,
						},
					],
				});
				const projectsUpdate = client.messages.find((message) => message.type === "projects_updated");
				expect(projectsUpdate).toMatchObject({
					type: "projects_updated",
					currentProjectId: "project-1",
					projects: [
						{
							id: "project-1",
							taskCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
						},
						{
							id: "project-2",
							taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
						},
					],
				});
			}
			expect(loadProjectBoard).toHaveBeenCalledWith("project-1");
			expect(buildProjectsPayload).toHaveBeenCalledOnce();
			expect(buildProjectsPayload).toHaveBeenCalledWith("project-1");

			project1Client.messages.length = 0;
			project2Client.messages.length = 0;
			isProjectedReview = false;
			store.update("task-1", {
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
			});
			await vi.advanceTimersByTimeAsync(150);
			await vi.waitFor(() => {
				expect(project2Client.messages.some((message) => message.type === "task_notification")).toBe(true);
				expect(project2Client.messages.some((message) => message.type === "projects_updated")).toBe(true);
			});

			expect(project1Client.messages).toContainEqual(
				expect.objectContaining({
					type: "task_sessions_updated",
					summaries: [expect.objectContaining({ taskId: "task-1", state: "running" })],
				}),
			);
			for (const client of [project1Client, project2Client]) {
				expect(client.messages).toContainEqual(
					expect.objectContaining({
						type: "task_notification",
						projectId: "project-1",
						notificationRevision: 2,
						summaries: [expect.objectContaining({ taskId: "task-1", state: "running" })],
					}),
				);
				expect(client.messages).toContainEqual(
					expect.objectContaining({
						type: "projects_updated",
						projects: [
							expect.objectContaining({
								id: "project-1",
								taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
							}),
							expect.anything(),
						],
					}),
				);
			}

			project1Client.messages.length = 0;
			project2Client.messages.length = 0;
			isProjectedReview = true;
			store.update("task-1", {
				state: "awaiting_review",
				reviewReason: "hook",
				lastHookAt: 4,
				latestHookActivity: createTestTaskHookActivity({
					activityText: "Ready for review",
					hookEventName: "Stop",
				}),
				outstandingInteraction: null,
			});
			await vi.advanceTimersByTimeAsync(150);

			expect(project1Client.messages).toContainEqual(
				expect.objectContaining({
					type: "task_ready_for_review",
					projectId: "project-1",
					taskId: "task-1",
				}),
			);
			expect(project2Client.messages.some((message) => message.type === "task_ready_for_review")).toBe(false);
		} finally {
			loadProjectBoard.mockRestore();
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("serializes notification board reads so revisions cannot overtake one another", async () => {
		vi.useFakeTimers();
		const firstBoardRead = createDeferred<ReturnType<typeof createBoard>>();
		const board = createBoard("Tracked task");
		const loadProjectBoard = vi
			.spyOn(state, "loadProjectBoardById")
			.mockImplementationOnce(async () => await firstBoardRead.promise)
			.mockResolvedValue(board);
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload: vi.fn(async () => createProjectsResponse()),
				buildProjectStateSnapshot: vi.fn(async () => createProjectStateResponse()),
				listManagedProjects: vi.fn(() => []),
			}),
		);
		const client = createRuntimeClient();
		(hub as unknown as RuntimeStateHubInternals).clients.registerGlobalClient(client.client);
		const store = new InMemorySessionSummaryStore();
		store.ensureEntry("task-1");
		store.update(
			"task-1",
			createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				sessionInstanceId: "process-1",
				sessionLaunchPath: "/repo",
				pid: 1234,
				nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
			}),
		);
		hub.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			store.update("task-1", {
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: createTestTaskHookActivity({ hookEventName: "Stop" }),
			});
			await vi.advanceTimersByTimeAsync(150);
			expect(loadProjectBoard).toHaveBeenCalledTimes(1);

			store.update("task-1", {
				state: "running",
				reviewReason: null,
				nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
				latestHookActivity: createTestTaskHookActivity({ hookEventName: "UserPromptSubmit" }),
			});
			await vi.advanceTimersByTimeAsync(150);
			// The second async board read is deliberately held behind the first;
			// otherwise revision 2 could arrive before revision 1 and make revision
			// 1's task delta permanently disappear in the browser.
			expect(loadProjectBoard).toHaveBeenCalledTimes(1);

			firstBoardRead.resolve(board);
			await vi.waitFor(() => expect(loadProjectBoard).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => {
				const notifications = client.messages.filter((message) => message.type === "task_notification");
				expect(notifications).toHaveLength(2);
				expect(notifications.map((message) => message.notificationRevision)).toEqual([1, 2]);
				expect(notifications.map((message) => message.summaries[0]?.state)).toEqual(["awaiting_review", "running"]);
			});
		} finally {
			await hub.close();
			vi.useRealTimers();
		}
	});

	it("broadcasts console verbosity with the current diagnostic recording state", async () => {
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
				type: "diagnostic_capture_state",
				consoleLogLevel: "error",
				recording: {
					active: false,
					startedAt: null,
					expiresAt: null,
					scope: null,
				},
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

	it("pairs initial project counts with the exact included board revision", async () => {
		const projectState = { ...createProjectStateResponse(), revision: 7 };
		const hub = new RuntimeStateHubImpl(
			createDependencies({
				buildProjectsPayload: vi.fn(async () => ({
					currentProjectId: "project-1",
					projects: [
						{
							id: "project-1",
							path: "/repo",
							name: "repo",
							boardRevision: 8,
							taskCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
						},
					],
				})),
				buildProjectStateSnapshot: vi.fn(async () => projectState),
				listManagedProjects: vi.fn(() => []),
			}),
		);

		try {
			const snapshot = await (hub as unknown as RuntimeStateHubInternals).loadInitialSnapshot({
				projectId: "project-1",
				projectPath: "/repo",
			});

			expect(snapshot.projectState?.revision).toBe(7);
			expect(snapshot.projects).toEqual([
				expect.objectContaining({
					id: "project-1",
					boardRevision: 7,
					taskCounts: { backlog: 1, in_progress: 0, review: 0, trash: 0 },
				}),
			]);
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
