import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core";
import { STORED_CODEX_RESUME_FAILED_WARNING } from "../../../src/terminal/codex-resume-failure";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
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

vi.mock("../../../src/config/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
	resolveTaskWorkingDirectory: taskWorktreeMocks.resolveTaskWorkingDirectory,
	getTaskWorkingDirectory: taskWorktreeMocks.getTaskWorkingDirectory,
	pathExists: taskWorktreeMocks.pathExists,
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
	return createTestTaskSessionSummary({
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		...overrides,
	});
}

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Test task",
		prompt: "Do something",
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
	"update",
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
	const store: Record<string, unknown> = {
		getSummary: vi.fn(() => null),
		applyTurnCheckpoint: vi.fn(),
	};
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

	it("surfaces a warning when Claude resume recreates a trashed task worktree", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const card = createCard({ workingDirectory: null, useWorktree: true });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/recreated-worktree");

		const update = vi.fn((taskId: string, patch: Record<string, unknown>) =>
			createSummary({
				taskId,
				warningMessage: String(patch.warningMessage ?? ""),
				sessionLaunchPath: "/tmp/recreated-worktree",
			}),
		);
		const terminalManager = {
			startTaskSession: vi.fn(async () =>
				createSummary({
					taskId: "task-1",
					agentId: "claude",
					sessionLaunchPath: "/tmp/recreated-worktree",
				}),
			),
			getSummary: vi.fn(() =>
				createSummary({
					taskId: "task-1",
					agentId: "claude",
					sessionLaunchPath: "/tmp/old-worktree",
				}),
			),
			update,
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "",
			resumeConversation: true,
			awaitReview: true,
			useWorktree: true,
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				warningMessage: expect.stringContaining("original task worktree was deleted"),
			}),
		);
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[task-session-start]"),
			"resume requested after task worktree identity was lost",
			expect.objectContaining({
				taskId: "task-1",
				agentId: "claude",
			}),
		);
		expect(response.summary?.warningMessage).toContain("original task worktree was deleted");
	});

	it("surfaces a warning when Codex resume has no stored session id", async () => {
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		const card = createCard({ workingDirectory: "/tmp/codex-worktree", useWorktree: true });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);

		const update = vi.fn((taskId: string, patch: Record<string, unknown>) =>
			createSummary({
				taskId,
				agentId: "codex",
				warningMessage: String(patch.warningMessage ?? ""),
				sessionLaunchPath: "/tmp/codex-worktree",
			}),
		);
		const terminalManager = {
			startTaskSession: vi.fn(async () =>
				createSummary({
					taskId: "task-1",
					agentId: "codex",
					sessionLaunchPath: "/tmp/codex-worktree",
					resumeSessionId: null,
				}),
			),
			getSummary: vi.fn(() =>
				createSummary({
					taskId: "task-1",
					agentId: "codex",
					sessionLaunchPath: "/tmp/codex-worktree",
					resumeSessionId: null,
				}),
			),
			update,
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "",
			resumeConversation: true,
			awaitReview: true,
			useWorktree: true,
		});

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				resumeConversation: true,
				resumeSessionId: undefined,
			}),
		);
		expect(update).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				warningMessage: expect.stringContaining("Codex resume did not have a stored session id"),
			}),
		);
		expect(response.summary?.warningMessage).toContain("Codex resume did not have a stored session id");
	});

	it("falls back to Codex --last after a stored session id already failed", async () => {
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		const card = createCard({ workingDirectory: "/tmp/codex-worktree", useWorktree: true });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);

		const failedSummary = createSummary({
			taskId: "task-1",
			agentId: "codex",
			state: "awaiting_review",
			reviewReason: "error",
			sessionLaunchPath: "/tmp/codex-worktree",
			resumeSessionId: "missing-session-id",
			warningMessage: "Resume failed before opening an interactive session (exit code 1).",
		});
		const update = vi.fn((taskId: string, patch: Record<string, unknown>) =>
			createSummary({
				taskId,
				agentId: "codex",
				warningMessage: String(patch.warningMessage ?? ""),
				sessionLaunchPath: "/tmp/codex-worktree",
				resumeSessionId: null,
			}),
		);
		const terminalManager = {
			startTaskSession: vi.fn(async () =>
				createSummary({
					taskId: "task-1",
					agentId: "codex",
					sessionLaunchPath: "/tmp/codex-worktree",
					resumeSessionId: null,
				}),
			),
			getSummary: vi.fn(() => failedSummary),
			update,
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "",
			resumeConversation: true,
			awaitReview: true,
			useWorktree: true,
		});

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				resumeConversation: true,
				resumeSessionId: undefined,
			}),
		);
		expect(update).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				warningMessage: STORED_CODEX_RESUME_FAILED_WARNING,
			}),
		);
		expect(response.summary?.warningMessage).toBe(STORED_CODEX_RESUME_FAILED_WARNING);
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

	it("does not wait for turn checkpoint capture before returning start response", async () => {
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(null);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const summary = createSummary({ taskId: "task-1", startedAt: 12_345 });
		const checkpoint = {
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 12_346,
		};
		let resolveCheckpoint: (value: typeof checkpoint) => void = () => {};
		const checkpointPromise = new Promise<typeof checkpoint>((resolve) => {
			resolveCheckpoint = resolve;
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReturnValueOnce(checkpointPromise);

		const applyTurnCheckpoint = vi.fn();
		const terminalManager = {
			startTaskSession: vi.fn(async () => summary),
			getSummary: vi.fn(() => summary),
			applyTurnCheckpoint,
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const responsePromise = api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Investigate startup freeze",
		});
		let racedResult: Awaited<typeof responsePromise> | "timed-out";
		try {
			racedResult = await Promise.race([
				responsePromise,
				new Promise<"timed-out">((resolve) => {
					setTimeout(() => resolve("timed-out"), 50);
				}),
			]);
		} finally {
			resolveCheckpoint(checkpoint);
		}

		expect(racedResult).toMatchObject({ ok: true });
		expect(applyTurnCheckpoint).not.toHaveBeenCalled();
		await responsePromise;
		await vi.waitFor(() => {
			expect(applyTurnCheckpoint).toHaveBeenCalledWith("task-1", checkpoint);
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
