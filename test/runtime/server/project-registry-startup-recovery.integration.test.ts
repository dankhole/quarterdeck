import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	loadProjectBoardSnapshotById: vi.fn(),
	listProjectIndexEntries: vi.fn(async (): Promise<Array<{ projectId: string; repoPath: string }>> => []),
	removeProjectIndexEntry: vi.fn(),
	removeProjectStateFiles: vi.fn(),
}));
const agentMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
}));
const workdirMocks = vi.hoisted(() => ({
	pathExists: vi.fn(async () => true),
	resolveTaskCwd: vi.fn(async () => "/tmp/project-worktree"),
}));
const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ownershipMocks = vi.hoisted(() => ({
	listOwnership: vi.fn(
		async (): Promise<Array<{ taskId: string; state: string; ownerProcess: { processKind: string } | null }>> => [],
	),
}));

vi.mock("../../../src/state", () => ({
	isUnderWorktreesHome: vi.fn(() => false),
	listProjectIndexEntries: stateMocks.listProjectIndexEntries,
	loadProjectBoardById: vi.fn(),
	loadProjectBoardSnapshotById: stateMocks.loadProjectBoardSnapshotById,
	loadProjectContext: vi.fn(async () => null),
	loadProjectState: stateMocks.loadProjectState,
	removeProjectIndexEntry: stateMocks.removeProjectIndexEntry,
	removeProjectStateFiles: stateMocks.removeProjectStateFiles,
}));

vi.mock("../../../src/config", () => ({
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE: "",
	resolveAgentCommand: agentMocks.resolveAgentCommand,
	resolveAgentCommandForLaunch: agentMocks.resolveAgentCommand,
	toGlobalRuntimeConfigState: vi.fn((config) => config),
}));

vi.mock("../../../src/workdir", () => ({
	cleanStaleIndexLockForWorktree: vi.fn(async () => undefined),
	pathExists: workdirMocks.pathExists,
	resolveTaskCwd: workdirMocks.resolveTaskCwd,
}));

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

vi.mock("../../../src/state/project-execution-ownership-store", () => ({
	ProjectExecutionOwnershipStore: class {
		listOwnership = ownershipMocks.listOwnership;
	},
}));

import type { RuntimeConfigState } from "../../../src/config";
import {
	deriveTaskIndicatorState,
	type RuntimeBoardCard,
	type RuntimeProjectStateResponse,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core";
import { createProjectRegistry, type ProjectRegistry } from "../../../src/server/project-registry";
import { LEGACY_STARTUP_SEMANTIC_STATE_WARNING, type TerminalSessionManager } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

function createRuntimeConfig(): RuntimeConfigState {
	return {
		selectedAgentId: "codex",
		claudeFullscreenEnabled: false,
		claudeLaunchPermissionMode: "plan",
		statuslineEnabled: false,
		worktreeSystemPromptTemplate: "",
		llmSummaryPolishEnabled: false,
	} as RuntimeConfigState;
}

function createProjectState(): RuntimeProjectStateResponse {
	const card: RuntimeBoardCard = {
		id: "task-1",
		title: "Interrupted task",
		prompt: "Continue the work",
		baseRef: "main",
		agentId: "codex",
		useWorktree: true,
		workingDirectory: "/tmp/project-worktree",
		createdAt: 1,
		updatedAt: 1,
	};
	return {
		repoPath: "/tmp/project",
		statePath: "/tmp/state",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [card] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		},
		sessions: {
			"task-1": runtimeTaskSessionSummarySchema.parse({
				...createTestTaskSessionSummary({ taskId: "task-1" }),
				state: "interrupted",
				reviewReason: "interrupted",
				agentId: "codex",
				resumeSessionId: "session-1",
			}),
		},
		revision: 1,
	};
}

describe("project registry startup recovery integration", () => {
	let registry: ProjectRegistry | null = null;
	let manager: TerminalSessionManager | null = null;

	beforeEach(() => {
		stateMocks.loadProjectState.mockReset();
		stateMocks.loadProjectState.mockResolvedValue(createProjectState());
		stateMocks.loadProjectBoardSnapshotById.mockReset();
		stateMocks.loadProjectBoardSnapshotById.mockResolvedValue({
			board: createProjectState().board,
			revision: 1,
		});
		stateMocks.listProjectIndexEntries.mockReset();
		stateMocks.listProjectIndexEntries.mockResolvedValue([]);
		stateMocks.removeProjectIndexEntry.mockReset();
		stateMocks.removeProjectStateFiles.mockReset();
		agentMocks.resolveAgentCommand.mockReset();
		agentMocks.resolveAgentCommand.mockResolvedValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: ["--model", "test"],
		});
		workdirMocks.pathExists.mockClear();
		workdirMocks.resolveTaskCwd.mockClear();
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockReset();
		ptySessionSpawnMock.mockImplementation((_request: MockSpawnRequest) => ({
			pid: 1234,
			write: vi.fn(),
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
			wasInterrupted: vi.fn(() => false),
		}));
		ownershipMocks.listOwnership.mockReset();
		ownershipMocks.listOwnership.mockResolvedValue([]);
		registry = null;
		manager = null;
	});

	afterEach(() => {
		registry?.stopMaintenance();
		manager?.stopReconciliation();
		manager?.markInterruptedAndStopAll();
	});

	it("fails manager hydration instead of replacing unreadable durable sessions with an empty store", async () => {
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});
		stateMocks.loadProjectState.mockRejectedValueOnce(new Error("sessions.json is unreadable"));

		await expect(registry.ensureTerminalManagerForProject("project-1", "/tmp/project")).rejects.toThrow(
			"sessions.json is unreadable",
		);
		expect(manager).toBeNull();
		expect(registry.getTerminalManagerForProject("project-1")).toBeNull();
	});

	it("fails project summary reads instead of fabricating zero task counts", async () => {
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
		});
		stateMocks.loadProjectBoardSnapshotById.mockRejectedValueOnce(new Error("board.json is unreadable"));

		await expect(registry.buildProjectSummary("project-1", "/tmp/project")).rejects.toThrow(
			"board.json is unreadable",
		);
	});

	it("isolates unreadable session hydration without aborting runtime startup", async () => {
		stateMocks.listProjectIndexEntries.mockResolvedValue([{ projectId: "project-1", repoPath: "/tmp/project" }]);
		stateMocks.loadProjectState.mockRejectedValue(new Error("sessions.json is unreadable"));
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async (projectPath) => projectPath !== "/tmp/runtime",
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});
		const beforeRecovery = vi.fn(async () => undefined);

		await expect(registry.initializeIndexedProjectsForStartup({ beforeRecovery })).resolves.toBe(0);
		expect(beforeRecovery).toHaveBeenCalledTimes(1);
		expect(manager).toBeNull();
		expect(registry.getTerminalManagerForProject("project-1")).toBeNull();
		await expect(registry.ensureTerminalManagerForProject("project-1", "/tmp/project")).rejects.toThrow(
			"sessions.json is unreadable",
		);
	});

	it("hydrates an interrupted card, waits for cleanup, prepares once, and launches the stored conversation", async () => {
		const startupCleanup = createDeferred();
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			waitForStartupAgentCleanup: async () => await startupCleanup.promise,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		const recovery = registry.resumeInterruptedSessions("project-1", "/tmp/project");
		await vi.waitFor(() => expect(manager).not.toBeNull());
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();

		startupCleanup.resolve();
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1));
		const launchInput = prepareAgentLaunchMock.mock.calls[0]?.[0] as {
			hookSessionInstanceId: string;
			resumeSessionId?: string;
			cwd: string;
			agentId: string;
		};
		expect(launchInput).toMatchObject({
			resumeSessionId: "session-1",
			cwd: "/tmp/project-worktree",
			agentId: "codex",
		});

		manager?.recordHookReceived("task-1");
		expect(
			manager?.observeTaskSessionLaunchHook("task-1", {
				sessionInstanceId: launchInput.hookSessionInstanceId,
				sessionId: "session-1",
			}),
		).toBe(true);

		await expect(recovery).resolves.toBe(1);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(agentMocks.resolveAgentCommand).toHaveBeenCalledTimes(1);
		expect(workdirMocks.pathExists).toHaveBeenCalledTimes(1);
		expect(workdirMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(stateMocks.loadProjectState).toHaveBeenCalledTimes(3);
		expect(manager?.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: 1234,
			startupRecoveryRequired: false,
			startupRecoverySemanticStateUncertain: true,
			warningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
		});
	});

	it("never routes a persisted Claude SDK owner through native PTY startup recovery", async () => {
		ownershipMocks.listOwnership.mockResolvedValue([
			{
				taskId: "task-1",
				state: "native_tui",
				ownerProcess: { processKind: "stdio_agent_sdk" },
			},
		]);
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		await expect(registry.resumeInterruptedSessions("project-1", "/tmp/project")).resolves.toBe(0);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
	});

	it("keeps previously Running work Interrupted until replacement work is confirmed", async () => {
		const staleState = createProjectState();
		staleState.sessions["task-1"] = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "running",
			reviewReason: null,
			agentId: "codex",
			pid: 98_765,
			resumeSessionId: "session-1",
		});
		stateMocks.loadProjectState.mockResolvedValue(staleState);

		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		const recovery = registry.resumeInterruptedSessions("project-1", "/tmp/project");
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1));
		const launchInput = prepareAgentLaunchMock.mock.calls[0]?.[0] as {
			hookSessionInstanceId: string;
		};
		manager?.recordHookReceived("task-1");
		manager?.observeTaskSessionLaunchHook("task-1", {
			sessionInstanceId: launchInput.hookSessionInstanceId,
			sessionId: "session-1",
		});

		await expect(recovery).resolves.toBe(1);
		expect(manager?.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: 1234,
			startupRecoveryRequired: false,
			startupRecoverySemanticStateUncertain: false,
		});

		manager?.applyProviderHook("task-1", {
			taskId: "task-1",
			projectId: "project-1",
			event: "to_in_progress",
			metadata: {
				source: "codex",
				hookEventName: "PostToolUse",
				sessionInstanceId: launchInput.hookSessionInstanceId,
				turnId: "turn-1",
				toolUseId: "tool-1",
			},
			delivery: {
				id: "00000000-0000-4000-8000-000000000901",
				occurredAt: Date.now(),
			},
		});
		expect(manager?.store.getSummary("task-1")).toMatchObject({ state: "running", reviewReason: null });
	});

	it("does not relaunch unproven legacy attention and clears its stale recovery handoff", async () => {
		const staleState = createProjectState();
		const inProgressColumn = staleState.board.columns.find((column) => column.id === "in_progress");
		const reviewColumn = staleState.board.columns.find((column) => column.id === "review");
		const [card] = inProgressColumn?.cards ?? [];
		if (!inProgressColumn || !reviewColumn || !card) {
			throw new Error("Expected the startup recovery fixture to contain work columns and a task card.");
		}
		inProgressColumn.cards = [];
		reviewColumn.cards = [card];
		staleState.sessions["task-1"] = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "attention",
			agentId: "codex",
			pid: null,
			resumeSessionId: "session-1",
			startupRecoveryRequired: true,
			latestHookActivity: null,
		});
		stateMocks.loadProjectState.mockResolvedValue(staleState);

		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		await expect(registry.resumeInterruptedSessions("project-1", "/tmp/project")).resolves.toBe(0);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager?.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			startupRecoveryRequired: false,
		});
	});

	it("holds an interrupted task when a persisted provider hook is still deferred", async () => {
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		await expect(
			registry.resumeInterruptedSessions("project-1", "/tmp/project", {
				recoveryBarrier: {
					blockAllRecovery: false,
					blockedTasks: [{ projectId: "project-1", taskId: "task-1" }],
				},
			}),
		).resolves.toBe(0);

		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager?.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			startupRecoveryRequired: true,
		});

		await expect(
			registry.releaseDeferredStartupRecoveries([{ projectId: "project-1", taskId: "task-1" }]),
		).resolves.toBe(0);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();

		stateMocks.loadProjectState.mockRejectedValueOnce(new Error("transient board read failure"));
		await expect(registry.releaseDeferredStartupRecoveries([])).resolves.toBe(1);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();

		const released = registry.releaseDeferredStartupRecoveries([]);
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1));
		const launchInput = prepareAgentLaunchMock.mock.calls[0]?.[0] as {
			hookSessionInstanceId: string;
		};
		manager?.recordHookReceived("task-1");
		manager?.observeTaskSessionLaunchHook("task-1", {
			sessionInstanceId: launchInput.hookSessionInstanceId,
			sessionId: "session-1",
		});
		await expect(released).resolves.toBe(0);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("passes the startup provider-hook barrier into automatic recovery", async () => {
		stateMocks.listProjectIndexEntries.mockResolvedValue([{ projectId: "project-1", repoPath: "/tmp/project" }]);
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => true,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});
		const beforeRecovery = vi.fn(async () => ({
			blockAllRecovery: false,
			blockedTasks: [{ projectId: "project-1", taskId: "task-1" }],
		}));

		await expect(registry.initializeIndexedProjectsForStartup({ beforeRecovery })).resolves.toBe(1);
		await vi.waitFor(() => expect(stateMocks.loadProjectState).toHaveBeenCalledTimes(2));

		expect(beforeRecovery).toHaveBeenCalledTimes(1);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(manager?.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			startupRecoveryRequired: true,
		});
	});

	it("hydrates every indexed project and schedules recovery before any browser selects it", async () => {
		const startupCleanup = createDeferred();
		const projectEntries = [
			{ projectId: "project-1", repoPath: "/tmp/project-1" },
			{ projectId: "project-2", repoPath: "/tmp/project-2" },
		];
		stateMocks.listProjectIndexEntries.mockResolvedValue(projectEntries);
		const secondaryState = createProjectState();
		secondaryState.repoPath = "/tmp/project-2";
		stateMocks.loadProjectState.mockImplementation(async (projectPath: string) => {
			if (projectPath === "/tmp/project-2") {
				return secondaryState;
			}
			const primaryState = createProjectState();
			primaryState.repoPath = "/tmp/project-1";
			primaryState.board.columns[1] = { id: "in_progress", title: "In Progress", cards: [] };
			primaryState.sessions = {};
			return primaryState;
		});
		const managers = new Map<string, TerminalSessionManager>();
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async (projectPath) => projectPath !== "/tmp/runtime",
			pathIsDirectory: async () => true,
			waitForStartupAgentCleanup: async () => await startupCleanup.promise,
			onTerminalManagerReady: (projectId, readyManager) => {
				managers.set(projectId, readyManager);
			},
		});

		await expect(registry.initializeIndexedProjectsForStartup()).resolves.toBe(2);
		expect(Array.from(managers.keys()).sort()).toEqual(["project-1", "project-2"]);
		expect(registry.listManagedProjects()).toHaveLength(2);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();

		startupCleanup.resolve();
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1));
		const launchInput = prepareAgentLaunchMock.mock.calls[0]?.[0] as {
			hookSessionInstanceId: string;
		};
		const secondaryManager = managers.get("project-2");
		secondaryManager?.recordHookReceived("task-1");
		secondaryManager?.observeTaskSessionLaunchHook("task-1", {
			sessionInstanceId: launchInput.hookSessionInstanceId,
			sessionId: "session-1",
		});
		await vi.waitFor(() => expect(secondaryManager?.store.getSummary("task-1")?.pid).toBe(1234));

		await expect(registry.initializeIndexedProjectsForStartup()).resolves.toBe(2);
		expect(stateMocks.listProjectIndexEntries).toHaveBeenCalledTimes(2);
	});

	it("keeps unavailable project state during headless startup and prunes only at client reconciliation", async () => {
		const projectEntries = [
			{ projectId: "offline-project", repoPath: "/tmp/offline-project" },
			{ projectId: "available-project", repoPath: "/tmp/available-project" },
		];
		stateMocks.listProjectIndexEntries.mockResolvedValue(projectEntries);
		const availableState = createProjectState();
		availableState.repoPath = "/tmp/available-project";
		availableState.board.columns[1] = { id: "in_progress", title: "In Progress", cards: [] };
		availableState.sessions = {};
		stateMocks.loadProjectState.mockResolvedValue(availableState);
		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async (projectPath) => projectPath === "/tmp/available-project",
			pathIsDirectory: async (projectPath) => projectPath !== "/tmp/offline-project",
		});

		await expect(registry.initializeIndexedProjectsForStartup()).resolves.toBe(1);
		expect(registry.getActiveProjectId()).toBe("available-project");
		expect(stateMocks.removeProjectIndexEntry).not.toHaveBeenCalled();
		expect(stateMocks.removeProjectStateFiles).not.toHaveBeenCalled();

		await expect(registry.resolveProjectForStream(null)).resolves.toMatchObject({
			projectId: "available-project",
			didPruneProjects: true,
		});
		expect(stateMocks.removeProjectIndexEntry).toHaveBeenCalledWith("offline-project");
		expect(stateMocks.removeProjectStateFiles).toHaveBeenCalledWith("offline-project");
	});

	it.each([
		{
			label: "ordinary review",
			latestHookActivity: null,
			expectedIndicator: { reviewReady: true, needsInput: false },
		},
		{
			label: "genuine permission wait",
			latestHookActivity: {
				hookEventName: "PermissionRequest",
				activityText: "Waiting for approval",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				notificationType: "permission_prompt",
				source: "codex",
				conversationSummaryText: null,
			},
			expectedIndicator: { reviewReady: false, needsInput: true },
		},
	])(
		"recovers a persisted $label chat without changing its semantic state",
		async ({ latestHookActivity, expectedIndicator }) => {
			const staleState = createProjectState();
			const inProgressColumn = staleState.board.columns.find((column) => column.id === "in_progress");
			const reviewColumn = staleState.board.columns.find((column) => column.id === "review");
			const [card] = inProgressColumn?.cards ?? [];
			if (!inProgressColumn || !reviewColumn || !card) {
				throw new Error("Expected the startup recovery fixture to contain work columns and a task card.");
			}
			inProgressColumn.cards = [];
			reviewColumn.cards = [card];
			staleState.sessions["task-1"] = createTestTaskSessionSummary({
				taskId: "task-1",
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "codex",
				pid: 98_765,
				resumeSessionId: "session-1",
				lastHookAt: 321,
				latestHookActivity,
			});
			stateMocks.loadProjectState.mockResolvedValue(staleState);

			const config = createRuntimeConfig();
			registry = await createProjectRegistry({
				cwd: "/tmp/runtime",
				loadGlobalRuntimeConfig: async () => config,
				loadRuntimeConfig: async () => config,
				hasGitRepository: async () => false,
				pathIsDirectory: async () => true,
				onTerminalManagerReady: (_projectId, readyManager) => {
					manager = readyManager;
				},
			});

			const recovery = registry.resumeInterruptedSessions("project-1", "/tmp/project");
			await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1));
			const launchInput = prepareAgentLaunchMock.mock.calls[0]?.[0] as {
				hookSessionInstanceId: string;
				resumeSessionId?: string;
			};
			expect(launchInput.resumeSessionId).toBe("session-1");
			manager?.recordHookReceived("task-1");
			manager?.observeTaskSessionLaunchHook("task-1", {
				sessionInstanceId: launchInput.hookSessionInstanceId,
				sessionId: "session-1",
			});

			await expect(recovery).resolves.toBe(1);
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
			const restored = manager?.store.getSummary("task-1") ?? null;
			if (!restored) {
				throw new Error("Expected startup recovery to retain the restored task summary.");
			}
			expect(restored).toMatchObject({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: 1234,
			});
			expect(restored.lastHookAt).toBe(321);
			expect(restored.latestHookActivity).toEqual(latestHookActivity);
			expect(deriveTaskIndicatorState(restored)).toMatchObject(expectedIndicator);
		},
	);

	it("keeps completed work in Review when its historical chat cannot be restored", async () => {
		const staleState = createProjectState();
		const inProgressColumn = staleState.board.columns.find((column) => column.id === "in_progress");
		const reviewColumn = staleState.board.columns.find((column) => column.id === "review");
		const [card] = inProgressColumn?.cards ?? [];
		if (!inProgressColumn || !reviewColumn || !card) {
			throw new Error("Expected the startup recovery fixture to contain work columns and a task card.");
		}
		inProgressColumn.cards = [];
		reviewColumn.cards = [card];
		staleState.sessions["task-1"] = createTestTaskSessionSummary({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "hook",
			agentId: "codex",
			pid: 98_765,
			resumeSessionId: "session-1",
			lastHookAt: 321,
			latestHookActivity: {
				hookEventName: "Stop",
				finalMessage: "Implemented and verified.",
			},
		});
		stateMocks.loadProjectState.mockResolvedValue(staleState);
		prepareAgentLaunchMock.mockRejectedValue(new Error("stored conversation unavailable"));

		const config = createRuntimeConfig();
		registry = await createProjectRegistry({
			cwd: "/tmp/runtime",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: async () => false,
			pathIsDirectory: async () => true,
			onTerminalManagerReady: (_projectId, readyManager) => {
				manager = readyManager;
			},
		});

		await expect(registry.resumeInterruptedSessions("project-1", "/tmp/project")).resolves.toBe(1);
		const restored = manager?.store.getSummary("task-1") ?? null;
		if (!restored) {
			throw new Error("Expected the failed recovery to retain the task summary.");
		}
		expect(restored).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			lastHookAt: 321,
			startupRecoveryRequired: false,
			warningMessage: expect.stringContaining("Use Restart"),
			latestHookActivity: {
				hookEventName: "Stop",
				finalMessage: "Implemented and verified.",
			},
		});
		expect(deriveTaskIndicatorState(restored)).toMatchObject({
			reviewReady: true,
			needsInput: false,
			failure: false,
		});
	});
});
