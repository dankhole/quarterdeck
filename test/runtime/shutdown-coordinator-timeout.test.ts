import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeOwnedProcessShutdownOutcome, RuntimeTaskSessionSummary } from "../../src/core";
import { shutdownRuntimeServer } from "../../src/server";
import type { TerminalSessionManager } from "../../src/terminal";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";

vi.mock("../../src/state/project-state.js", () => ({
	loadSavedProjectStateById: vi.fn(),
	saveProjectSessions: vi.fn(),
	listProjectIndexEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/terminal/orphan-cleanup.js", () => ({
	killOrphanedAgentProcesses: vi.fn().mockResolvedValue(0),
}));

import {
	listProjectIndexEntries,
	loadSavedProjectStateById as loadProjectState,
	saveProjectSessions,
} from "../../src/state/project-state.js";
import { killOrphanedAgentProcesses } from "../../src/terminal/orphan-cleanup.js";

function createBoard(inProgressTaskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: inProgressTaskIds.map((id) => ({
					id,
					title: null,
					prompt: `Task ${id}`,
					baseRef: "main",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})),
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
	};
}

function createTerminalManagerStub(
	taskIds: string[],
	waitForShutdownQuiescence: Promise<void> = Promise.resolve(),
): TerminalSessionManager {
	const summaries: RuntimeTaskSessionSummary[] = taskIds.map((taskId) =>
		createTestTaskSessionSummary({
			taskId,
			state: "running",
			agentId: "codex",
			sessionLaunchPath: `/tmp/${taskId}`,
			pid: 1234,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
		}),
	);
	return {
		stopReconciliation: vi.fn(),
		markInterruptedAndStopAll: vi.fn().mockReturnValue(summaries),
		waitForShutdownQuiescence: vi.fn(() => waitForShutdownQuiescence),
		store: {
			listSummaries: vi.fn().mockReturnValue(summaries),
			getSummary: vi.fn((taskId: string) => summaries.find((s) => s.taskId === taskId) ?? null),
		},
	} as unknown as TerminalSessionManager;
}

describe("shutdown coordinator timeout", () => {
	beforeEach(() => {
		vi.mocked(listProjectIndexEntries).mockReset().mockResolvedValue([]);
		vi.mocked(loadProjectState).mockReset();
		vi.mocked(saveProjectSessions)
			.mockReset()
			.mockResolvedValue({} as never);
		vi.mocked(killOrphanedAgentProcesses).mockResolvedValue(0);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("allows an admitted producer to spawn while draining, then fences and snapshots its settled owners", async () => {
		vi.useFakeTimers();
		let finishProducer!: () => void;
		const producerGate = new Promise<void>((resolve) => {
			finishProducer = resolve;
		});
		const terminalManager = createTerminalManagerStub([]);
		let managers: ReturnType<Parameters<typeof shutdownRuntimeServer>[0]["projectRegistry"]["listManagedProjects"]> =
			[];
		let launchesAllowed = true;
		const events: string[] = [];
		const closeRuntimeServer = vi.fn(async () => {
			events.push("close");
		});
		const stopOwnedProcesses = vi.fn(async (stopSessions: () => void) => {
			expect(events).toEqual(["ingress-fenced", "producer-spawn", "spawn-fenced"]);
			expect(launchesAllowed).toBe(false);
			expect(terminalManager.markInterruptedAndStopAll).not.toHaveBeenCalled();
			events.push("snapshot");
			stopSessions();
			return { status: "stopped" as const };
		});
		const starting = shutdownRuntimeServer({
			projectRegistry: { listManagedProjects: () => managers },
			warn: vi.fn(),
			closeRuntimeServer,
			stopOwnedProcesses,
			cleanupTimeoutMs: 100,
			prepareForShutdown: async () => {
				events.push("ingress-fenced");
				await producerGate;
				expect(launchesAllowed).toBe(true);
				events.push("producer-spawn");
				managers = [{ projectId: "late-project", projectPath: "", terminalManager }];
			},
			beforeProcessSnapshot: () => {
				launchesAllowed = false;
				events.push("spawn-fenced");
			},
		});
		await vi.advanceTimersByTimeAsync(101);
		const result = await starting;
		expect(result.outcome).toMatchObject({
			status: "incomplete",
			safeToReleaseOwnership: false,
			reasons: ["deadline"],
		});
		expect(stopOwnedProcesses).not.toHaveBeenCalled();
		expect(closeRuntimeServer).not.toHaveBeenCalled();
		finishProducer();
		expect(await result.completion).toMatchObject({ status: "clean" });
		expect(terminalManager.markInterruptedAndStopAll).toHaveBeenCalledOnce();
		expect(events).toEqual(["ingress-fenced", "producer-spawn", "spawn-fenced", "snapshot", "close"]);
	});

	it("captures exact-owned roots before signals and awaits confirmed process cleanup", async () => {
		let resolveProcessCleanup: (outcome: RuntimeOwnedProcessShutdownOutcome) => void = () => {
			throw new Error("owned process cleanup did not start");
		};
		const processCleanup = new Promise<RuntimeOwnedProcessShutdownOutcome>((resolve) => {
			resolveProcessCleanup = resolve;
		});
		const terminalManager = createTerminalManagerStub([]);
		const stopOwnedProcesses = vi.fn(async (stopSessions: () => void) => {
			expect(terminalManager.markInterruptedAndStopAll).not.toHaveBeenCalled();
			stopSessions();
			stopSessions();
			return await processCleanup;
		});

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		let didResolveShutdown = false;
		const shutdownPromise = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [{ projectId: "test-project", projectPath: "", terminalManager }],
			},
			warn: vi.fn(),
			closeRuntimeServer,
			stopOwnedProcesses,
		}).then(() => {
			didResolveShutdown = true;
		});

		await vi.waitFor(() => {
			expect(stopOwnedProcesses).toHaveBeenCalledTimes(1);
		});
		expect(didResolveShutdown).toBe(false);
		expect(closeRuntimeServer).not.toHaveBeenCalled();
		expect(terminalManager.markInterruptedAndStopAll).toHaveBeenCalledTimes(1);

		resolveProcessCleanup({ status: "stopped" });
		await shutdownPromise;
		expect(didResolveShutdown).toBe(true);
		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(killOrphanedAgentProcesses).not.toHaveBeenCalled();
	});

	it("calls closeRuntimeServer even when cleanup operations hang", async () => {
		vi.useFakeTimers();

		const mockLoadProjectState = vi.mocked(loadProjectState);
		const mockSaveProjectSessions = vi.mocked(saveProjectSessions);

		const board = createBoard(["task-1"]);
		mockLoadProjectState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		let resolveWrite!: (state: Awaited<ReturnType<typeof saveProjectSessions>>) => void;
		mockSaveProjectSessions.mockReturnValue(
			new Promise((resolve) => {
				resolveWrite = resolve;
			}),
		);

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		const shutdownPromise = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn,
			closeRuntimeServer,
			stopOwnedProcesses: async (stopSessions) => {
				stopSessions();
				return { status: "stopped" };
			},
		});

		// Advance past the 7s cleanup timeout
		await vi.advanceTimersByTimeAsync(8000);
		const result = await shutdownPromise;
		expect(result.outcome).toEqual({
			status: "incomplete",
			safeToExit: false,
			safeToReleaseOwnership: false,
			reasons: ["deadline"],
		});
		let completed = false;
		void result.completion.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		resolveWrite({} as never);
		expect(await result.completion).toEqual({ status: "clean", safeToExit: true, safeToReleaseOwnership: true });
		expect(result.outcome.safeToReleaseOwnership).toBe(false);

		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
	});

	it("fences late shutdown persistence after runtime ownership is lost", async () => {
		vi.useFakeTimers();
		const board = createBoard(["task-1"]);
		vi.mocked(loadProjectState).mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();
		let resolvePreparation!: () => void;
		const preparation = new Promise<void>((resolve) => {
			resolvePreparation = resolve;
		});
		let ownsState = true;
		const shutdownPromise = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn,
			closeRuntimeServer,
			prepareForShutdown: () => preparation,
			persistenceAllowed: () => ownsState,
			stopOwnedProcesses: async (stopSessions) => {
				stopSessions();
				return { status: "stopped" };
			},
		});

		await vi.advanceTimersByTimeAsync(8000);
		const result = await shutdownPromise;
		ownsState = false;
		resolvePreparation();
		expect(await result.completion).toMatchObject({ status: "incomplete", reasons: ["ownership_lost"] });

		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		expect(saveProjectSessions).not.toHaveBeenCalled();
		expect(loadProjectState).not.toHaveBeenCalled();
		expect(listProjectIndexEntries).not.toHaveBeenCalled();
	});

	it("stops only owned processes without ordinary persistence when ownership was lost at entry", async () => {
		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const stopOwnedProcesses = vi.fn(async (stopSessions: () => void) => {
			stopSessions();
			return { status: "stopped" as const };
		});
		const result = await shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn: vi.fn(),
			closeRuntimeServer,
			stopOwnedProcesses,
			persistenceAllowed: () => false,
		});
		expect(result.outcome).toMatchObject({ status: "incomplete", reasons: ["ownership_lost"] });
		expect(stopOwnedProcesses).toHaveBeenCalledTimes(1);
		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(loadProjectState).not.toHaveBeenCalled();
		expect(listProjectIndexEntries).not.toHaveBeenCalled();
		expect(saveProjectSessions).not.toHaveBeenCalled();
		expect(killOrphanedAgentProcesses).not.toHaveBeenCalled();
	});

	it("drains pending task launches before loading the final session snapshot", async () => {
		let resolveQuiescence!: () => void;
		const pendingLaunch = new Promise<void>((resolve) => {
			resolveQuiescence = resolve;
		});
		const terminalManager = createTerminalManagerStub(["task-1"], pendingLaunch);
		vi.mocked(loadProjectState).mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board: createBoard(["task-1"]),
			sessions: {},
			revision: 1,
		});
		const shutdown = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{ projectId: "test-project", projectPath: "/tmp/test-project", terminalManager },
				],
			},
			warn: vi.fn(),
			closeRuntimeServer: async () => {},
			stopOwnedProcesses: async (stopSessions) => {
				stopSessions();
				return { status: "stopped" };
			},
		});
		await Promise.resolve();
		expect(loadProjectState).not.toHaveBeenCalled();
		resolveQuiescence();
		expect((await shutdown).outcome.status).toBe("clean");
	});

	it("completes normally when cleanup finishes within timeout", async () => {
		const mockLoadProjectState = vi.mocked(loadProjectState);
		const mockSaveProjectSessions = vi.mocked(saveProjectSessions);

		const board = createBoard(["task-1"]);
		mockLoadProjectState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		mockSaveProjectSessions.mockResolvedValue({} as never);

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		const result = await shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn,
			closeRuntimeServer,
			stopOwnedProcesses: async (stopSessions) => {
				stopSessions();
				return { status: "stopped" };
			},
		});

		expect(result.outcome).toEqual({ status: "clean", safeToExit: true, safeToReleaseOwnership: true });
		expect(await result.completion).toEqual(result.outcome);
		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("timed out"));
	});

	it("waits for every sibling write after a persistence failure", async () => {
		vi.useFakeTimers();
		const board = createBoard(["task-1"]);
		vi.mocked(loadProjectState).mockImplementation(async (repoPath) => ({
			repoPath,
			statePath: `${repoPath}/.quarterdeck`,
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		}));
		vi.mocked(listProjectIndexEntries).mockResolvedValue([
			{ projectId: "second-project", repoPath: "/tmp/second-project" } as never,
		]);
		let resolveWrite!: (state: Awaited<ReturnType<typeof saveProjectSessions>>) => void;
		vi.mocked(saveProjectSessions)
			.mockRejectedValueOnce(new Error("disk failure"))
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveWrite = resolve;
				}),
			);
		const shutdown = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn: vi.fn(),
			closeRuntimeServer: async () => {},
			cleanupTimeoutMs: 100,
			stopOwnedProcesses: async (stopSessions) => {
				stopSessions();
				return { status: "stopped" };
			},
		});
		await vi.advanceTimersByTimeAsync(101);
		const result = await shutdown;
		expect(result.outcome).toMatchObject({ status: "incomplete", reasons: ["persistence_failed", "deadline"] });
		let completed = false;
		void result.completion.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		resolveWrite({} as never);
		expect(await result.completion).toMatchObject({ status: "incomplete", reasons: ["persistence_failed"] });
	});

	it.each(["preparation", "processes", "close"])(
		"does not hide %s failures behind a resolved promise",
		async (step) => {
			const result = await shutdownRuntimeServer({
				projectRegistry: { listManagedProjects: () => [] },
				warn: vi.fn(),
				prepareForShutdown: async () => {
					if (step === "preparation") throw new Error("failed to drain producer");
				},
				stopOwnedProcesses: async (stopSessions) => {
					stopSessions();
					if (step === "processes") throw new Error("failed to verify owned descendants");
					return { status: "stopped" };
				},
				closeRuntimeServer: async () => {
					if (step === "close") throw new Error("failed to close server");
				},
			});
			const reason =
				step === "preparation"
					? "quiescence_failed"
					: step === "processes"
						? "processes_unconfirmed"
						: "server_close_failed";
			expect(result.outcome).toMatchObject({
				status: "incomplete",
				reasons: [reason],
				safeToReleaseOwnership: false,
			});
		},
	);

	it("requires exact-owned process confirmation for managed projects", async () => {
		const result = await shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{ projectId: "test-project", projectPath: "", terminalManager: createTerminalManagerStub([]) },
				],
			},
			warn: vi.fn(),
			closeRuntimeServer: async () => {},
		});
		expect(result.outcome).toMatchObject({ status: "incomplete", reasons: ["processes_unconfirmed"] });
		expect(killOrphanedAgentProcesses).not.toHaveBeenCalled();
	});

	it("never reports crash simulation with skipped session cleanup as clean", async () => {
		const terminalManager = createTerminalManagerStub([]);
		const result = await shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [{ projectId: "test-project", projectPath: "", terminalManager }],
			},
			warn: vi.fn(),
			closeRuntimeServer: async () => {},
			skipSessionCleanup: true,
		});
		expect(result.outcome).toMatchObject({ status: "incomplete", reasons: ["session_cleanup_skipped"] });
		expect(terminalManager.markInterruptedAndStopAll).not.toHaveBeenCalled();
	});
});
