import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
	captureTaskPatch: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	findTaskPatch: vi.fn(),
	applyTaskPatch: vi.fn(),
	getTaskWorkingDirectory: vi.fn(),
	pathExists: vi.fn(async () => true),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const projectStateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
}));

const taskBoardMutationMocks = vi.hoisted(() => ({
	findCardInBoard: vi.fn((): Record<string, unknown> | null => null),
}));

const fsMocks = vi.hoisted(() => ({
	rm: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: fsMocks.rm,
	};
});

vi.mock("../../../src/config/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
	resolveTaskWorkingDirectory: taskWorktreeMocks.resolveTaskWorkingDirectory,
	getTaskWorkingDirectory: taskWorktreeMocks.getTaskWorkingDirectory,
	pathExists: taskWorktreeMocks.pathExists,
	applyTaskPatch: taskWorktreeMocks.applyTaskPatch,
	captureTaskPatch: taskWorktreeMocks.captureTaskPatch,
	ensureTaskWorktreeIfDoesntExist: taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist,
	findTaskPatch: taskWorktreeMocks.findTaskPatch,
}));

vi.mock("../../../src/workdir/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("../../../src/state/project-state.js", () => ({
	loadProjectState: projectStateMocks.loadProjectState,
}));

vi.mock("../../../src/core/task-board-mutations.js", () => ({
	findCardInBoard: taskBoardMutationMocks.findCardInBoard,
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: vi.fn(),
}));

import { createRuntimeApi } from "../../../src/trpc";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Test task",
		prompt: "Do something",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function emptyBoard() {
	return {
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		},
	};
}

/** Summary method names that now live on manager.store instead of manager directly. */
const STORE_METHOD_NAMES = new Set([
	"getSummary",
	"listSummaries",
	"applyTurnCheckpoint",
	"transitionToReview",
	"transitionToRunning",
	"applyHookActivity",
	"appendConversationSummary",
	"setDisplaySummary",
]);

/**
 * Build a fake TerminalSessionManager from a flat Record. Keys matching store
 * method names are placed under `.store`; the rest stay at the top level.
 */
function createDeps(flat: Record<string, unknown> = {}) {
	const store: Record<string, unknown> = {};
	const manager: Record<string, unknown> = { store };
	for (const [key, value] of Object.entries(flat)) {
		if (STORE_METHOD_NAMES.has(key)) {
			store[key] = value;
		} else {
			manager[key] = value;
		}
	}
	const runtimeConfig = createTestRuntimeConfigState();
	return {
		config: {
			getActiveRuntimeConfig: vi.fn(() => runtimeConfig),
			loadScopedRuntimeConfig: vi.fn(async () => runtimeConfig),
			setActiveRuntimeConfig: vi.fn(),
		},
		broadcaster: {
			broadcastRuntimeProjectStateUpdated: vi.fn(),
			broadcastTaskWorkingDirectoryUpdated: vi.fn(),
			setPollIntervals: vi.fn(),
			broadcastLogLevel: vi.fn(),
		},
		getActiveProjectId: vi.fn(() => "project-1"),
		getScopedTerminalManager: vi.fn(async () => manager as never),
		resolveInteractiveShellCommand: vi.fn(),
		runCommand: vi.fn(),
	};
}

const defaultScope = {
	projectId: "project-1",
	projectPath: "/tmp/repo",
};

describe("createRuntimeApi startTaskSession", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		projectStateMocks.loadProjectState.mockReset();
		taskBoardMutationMocks.findCardInBoard.mockReset();
		taskWorktreeMocks.pathExists.mockReset();

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
		// Default: card not found (legacy behavior — falls through to worktree lookup).
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);
	});

	it("uses persisted workingDirectory when card has one and directory exists", async () => {
		const card = createCard({ workingDirectory: "/tmp/my-worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
		});

		expect(response.ok).toBe(true);
		// Should NOT have called resolveTaskCwd — used persisted path directly.
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/my-worktree" }),
		);
	});

	it("falls back to worktree lookup when persisted workingDirectory does not exist on disk", async () => {
		const card = createCard({ workingDirectory: "/tmp/deleted-worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(false);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/new-worktree" }),
		);
	});

	it("falls back to projectPath when non-worktree task's persisted directory is deleted", async () => {
		const card = createCard({ workingDirectory: "/tmp/deleted-dir", useWorktree: false });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(false);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
			useWorktree: false,
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/repo" }));
	});

	it("reuses an existing worktree path before falling back to ensure (legacy card without workingDirectory)", async () => {
		// No card found — legacy behavior.
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Investigate startup freeze",
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
			branch: null,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
		);
	});

	it("passes saved branch from card to resolveTaskCwd for branch-aware worktree creation", async () => {
		const card = createCard({ branch: "feat/foo" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(false);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/branch-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Implement feature",
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
			branch: "feat/foo",
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/branch-worktree" }),
		);
	});

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Investigate startup freeze",
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
			branch: null,
		});
	});

	it("forwards task images to CLI task sessions", async () => {
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const deps = createDeps(terminalManager);
		deps.config.loadScopedRuntimeConfig = vi.fn(async () => {
			const runtimeConfigState = createTestRuntimeConfigState();
			runtimeConfigState.selectedAgentId = "codex";
			return runtimeConfigState;
		});
		const api = createRuntimeApi(deps);

		const images = [
			{
				id: "img-1",
				data: Buffer.from("hello").toString("base64"),
				mimeType: "image/png",
				name: "diagram.png",
			},
		];

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Continue task",
			images,
		});

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				images,
			}),
		);
	});
});

describe("createRuntimeApi migrateTaskWorkingDirectory", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		taskWorktreeMocks.captureTaskPatch.mockReset();
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockReset();
		taskWorktreeMocks.findTaskPatch.mockReset();
		taskWorktreeMocks.applyTaskPatch.mockReset();
		projectStateMocks.loadProjectState.mockReset();
		taskBoardMutationMocks.findCardInBoard.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		fsMocks.rm.mockReset();

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});

	it("isolates a task from main checkout to a worktree", async () => {
		const card = createCard({ workingDirectory: "/tmp/repo" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.captureTaskPatch.mockResolvedValue(undefined);
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/worktree",
		});
		taskWorktreeMocks.findTaskPatch.mockResolvedValue({
			path: "/tmp/patches/task-1.patch",
			commit: "abc123",
		});
		taskWorktreeMocks.applyTaskPatch.mockResolvedValue(undefined);
		fsMocks.rm.mockResolvedValue(undefined);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const deps = createDeps(terminalManager);
		const api = createRuntimeApi(deps);

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(true);
		expect(result.newWorkingDirectory).toBe("/tmp/worktree");
		expect(terminalManager.stopTaskSessionAndWaitForExit).toHaveBeenCalledWith("task-1");
		expect(taskWorktreeMocks.captureTaskPatch).toHaveBeenCalled();
		expect(taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist).toHaveBeenCalled();
		expect(taskWorktreeMocks.applyTaskPatch).toHaveBeenCalledWith("/tmp/patches/task-1.patch", "/tmp/worktree");
		expect(deps.broadcaster.broadcastTaskWorkingDirectoryUpdated).toHaveBeenCalledWith(
			"project-1",
			"task-1",
			"/tmp/worktree",
			true,
		);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/worktree", resumeConversation: false }),
		);
	});

	it("preserves awaitReview when migrating a task in awaiting_review state", async () => {
		const card = createCard({ workingDirectory: "/tmp/repo" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.captureTaskPatch.mockResolvedValue(undefined);
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/worktree",
		});
		taskWorktreeMocks.findTaskPatch.mockResolvedValue(null);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/worktree", resumeConversation: false, awaitReview: true }),
		);
	});

	it("de-isolates a task from worktree to main checkout", async () => {
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "de-isolate",
		});

		expect(result.ok).toBe(true);
		expect(result.newWorkingDirectory).toBe("/tmp/repo");
		expect(terminalManager.stopTaskSessionAndWaitForExit).toHaveBeenCalledWith("task-1");
		expect(taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/repo" }));
	});

	it("returns error when task not found", async () => {
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);

		const api = createRuntimeApi(createDeps());

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found/);
	});

	it("resolves working directory from worktree state when not persisted on card", async () => {
		const card = createCard({ workingDirectory: undefined });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/resolved-worktree");
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/new-worktree",
		});
		taskWorktreeMocks.findTaskPatch.mockResolvedValue(null);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalled();
	});

	it("succeeds even when patch apply fails (non-fatal)", async () => {
		const card = createCard({ workingDirectory: "/tmp/repo" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.captureTaskPatch.mockResolvedValue(undefined);
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/worktree",
		});
		taskWorktreeMocks.findTaskPatch.mockResolvedValue({
			path: "/tmp/patches/task-1.patch",
			commit: "abc123",
		});
		taskWorktreeMocks.applyTaskPatch.mockRejectedValue(new Error("patch conflict"));
		fsMocks.rm.mockResolvedValue(undefined);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(true);
		expect(result.newWorkingDirectory).toBe("/tmp/worktree");
		// Patch file should still be cleaned up.
		expect(fsMocks.rm).toHaveBeenCalledWith("/tmp/patches/task-1.patch", { force: true });
	});

	it("returns error when no agent command is configured and session is running", async () => {
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(),
			stopTaskSessionAndWaitForExit: vi.fn(),
			startTaskSession: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "de-isolate",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/No runnable agent command/);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(terminalManager.stopTaskSessionAndWaitForExit).not.toHaveBeenCalled();
	});

	it("succeeds for idle tasks even when no agent command is configured", async () => {
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(),
			stopTaskSessionAndWaitForExit: vi.fn(),
			startTaskSession: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "de-isolate",
		});

		expect(result.ok).toBe(true);
		expect(result.newWorkingDirectory).toBe("/tmp/repo");
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(terminalManager.stopTaskSessionAndWaitForExit).not.toHaveBeenCalled();
	});

	it("restarts session at old CWD when worktree creation fails during isolate", async () => {
		const card = createCard({ workingDirectory: "/tmp/repo" });
		projectStateMocks.loadProjectState.mockResolvedValue(emptyBoard());
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.captureTaskPatch.mockResolvedValue(undefined);
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: false,
			error: "git worktree add failed",
		});

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			stopTaskSession: vi.fn(() => createSummary()),
			stopTaskSessionAndWaitForExit: vi.fn(async () => createSummary()),
			startTaskSession: vi.fn(async () => createSummary()),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const result = await api.migrateTaskWorkingDirectory(defaultScope, {
			taskId: "task-1",
			direction: "isolate",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/git worktree add failed/);
		// Session should have been restarted at the old CWD.
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/repo", resumeConversation: true }),
		);
	});
});

describe("createRuntimeApi startShellSession", () => {
	beforeEach(() => {
		taskWorktreeMocks.resolveTaskWorkingDirectory.mockReset();
		taskWorktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
	});

	it("uses resolveTaskWorkingDirectory for shell sessions", async () => {
		taskWorktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/my-worktree");

		const terminalManager = {
			startShellSession: vi.fn(async () => createSummary()),
		};
		const deps = createDeps(terminalManager);
		deps.resolveInteractiveShellCommand.mockReturnValue({ binary: "/bin/zsh", args: [] });
		const api = createRuntimeApi(deps);

		const result = await api.startShellSession(defaultScope, {
			taskId: "shell-1",
			projectTaskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskWorkingDirectory).toHaveBeenCalledWith({
			projectPath: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
		expect(terminalManager.startShellSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/my-worktree" }),
		);
	});

	it("uses project path when no projectTaskId is provided", async () => {
		const terminalManager = {
			startShellSession: vi.fn(async () => createSummary()),
		};
		const deps = createDeps(terminalManager);
		deps.resolveInteractiveShellCommand.mockReturnValue({ binary: "/bin/zsh", args: [] });
		const api = createRuntimeApi(deps);

		const result = await api.startShellSession(defaultScope, {
			taskId: "shell-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskWorkingDirectory).not.toHaveBeenCalled();
		expect(terminalManager.startShellSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/repo" }));
	});
});
