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
	resolveAgentCommandForLaunch: agentRegistryMocks.resolveAgentCommand,
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

import { TaskResourceOperationCoordinator } from "../../../src/core";
import { startTaskSessionThroughService } from "../../../src/server/task-session-start-service";
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
	"applySessionEvent",
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
		taskResourceOperations: new TaskResourceOperationCoordinator(),
		resolveInteractiveShellCommand: vi.fn(),
		hostIntegrations: {
			capabilities: { nativeUiAvailable: true, hostIntegrationMode: "native" } as const,
			pickDirectory: vi.fn(),
			openPath: vi.fn(),
			openExternalUrl: vi.fn(),
			openProject: vi.fn(),
		},
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

	it("uses the task card agent for fresh starts", async () => {
		const card = createCard({ agentId: "codex", workingDirectory: "/tmp/codex-worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);
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
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
		});

		expect(response.ok).toBe(true);
		expect(agentRegistryMocks.resolveAgentCommand).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAgentId: "codex" }),
		);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "codex", binary: "codex" }),
		);
	});

	it("passes the Claude fullscreen setting into the task session launch", async () => {
		const card = createCard({ agentId: "claude", workingDirectory: "/tmp/claude-worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const deps = createDeps(terminalManager);
		deps.config.loadScopedRuntimeConfig.mockResolvedValue(
			createTestRuntimeConfigState({ claudeFullscreenEnabled: true }),
		);
		const api = createRuntimeApi(deps);

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
		});

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "claude",
				claudeFullscreenEnabled: true,
			}),
		);
	});

	it("passes the Codex approve-for-me setting into the task session launch", async () => {
		const card = createCard({ agentId: "codex", workingDirectory: "/tmp/codex-worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.pathExists.mockResolvedValue(true);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const deps = createDeps(terminalManager);
		deps.config.loadScopedRuntimeConfig.mockResolvedValue(
			createTestRuntimeConfigState({ selectedAgentId: "codex", codexApprovalsReviewer: "auto_review" }),
		);
		const api = createRuntimeApi(deps);

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
			prompt: "Do something",
		});

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				codexApprovalsReviewer: "auto_review",
			}),
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

	it("does not warn when Claude trash restore has a stored session id", async () => {
		const card = createCard({ workingDirectory: null, useWorktree: true });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/recreated-worktree");

		const update = vi.fn();
		const terminalManager = {
			startTaskSession: vi.fn(async () =>
				createSummary({
					taskId: "task-1",
					agentId: "claude",
					sessionLaunchPath: "/tmp/recreated-worktree",
					resumeSessionId: "claude-session-1",
				}),
			),
			getSummary: vi.fn(() =>
				createSummary({
					taskId: "task-1",
					agentId: "claude",
					sessionLaunchPath: "/tmp/old-worktree",
					resumeSessionId: "claude-session-1",
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
				agentId: "claude",
				resumeConversation: true,
				resumeSessionId: "claude-session-1",
			}),
		);
		expect(update).not.toHaveBeenCalled();
		expect(response.summary?.warningMessage).toBeNull();
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

	it("pins a bounded startup retry to the original stored Codex session id", async () => {
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		const card = createCard({ workingDirectory: "/tmp/codex-worktree", useWorktree: true });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		const failedSummary = createSummary({
			taskId: "task-1",
			agentId: "codex",
			state: "awaiting_review",
			reviewReason: "error",
			resumeSessionId: null,
			warningMessage: STORED_CODEX_RESUME_FAILED_WARNING,
		});
		const startTaskSessionWithReadiness = vi.fn(async () => ({
			summary: createSummary({ agentId: "codex", resumeSessionId: "original-session-id" }),
			sessionInstanceId: "launch-2",
			startedNewSession: true,
		}));
		const deps = createDeps({
			getSummary: vi.fn(() => failedSummary),
			startTaskSessionWithReadiness,
		});

		const result = await startTaskSessionThroughService(
			defaultScope,
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "",
				resumeConversation: true,
				awaitReview: true,
				useWorktree: true,
			},
			deps,
			{
				startupRecoveryToken: "recovery-token",
				resumeSessionIdOverride: "original-session-id",
				startupRecoveryReviewState: {
					reviewReason: "hook",
					lastHookAt: 123,
					latestHookActivity: null,
				},
			},
		);

		expect(result.sessionInstanceId).toBe("launch-2");
		expect(startTaskSessionWithReadiness).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeConversation: true,
				resumeSessionId: "original-session-id",
				startupRecoveryToken: "recovery-token",
				startupRecoveryReviewState: {
					reviewReason: "hook",
					lastHookAt: 123,
					latestHookActivity: null,
				},
			}),
		);
	});

	it("waits for an earlier task resource operation before preparing and launching", async () => {
		const taskResourceOperations = new TaskResourceOperationCoordinator();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = taskResourceOperations.run("project-1", "task-1", async () => await gate);
		await Promise.resolve();
		const card = createCard({ workingDirectory: "/tmp/worktree" });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);
		const startTaskSession = vi.fn(async () => createSummary());
		const deps = { ...createDeps({ startTaskSession }), taskResourceOperations };

		const start = startTaskSessionThroughService(
			defaultScope,
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Do something",
				useWorktree: true,
			},
			deps,
		);
		await Promise.resolve();
		expect(projectStateMocks.loadProjectState).not.toHaveBeenCalled();
		expect(startTaskSession).not.toHaveBeenCalled();

		release();
		await blocker;
		await expect(start).resolves.toMatchObject({ taskCwd: "/tmp/worktree" });
		expect(startTaskSession).toHaveBeenCalledTimes(1);
	});

	it("checks terminal runtime health before creating a task worktree", async () => {
		const runtimeFailure = new Error("terminal runtime unavailable");
		const deps = {
			...createDeps(),
			assertTerminalRuntimeAvailable: vi.fn(() => {
				throw runtimeFailure;
			}),
		};

		await expect(
			startTaskSessionThroughService(
				defaultScope,
				{
					taskId: "task-1",
					baseRef: "main",
					prompt: "Do something",
					useWorktree: true,
				},
				deps,
			),
		).rejects.toBe(runtimeFailure);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(projectStateMocks.loadProjectState).not.toHaveBeenCalled();
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

	it("starts a shared-checkout task when its base branch is unresolved", async () => {
		const card = createCard({ baseRef: "", workingDirectory: null, useWorktree: false });
		taskBoardMutationMocks.findCardInBoard.mockReturnValue(card);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ sessionLaunchPath: "/tmp/repo" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "",
			prompt: "Do something",
			useWorktree: false,
		});

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/repo",
				env: undefined,
			}),
		);
	});

	it("still rejects an unresolved base branch for isolated tasks", async () => {
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createRuntimeApi(createDeps(terminalManager));

		const response = await api.startTaskSession(defaultScope, {
			taskId: "task-1",
			baseRef: "",
			prompt: "Do something",
			useWorktree: true,
		});

		expect(response).toEqual({
			ok: false,
			summary: null,
			error: "Select a base branch before starting this task.",
		});
		expect(projectStateMocks.loadProjectState).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
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

describe("createRuntimeApi stopTaskSession", () => {
	it("preserves waitForExit and reports a confirmed exit", async () => {
		const stopTaskSessionAndWaitForExit = vi.fn(async () => ({
			summary: createSummary({ state: "awaiting_review", reviewReason: "interrupted", pid: null }),
			didExit: true,
			outcome: "exited" as const,
		}));
		const api = createRuntimeApi(createDeps({ stopTaskSessionAndWaitForExit }));

		const response = await api.stopTaskSession(defaultScope, { taskId: "task-1", waitForExit: true });

		expect(stopTaskSessionAndWaitForExit).toHaveBeenCalledWith("task-1", 3_000, undefined);
		expect(response).toMatchObject({ ok: true, didExit: true, outcome: "exited" });
	});

	it("reports a stop timeout as a failed response", async () => {
		const stopTaskSessionAndWaitForExit = vi.fn(async () => ({
			summary: createSummary({ state: "awaiting_review", reviewReason: "interrupted", pid: 1234 }),
			didExit: false,
			outcome: "timed_out" as const,
			error: "Task session did not exit before the timeout.",
		}));
		const api = createRuntimeApi(createDeps({ stopTaskSessionAndWaitForExit }));

		const response = await api.stopTaskSession(defaultScope, { taskId: "task-1", waitForExit: true });

		expect(response).toMatchObject({
			ok: false,
			didExit: false,
			outcome: "timed_out",
			error: "Task session did not exit before the timeout.",
		});
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

describe("createRuntimeApi native UI operations", () => {
	it("fails host file opening closed when native UI is unavailable", async () => {
		const deps = createDeps();
		deps.hostIntegrations.openPath.mockResolvedValue({
			ok: false,
			reason: "native_ui_unavailable",
			error: "Native UI is unavailable.",
		});
		const api = createRuntimeApi(deps);

		await expect(api.openFile(null, { filePath: "/tmp/config.json" })).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
	});
});

describe("createRuntimeApi openProject", () => {
	it("accepts only a typed target and derives the project path from server scope", async () => {
		const deps = createDeps();
		deps.hostIntegrations.openProject.mockResolvedValue({ ok: true, outcome: "native" });
		const api = createRuntimeApi(deps);

		await api.openProject(defaultScope, { targetId: "cursor" });

		expect(deps.hostIntegrations.openProject).toHaveBeenCalledWith("cursor", "/tmp/repo", {
			projectId: "project-1",
		});
	});

	it("rejects browser-supplied shell commands and working directories", async () => {
		const deps = createDeps();
		const api = createRuntimeApi(deps);

		await expect(
			api.openProject(defaultScope, {
				targetId: "cursor",
				command: "touch /tmp/should-not-run",
				cwd: "/tmp/untrusted",
			} as never),
		).rejects.toThrow();
		expect(deps.hostIntegrations.openProject).not.toHaveBeenCalled();
	});

	it("rejects unknown open targets", async () => {
		const deps = createDeps();
		const api = createRuntimeApi(deps);

		await expect(api.openProject(defaultScope, { targetId: "shell-command" } as never)).rejects.toThrow(
			"Invalid option",
		);
		expect(deps.hostIntegrations.openProject).not.toHaveBeenCalled();
	});
});
