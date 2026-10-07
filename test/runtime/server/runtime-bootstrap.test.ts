import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeCapabilities } from "../../../src/core";
import { RuntimeStartupCleanupError, startRuntime } from "../../../src/server/runtime-bootstrap";
import type {
	RuntimeShutdownCoordinatorDependencies,
	RuntimeShutdownResult,
} from "../../../src/server/shutdown-coordinator";

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const diagnostics = {
		runtimeInstanceId: "test-runtime-instance",
		registerSnapshotProvider: vi.fn(),
		recordEvent: vi.fn(),
		fail: vi.fn(async () => undefined),
	};
	const server = {
		url: "http://127.0.0.1:3500",
		getQuitSummary: vi.fn(() => ({ liveProcessCount: 2, pendingLaunches: true })),
		prepareForShutdown: vi.fn(async () => undefined),
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
		persistenceClose: vi.fn(async () => undefined),
		hubClose: vi.fn(async () => undefined),
		waitForPendingBackups: vi.fn(async () => undefined),
		shutdownRuntimeServer: vi.fn(
			async (deps: RuntimeShutdownCoordinatorDependencies): Promise<RuntimeShutdownResult> => {
				await deps.prepareForShutdown?.();
				await deps.stopOwnedProcesses?.(() => undefined);
				await deps.closeRuntimeServer();
				const outcome = {
					status: "clean" as const,
					safeToExit: true as const,
					safeToReleaseOwnership: true as const,
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
	},
}));
vi.mock("../../../src/server/runtime-state-hub", () => ({
	createRuntimeStateHub: vi.fn(() => ({ close: mocks.hubClose })),
}));
vi.mock("../../../src/server/shutdown-coordinator", () => ({
	shutdownRuntimeServer: mocks.shutdownRuntimeServer,
}));
vi.mock("../../../src/server/owned-process-shutdown", () => ({
	stopRuntimeOwnedProcessTrees: vi.fn(async ({ stopSessions }: { stopSessions: () => void }) => {
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
