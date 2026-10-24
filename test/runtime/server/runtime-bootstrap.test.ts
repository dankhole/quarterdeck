import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createRuntimeCapabilities,
	type RuntimeHookIngestRequest,
	type RuntimeProjectStateResponse,
	type RuntimeShutdownOutcome,
} from "../../../src/core";
import { enqueueHookTransition } from "../../../src/hook-transition-outbox";
import { RuntimeStartupCleanupError, startRuntime } from "../../../src/server/runtime-bootstrap";
import type { CreateRuntimeServerDependencies } from "../../../src/server/runtime-server";
import type {
	RuntimeShutdownCoordinatorDependencies,
	RuntimeShutdownResult,
	shutdownRuntimeServer,
} from "../../../src/server/shutdown-coordinator";
import { listProjectIndexEntries } from "../../../src/state";
import * as relocationJournal from "../../../src/state/project-relocation-journal";
import { createHooksApi } from "../../../src/trpc/hooks-api";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const diagnostics = {
		runtimeInstanceId: "test-runtime-instance",
		registerSnapshotProvider: vi.fn(),
		recordEvent: vi.fn(),
		fail: vi.fn(async () => undefined),
	};
	const persistenceClose = vi.fn(async (_options?: { skipPersistence?: boolean }) => undefined);
	const server = {
		url: "http://127.0.0.1:3500",
		getQuitSummary: vi.fn(() => ({ liveProcessCount: 2, pendingLaunches: true })),
		prepareForShutdown: vi.fn(async () => undefined),
		stopPersistenceForShutdown: vi.fn(async (options?: { persistenceAllowed?: boolean }) => {
			await persistenceClose({ skipPersistence: options?.persistenceAllowed === false });
		}),
		stopTaskOwnersForShutdown: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	const projectRegistry = {
		getActiveRuntimeConfig: () => ({ logLevel: "info", backupIntervalMinutes: 10 }),
		listManagedProjects: () => [],
		initializeIndexedProjectsForStartup: vi.fn(async () => undefined),
	};
	return {
		calls,
		diagnostics,
		server,
		projectRegistry,
		createRuntimeDiagnostics: vi.fn(async () => {
			calls.push("diagnostics");
			return diagnostics;
		}),
		cleanupGlobalStaleLockArtifacts: vi.fn(async () => {
			calls.push("cleanup");
		}),
		createRuntimeServer: vi.fn(async () => {
			calls.push("listening");
			return server;
		}),
		stopPeriodicBackups: vi.fn(),
		persistenceClose,
		loadSavedProjectStateById: vi.fn(async (_projectId: string): Promise<RuntimeProjectStateResponse | null> => null),
		saveProjectSessions: vi.fn(async () => undefined),
		hubClose: vi.fn(async () => undefined),
		waitForPendingBackups: vi.fn(async () => undefined),
		shutdownRuntimeServer: vi.fn(
			async (deps: RuntimeShutdownCoordinatorDependencies): Promise<RuntimeShutdownResult> => {
				await deps.prepareForShutdown?.();
				const processes = await deps.stopOwnedProcesses?.(() => undefined);
				await deps.stopPersistenceForShutdown?.();
				if (processes?.status !== "unconfirmed") await deps.closeRuntimeServer();
				const outcome: RuntimeShutdownOutcome =
					processes?.status === "unconfirmed"
						? {
								status: "incomplete",
								safeToExit: false,
								safeToReleaseOwnership: false,
								reasons: ["processes_unconfirmed"],
							}
						: {
								status: "clean",
								safeToExit: true,
								safeToReleaseOwnership: true,
							};
				return { outcome, completion: Promise.resolve(outcome) };
			},
		),
	};
});

vi.mock("../../../src/config", () => ({
	loadGlobalRuntimeConfig: vi.fn(),
	loadRuntimeConfig: vi.fn(),
	migrateLegacyProjectConfig: vi.fn(),
	setAgentAvailabilityDiagnosticSink: vi.fn(),
	waitForPendingAgentAvailabilityProbes: vi.fn(async () => undefined),
}));
vi.mock("../../../src/diagnostics/runtime-diagnostics", () => ({
	createRuntimeDiagnostics: mocks.createRuntimeDiagnostics,
}));
vi.mock("../../../src/fs/lock-cleanup", () => ({
	cleanupGlobalStaleLockArtifacts: mocks.cleanupGlobalStaleLockArtifacts,
	cleanupProjectStaleLockArtifacts: vi.fn(),
}));
vi.mock("../../../src/state", () => ({
	listProjectIndexEntries: vi.fn(async () => []),
	loadSavedProjectStateById: mocks.loadSavedProjectStateById,
	saveProjectSessions: mocks.saveProjectSessions,
	ProjectBoardCommandService: class {},
	pruneProjectSessionsForBoard: vi.fn(),
}));
vi.mock("../../../src/state/state-backup", () => ({
	createBackup: vi.fn(async () => null),
	listBackups: vi.fn(async () => []),
	startPeriodicBackups: vi.fn(),
	stopPeriodicBackups: mocks.stopPeriodicBackups,
	waitForPendingBackups: mocks.waitForPendingBackups,
}));
vi.mock("../../../src/server/project-registry", () => ({
	createProjectRegistry: vi.fn(async () => mocks.projectRegistry),
	collectProjectWorktreeTaskIdsForRemoval: vi.fn(),
}));
vi.mock("../../../src/server/runtime-server", () => ({
	createRuntimeServer: mocks.createRuntimeServer,
}));
vi.mock("../../../src/server/runtime-session-persistence", () => ({
	RuntimeSessionPersistence: class {
		close = mocks.persistenceClose;
		stopForShutdown = mocks.persistenceClose;
	},
}));
vi.mock("../../../src/server/runtime-state-hub", () => ({
	createRuntimeStateHub: vi.fn(() => ({ close: mocks.hubClose })),
}));
vi.mock("../../../src/server/shutdown-coordinator", () => ({
	shutdownRuntimeServer: mocks.shutdownRuntimeServer,
}));
vi.mock("../../../src/server/owned-process-shutdown", () => ({
	createRuntimeOwnedProcessShutdown: vi.fn(() => async (stopSessions: () => void) => {
		stopSessions();
		return { status: "stopped" };
	}),
}));
vi.mock("../../../src/terminal/pty-runtime-health", () => ({
	inspectPtyRuntimeHealth: vi.fn(() => ({ available: true })),
	PTY_RUNTIME_REMEDIATION: "Unavailable terminal dependency",
	PtyRuntimeDependencyError: class extends Error {},
}));
vi.mock("../../../src/trpc/hooks-api", () => ({ createHooksApi: vi.fn() }));

describe("runtime bootstrap entry points", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listProjectIndexEntries).mockResolvedValue([]);
		mocks.loadSavedProjectStateById.mockReset().mockResolvedValue(null);
		mocks.saveProjectSessions.mockReset().mockResolvedValue(undefined);
		mocks.calls.length = 0;
		vi.stubEnv("QUARTERDECK_AGENT_LAB", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("awaits admission before startup mutations and publishes readiness after listening", async () => {
		let admit: (() => void) | undefined;
		const admission = new Promise<void>((resolve) => {
			admit = resolve;
		});
		const onReady = vi.fn(() => {
			mocks.calls.push("ready");
		});
		const starting = startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
			beforeStartup: () => admission,
			onReady,
		});
		expect(mocks.calls).toEqual([]);
		admit?.();
		const runtime = await starting;
		expect(mocks.calls).toEqual(["diagnostics", "cleanup", "listening", "ready"]);
		expect(onReady).toHaveBeenCalledExactlyOnceWith(runtime);
		expect(runtime.diagnostics.runtimeInstanceId).toBe("test-runtime-instance");
		expect(runtime.getQuitSummary()).toEqual({ liveProcessCount: 2, pendingLaunches: true });
		await runtime.shutdown();
	});

	it("does not mutate diagnostics or project state when lifetime admission rejects", async () => {
		const denied = new Error("Another runtime owns this state home");
		await expect(
			startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
				beforeStartup: async () => {
					throw denied;
				},
			}),
		).rejects.toBe(denied);
		expect(mocks.calls).toEqual([]);
	});

	it("inspects prior process evidence before cleanup can prune persisted sessions", async () => {
		const denied = new Error("A saved process is still live");
		await expect(
			startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
				beforeRecovery: async () => {
					mocks.calls.push("recovery-admission");
					throw denied;
				},
			}),
		).rejects.toBe(denied);
		expect(mocks.calls).toEqual(["diagnostics", "recovery-admission"]);
		expect(mocks.cleanupGlobalStaleLockArtifacts).not.toHaveBeenCalled();
		expect(mocks.diagnostics.fail).toHaveBeenCalledExactlyOnceWith(denied);
	});

	it("shares a single shutdown operation between process controllers", async () => {
		const runtime = await startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
		});
		const first = runtime.shutdown({ skipSessionCleanup: true });
		const second = runtime.shutdown();
		expect(second).toBe(first);
		await first;
		expect(mocks.stopPeriodicBackups).toHaveBeenCalledTimes(1);
		expect(mocks.server.prepareForShutdown).toHaveBeenCalledExactlyOnceWith({
			skipSessionCleanup: true,
			persistenceAllowed: true,
		});
		expect(mocks.shutdownRuntimeServer).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ skipSessionCleanup: true, skipOrphanProcessCleanup: true }),
		);
		expect(mocks.server.close).toHaveBeenCalledTimes(1);
	});

	it("defers owner disposal on incomplete cleanup and retries after actual completion", async () => {
		const stopOwnedProcesses = vi
			.fn()
			.mockImplementationOnce(async (prepare: () => void) => {
				prepare();
				return { status: "unconfirmed" };
			})
			.mockImplementationOnce(async (prepare: () => void) => {
				prepare();
				return { status: "stopped" };
			});
		const runtime = await startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
			stopOwnedProcesses,
		});
		const first = await runtime.shutdown();
		expect(await first.completion).toMatchObject({ status: "incomplete" });
		expect(mocks.server.stopTaskOwnersForShutdown).not.toHaveBeenCalled();
		expect(mocks.server.close).not.toHaveBeenCalled();
		const second = await runtime.shutdown();
		expect(await second.completion).toMatchObject({ status: "clean" });
		expect(stopOwnedProcesses).toHaveBeenCalledTimes(2);
		expect(mocks.shutdownRuntimeServer.mock.calls[1]?.[0].persistenceAlreadyStopped).toBe(true);
		expect(mocks.server.stopTaskOwnersForShutdown).toHaveBeenCalledOnce();
		expect(mocks.server.close).toHaveBeenCalledOnce();
	});

	it.each(["persistence_failed", "quiescence_failed"] as const)(
		"retains finalized %s for an indexed project without an automatic writer on process retry",
		async (failure) => {
			const actual = await vi.importActual<{ shutdownRuntimeServer: typeof shutdownRuntimeServer }>(
				"../../../src/server/shutdown-coordinator",
			);
			mocks.shutdownRuntimeServer
				.mockImplementationOnce(actual.shutdownRuntimeServer)
				.mockImplementationOnce(actual.shutdownRuntimeServer);
			vi.mocked(listProjectIndexEntries).mockResolvedValue([
				{ projectId: "indexed-project", repoPath: "/synthetic/indexed-project" },
			]);
			mocks.loadSavedProjectStateById.mockResolvedValue({
				repoPath: "/synthetic/indexed-project",
				statePath: "/synthetic/state",
				revision: 1,
				git: { currentBranch: "main", defaultBranch: "main", branches: [] },
				board: {
					columns: [
						{
							id: "in_progress",
							title: "In Progress",
							cards: [
								{
									id: "task",
									title: null,
									prompt: "synthetic task",
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							],
						},
					],
				},
				sessions: {
					task: createTestTaskSessionSummary({
						taskId: "task",
						state: "running",
						resumeSessionId: "exact-resume",
					}),
				},
			});
			if (failure === "persistence_failed")
				mocks.saveProjectSessions.mockRejectedValueOnce(new Error("synthetic disk failure"));
			else mocks.server.prepareForShutdown.mockRejectedValueOnce(new Error("synthetic preparation failure"));
			let attempts = 0;
			const stopOwnedProcesses = vi.fn(async (prepare: () => void) => {
				prepare();
				return ++attempts === 1 ? { status: "unconfirmed" as const } : { status: "stopped" as const };
			});
			const runtime = await startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
				stopOwnedProcesses,
				warn: vi.fn(),
			});
			const first = await runtime.shutdown();
			expect(await first.completion).toMatchObject({
				status: "incomplete",
				reasons: expect.arrayContaining([failure, "processes_unconfirmed"]),
			});
			const second = await runtime.shutdown();
			expect(await second.completion).toEqual({
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: [failure],
			});
			expect(stopOwnedProcesses).toHaveBeenCalledTimes(2);
			expect(mocks.shutdownRuntimeServer.mock.calls[1]?.[0]).toMatchObject({
				persistenceAlreadyStopped: true,
				finalizedPersistenceFailures: [failure],
			});
			expect(mocks.projectRegistry.listManagedProjects()).toEqual([]);
			expect(mocks.saveProjectSessions).toHaveBeenCalledTimes(failure === "persistence_failed" ? 1 : 0);
			expect(mocks.server.close).toHaveBeenCalledOnce();
		},
	);

	it("does not start a second bootstrap cleanup while a bounded report is still draining", async () => {
		const incomplete: RuntimeShutdownOutcome = {
			status: "incomplete",
			safeToExit: false,
			safeToReleaseOwnership: false,
			reasons: ["processes_unconfirmed"],
		};
		let settle!: (outcome: RuntimeShutdownOutcome) => void;
		const completion = new Promise<RuntimeShutdownOutcome>((resolve) => {
			settle = resolve;
		});
		mocks.shutdownRuntimeServer.mockResolvedValueOnce({
			outcome: { ...incomplete, reasons: ["deadline"] },
			completion,
		});
		const runtime = await startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
		});
		const first = runtime.shutdown();
		await first;
		expect(runtime.shutdown()).toBe(first);
		expect(mocks.shutdownRuntimeServer).toHaveBeenCalledOnce();
		settle(incomplete);
		await completion;
		const retry = runtime.shutdown();
		expect(retry).not.toBe(first);
		expect((await retry).outcome).toMatchObject({ status: "clean" });
		expect(mocks.shutdownRuntimeServer).toHaveBeenCalledTimes(2);
	});

	it("captures owned processes before owner signals and drains structured stops before final close", async () => {
		let finish!: () => void;
		const structuredDrain = new Promise<void>((resolve) => {
			finish = resolve;
		});
		mocks.server.stopTaskOwnersForShutdown.mockImplementationOnce(async () => {
			await structuredDrain;
			return undefined;
		});
		const stopOwnedProcesses = vi.fn(async (stopSessions: () => void) => {
			expect(mocks.server.stopTaskOwnersForShutdown).not.toHaveBeenCalled();
			stopSessions();
			return { status: "stopped" as const };
		});
		const runtime = await startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
			stopOwnedProcesses,
		});
		const stopping = runtime.shutdown();
		await vi.waitFor(() => expect(mocks.server.stopTaskOwnersForShutdown).toHaveBeenCalledOnce());
		expect(mocks.server.close).not.toHaveBeenCalled();
		finish();
		await stopping;
		expect(stopOwnedProcesses).toHaveBeenCalledOnce();
		expect(mocks.server.close).toHaveBeenCalledOnce();
	});

	it("shuts down the started listener if the ready handoff fails", async () => {
		const disconnected = new Error("Parent disconnected before ready");
		await expect(
			startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
				onReady: () => {
					throw disconnected;
				},
			}),
		).rejects.toBe(disconnected);
		expect(mocks.server.close).toHaveBeenCalledTimes(1);
		expect(mocks.diagnostics.fail).toHaveBeenCalledExactlyOnceWith(disconnected);
	});

	it("drains partial bootstrap owners when server construction fails", async () => {
		const failed = new Error("Failed to bind listener");
		mocks.createRuntimeServer.mockRejectedValueOnce(failed);
		await expect(
			startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
			}),
		).rejects.toBe(failed);
		expect(mocks.waitForPendingBackups).toHaveBeenCalledOnce();
		expect(mocks.persistenceClose).toHaveBeenCalledExactlyOnceWith({ skipPersistence: false });
		expect(mocks.hubClose).toHaveBeenCalledOnce();
		expect(mocks.server.close).not.toHaveBeenCalled();
	});

	it("discards queued session projections and forwards the lost ownership fence", async () => {
		const runtime = await startRuntime({
			capabilities: createRuntimeCapabilities("unavailable"),
			quarterdeckVersion: "test-version",
		});
		await runtime.shutdown({ persistenceAllowed: false });
		expect(mocks.persistenceClose).toHaveBeenCalledExactlyOnceWith({ skipPersistence: true });
		const deps = mocks.shutdownRuntimeServer.mock.calls[0]?.[0];
		expect(deps).toEqual(expect.objectContaining({ persistenceAllowed: expect.any(Function) }));
		expect(mocks.server.prepareForShutdown).toHaveBeenCalledExactlyOnceWith({
			skipSessionCleanup: false,
			persistenceAllowed: false,
		});
		expect(mocks.server.close).toHaveBeenCalledExactlyOnceWith({ persistenceAllowed: false });
	});

	it("holds startup outbox replay for a project whose relocation journal is pending", async () => {
		const stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-bootstrap-outbox-"));
		vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
		const journal = vi
			.spyOn(relocationJournal, "readProjectRelocationJournal")
			.mockImplementation(async (projectId) =>
				projectId === "relocating-project" ? ({} as relocationJournal.ProjectRelocationJournal) : null,
			);
		try {
			const hook = (projectId: string, index: number): RuntimeHookIngestRequest => ({
				taskId: "task-1",
				projectId,
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop", sessionInstanceId: "process-1" },
				delivery: { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, occurredAt: index },
			});
			await enqueueHookTransition(hook("relocating-project", 1));
			await enqueueHookTransition(hook("settled-project", 2));
			const ingest = vi.fn(async (_request: RuntimeHookIngestRequest) => ({ ok: true as const }));
			vi.mocked(createHooksApi).mockReturnValue({ ingest });
			const runtime = await startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
			});
			try {
				const [serverDeps] = mocks.createRuntimeServer.mock.calls[0] as unknown as [
					Pick<CreateRuntimeServerDependencies, "initializeProjectsForStartup">,
				];
				await serverDeps.initializeProjectsForStartup?.();
				const [startup] = mocks.projectRegistry.initializeIndexedProjectsForStartup.mock.calls[0] as unknown as [
					{ beforeRecovery: () => Promise<unknown> },
				];

				await expect(startup.beforeRecovery()).resolves.toEqual({
					blockAllRecovery: false,
					blockedTasks: [{ projectId: "relocating-project", taskId: "task-1" }],
				});
				expect(ingest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: "settled-project" }));
			} finally {
				await runtime.shutdown();
			}
		} finally {
			journal.mockRestore();
			await rm(stateHome, { recursive: true, force: true });
		}
	});

	it("retains an incomplete startup cleanup outcome for the lifetime owner", async () => {
		const failed = new Error("Failed to bind listener");
		mocks.createRuntimeServer.mockRejectedValueOnce(failed);
		mocks.shutdownRuntimeServer.mockResolvedValueOnce({
			outcome: {
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["processes_unconfirmed"],
			},
			completion: Promise.resolve({
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["processes_unconfirmed"],
			}),
		});
		await expect(
			startRuntime({
				capabilities: createRuntimeCapabilities("unavailable"),
				quarterdeckVersion: "test-version",
			}),
		).rejects.toBeInstanceOf(RuntimeStartupCleanupError);
	});
});
