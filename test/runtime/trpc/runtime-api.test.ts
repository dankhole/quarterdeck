import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
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

const workspaceStateMocks = vi.hoisted(() => ({
	mutateWorkspaceState: vi.fn(async () => ({ value: null, state: null, saved: false })),
	loadWorkspaceState: vi.fn(),
}));

const taskBoardMutationMocks = vi.hoisted(() => ({
	findCardInBoard: vi.fn((): Record<string, unknown> | null => null),
}));

const realFsPromises = await vi.hoisted(async () => {
	const fs = await import("node:fs/promises");
	return { rm: fs.rm };
});

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

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
	getTaskWorkingDirectory: taskWorktreeMocks.getTaskWorkingDirectory,
	pathExists: taskWorktreeMocks.pathExists,
	applyTaskPatch: taskWorktreeMocks.applyTaskPatch,
	captureTaskPatch: taskWorktreeMocks.captureTaskPatch,
	ensureTaskWorktreeIfDoesntExist: taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist,
	findTaskPatch: taskWorktreeMocks.findTaskPatch,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
	loadWorkspaceState: workspaceStateMocks.loadWorkspaceState,
}));

vi.mock("../../../src/core/task-board-mutations.js", () => ({
	findCardInBoard: taskBoardMutationMocks.findCardInBoard,
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: vi.fn(),
}));

import { createRuntimeApi } from "../../../src/trpc/runtime-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
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

function createDeps(terminalManager: Record<string, unknown> = {}) {
	return {
		getActiveWorkspaceId: vi.fn(() => "workspace-1"),
		loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
		setActiveRuntimeConfig: vi.fn(),
		getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		resolveInteractiveShellCommand: vi.fn(),
		runCommand: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
	};
}

const defaultScope = {
	workspaceId: "workspace-1",
	workspacePath: "/tmp/repo",
};

describe("createRuntimeApi startTaskSession", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();
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
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
		// Default: card not found (legacy behavior — falls through to worktree lookup).
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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

	it("falls back to workspacePath when non-worktree task's persisted directory is deleted", async () => {
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
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
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
		});
	});

	it("starts home agent sessions in the workspace root without resolving a task worktree", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: homeTaskId,
			baseRef: "main",
			prompt: "",
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: homeTaskId,
				cwd: "/tmp/repo",
			}),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
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
		const api = createRuntimeApi({
			...createDeps(terminalManager),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
		});

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

	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [join(tempHome, ".kanban"), join(tempHome, ".kanban", "worktrees")];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});

		// resetAllState uses the mocked rm — restore to real for this test.
		// biome-ignore lint/complexity/noBannedTypes: test mock passthrough to real fs.rm
		fsMocks.rm.mockImplementation((...args: unknown[]) => (realFsPromises.rm as Function)(...args));

		const api = createRuntimeApi({
			...createDeps(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [join(tempHome, ".kanban"), join(tempHome, ".kanban", "worktrees")];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createRuntimeApi({
			...createDeps(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeApi migrateTaskWorkingDirectory", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		taskWorktreeMocks.captureTaskPatch.mockReset();
		taskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockReset();
		taskWorktreeMocks.findTaskPatch.mockReset();
		taskWorktreeMocks.applyTaskPatch.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
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
		workspaceStateMocks.mutateWorkspaceState.mockResolvedValue({ value: null, state: null, saved: false });
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});

	it("isolates a task from main checkout to a worktree", async () => {
		const card = createCard({ workingDirectory: "/tmp/repo" });
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		const api = createRuntimeApi(createDeps(terminalManager));

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
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/worktree", resumeFromTrash: false }),
		);
	});

	it("de-isolates a task from worktree to main checkout", async () => {
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		// State must NOT have been mutated — early return before side effects.
		expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
		expect(terminalManager.stopTaskSessionAndWaitForExit).not.toHaveBeenCalled();
	});

	it("succeeds for idle tasks even when no agent command is configured", async () => {
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
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
			expect.objectContaining({ cwd: "/tmp/repo", resumeFromTrash: true }),
		);
		// State should NOT have been mutated.
		expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});
});

describe("createRuntimeApi startShellSession", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceState.mockReset();
		taskWorktreeMocks.getTaskWorkingDirectory.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();

		workspaceStateMocks.loadWorkspaceState.mockResolvedValue(emptyBoard());
	});

	it("uses persisted workingDirectory for shell sessions", async () => {
		taskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue("/tmp/my-worktree");

		const terminalManager = {
			startShellSession: vi.fn(async () => createSummary()),
		};
		const deps = createDeps(terminalManager);
		deps.resolveInteractiveShellCommand.mockReturnValue({ binary: "/bin/zsh", args: [] });
		const api = createRuntimeApi(deps);

		const result = await api.startShellSession(defaultScope, {
			taskId: "shell-1",
			workspaceTaskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startShellSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/my-worktree" }),
		);
	});

	it("falls back to resolveTaskCwd when no persisted workingDirectory exists", async () => {
		taskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue(null);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree-from-lookup");

		const terminalManager = {
			startShellSession: vi.fn(async () => createSummary()),
		};
		const deps = createDeps(terminalManager);
		deps.resolveInteractiveShellCommand.mockReturnValue({ binary: "/bin/zsh", args: [] });
		const api = createRuntimeApi(deps);

		const result = await api.startShellSession(defaultScope, {
			taskId: "shell-1",
			workspaceTaskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalled();
		expect(terminalManager.startShellSession).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/worktree-from-lookup" }),
		);
	});
});
