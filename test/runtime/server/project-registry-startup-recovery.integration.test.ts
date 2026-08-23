import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	listProjectIndexEntries: vi.fn(async () => []),
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

vi.mock("../../../src/state", () => ({
	isUnderWorktreesHome: vi.fn(() => false),
	listProjectIndexEntries: stateMocks.listProjectIndexEntries,
	loadProjectBoardById: vi.fn(),
	loadProjectContext: vi.fn(async () => null),
	loadProjectState: stateMocks.loadProjectState,
	removeProjectIndexEntry: vi.fn(),
	removeProjectStateFiles: vi.fn(),
}));

vi.mock("../../../src/config", () => ({
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE: "",
	resolveAgentCommand: agentMocks.resolveAgentCommand,
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

import type { RuntimeConfigState } from "../../../src/config";
import type { RuntimeBoardCard, RuntimeProjectStateResponse } from "../../../src/core";
import { createProjectRegistry, type ProjectRegistry } from "../../../src/server/project-registry";
import type { TerminalSessionManager } from "../../../src/terminal";
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
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
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
		stateMocks.listProjectIndexEntries.mockClear();
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
		registry = null;
		manager = null;
	});

	afterEach(() => {
		registry?.stopMaintenance();
		manager?.stopReconciliation();
		manager?.markInterruptedAndStopAll();
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
	});
});
