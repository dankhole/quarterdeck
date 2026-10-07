import { EventEmitter } from "node:events";
import * as http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationProgressCursor, ConversationProgressReadResult } from "../../../src/conversation";
import type { TaskResourceOperationCoordinator } from "../../../src/core";
import { getQuarterdeckRuntimePort, setQuarterdeckRuntimePort } from "../../../src/core";
import { CodexStructuredOwnerRegistry } from "../../../src/execution/codex-structured-owner";
import * as nativeInput from "../../../src/execution/native-terminal-input";
import { StructuredOwnerRegistry } from "../../../src/execution/structured-owner-registry";
import * as hookOutbox from "../../../src/hook-transition-outbox";
import { LanguageNavigationManager } from "../../../src/language-navigation/manager";
import * as ownedProcesses from "../../../src/server/owned-process-shutdown";
import { RuntimeClientAccess } from "../../../src/server/runtime-client-access";
import { type CreateRuntimeServerDependencies, createRuntimeServer } from "../../../src/server/runtime-server";
import * as taskProgress from "../../../src/server/task-progress-preview";
import * as state from "../../../src/state";
import * as relocationJournal from "../../../src/state/project-relocation-journal";
import * as terminal from "../../../src/terminal";
import * as trpc from "../../../src/trpc";
import { createTestTaskNativeWorkEvidence, createTestTaskSessionSummary } from "../../utilities/task-session-factory";

vi.mock("node:http", async (importOriginal) => ({
	...(await importOriginal<typeof http>()),
	createServer: vi.fn(),
}));

function createDependencies() {
	const persistenceClose = vi.fn(async () => {});
	const hubClose = vi.fn(async () => {});
	const diagnosticsClose = vi.fn(async () => {});
	const markFailed = vi.fn(async () => {});
	const deps: CreateRuntimeServerDependencies = {
		projectRegistry: {
			stopMaintenance: vi.fn(),
			setProjectOperationRunner: vi.fn(),
			setProjectRemovalPreparationHandler: vi.fn(),
			getActiveProjectId: () => null,
			listManagedProjects: () => [],
		} as unknown as CreateRuntimeServerDependencies["projectRegistry"],
		runtimeStateHub: { close: hubClose } as unknown as CreateRuntimeServerDependencies["runtimeStateHub"],
		runtimeSessionPersistence: {
			disposeProject: vi.fn(async () => {}),
			persistRuntimeSessions: vi.fn(async () => {}),
			close: persistenceClose,
		},
		boardCommands: {
			setProjectOperationRunner: vi.fn(),
			subscribeToPostCommitEffects: () => () => {},
		} as unknown as CreateRuntimeServerDependencies["boardCommands"],
		diagnostics: {
			quarterdeckVersion: "test",
			registerSnapshotProvider: () => () => {},
			markReady: async () => {},
			markFailed,
			close: diagnosticsClose,
		} as unknown as CreateRuntimeServerDependencies["diagnostics"],
		warn: vi.fn(),
		resolveInteractiveShellCommand: () => ({ binary: "shell", args: [] }),
		hostIntegrations: {} as CreateRuntimeServerDependencies["hostIntegrations"],
		resolveProjectInputPath: (input) => input,
		assertPathIsDirectory: async () => {},
		hasGitRepository: async () => true,
		disposeProject: async () => ({ terminalManager: null, projectPath: null }),
		collectProjectWorktreeTaskIdsForRemoval: () => new Set(),
	};
	return { deps, persistenceClose, hubClose, diagnosticsClose, markFailed };
}

function stubRuntimeBoundaries() {
	vi.spyOn(ownedProcesses, "stopRuntimeOwnedProcessTrees").mockImplementation(async ({ stopSessions }) => {
		stopSessions();
		return { status: "stopped" };
	});
	const httpClose = vi.fn((callback: () => void) => callback());
	const listen = vi.fn((_port: number, _host: string, callback: () => void) => callback());
	const server = Object.assign(new EventEmitter(), {
		listen,
		address: () => ({ port: 9999, address: "127.0.0.1", family: "IPv4" }),
		close: httpClose,
	});
	vi.spyOn(http, "createServer").mockReturnValue(server as unknown as http.Server);
	vi.spyOn(state, "listProjectIndexEntries").mockResolvedValue([]);
	const createOutboxReplayer = hookOutbox.createHookTransitionOutboxReplayer;
	vi.spyOn(hookOutbox, "createHookTransitionOutboxReplayer").mockImplementation((deps) => {
		const replayer = createOutboxReplayer(deps);
		vi.spyOn(replayer, "start").mockImplementation(() => {});
		return replayer;
	});
	const terminalClose = vi.fn(async () => {});
	vi.spyOn(terminal, "createTerminalWebSocketBridge").mockReturnValue({
		close: terminalClose,
		getDiagnosticSnapshot: vi.fn(),
	});
	return { httpClose, terminalClose, listen };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createNativeManagerFixture() {
	const write = vi.fn(() => createTestTaskSessionSummary({ taskId: "task" }));
	const manager = {
		getTaskSessionProcessIdentity: () => ({
			pid: 123,
			sessionInstanceId: "native-a",
			launchOperationId: null,
			agentId: "codex",
			binary: null,
			profileEnvironment: {},
		}),
		writeInput: write,
	} as unknown as terminal.TerminalSessionManager;
	vi.spyOn(state.ProjectExecutionOwnershipStore.prototype, "createNativeInputAuthorization").mockReturnValue({
		read: async () => null,
		isCurrent: () => true,
		dispose: () => {},
	});
	const createWriter = vi.spyOn(nativeInput, "createNativeTerminalInputWriter");
	return { manager, write, createWriter };
}

describe("runtime server composition", () => {
	const configuredPort = getQuarterdeckRuntimePort();
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setQuarterdeckRuntimePort(configuredPort);
	});

	it("publishes the actual ephemeral listener port before readiness", async () => {
		const { listen } = stubRuntimeBoundaries();
		const { deps } = createDependencies();
		deps.listenPort = 0;
		deps.diagnostics.markReady = vi.fn(async () => {
			expect(getQuarterdeckRuntimePort()).toBe(9999);
		});
		const server = await createRuntimeServer(deps);
		try {
			expect(listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
			expect(server.url).toBe("http://127.0.0.1:9999");
		} finally {
			await server.close();
		}
	});

	it("closes every constructed local owner after failure immediately after binding", async () => {
		const { httpClose, terminalClose } = stubRuntimeBoundaries();
		const { deps, persistenceClose, hubClose, diagnosticsClose } = createDependencies();
		const failure = new Error("Diagnostic readiness failed");
		deps.diagnostics.markReady = vi.fn(async () => {
			throw failure;
		});
		deps.clientAccess = new RuntimeClientAccess({
			generation: "00000000-0000-4000-8000-000000000001",
			management: { getPublicDescriptor: () => null, verifyManagementToken: () => false },
		});
		const clear = vi.spyOn(deps.clientAccess, "clear");
		await expect(createRuntimeServer(deps)).rejects.toBe(failure);
		expect(httpClose).toHaveBeenCalledOnce();
		expect(terminalClose).toHaveBeenCalledOnce();
		expect(clear).toHaveBeenCalledOnce();
		// These outer composition owners are drained by bootstrap even if the server never returns.
		expect(persistenceClose).not.toHaveBeenCalled();
		expect(hubClose).not.toHaveBeenCalled();
		expect(diagnosticsClose).not.toHaveBeenCalled();
	});

	it("preserves unsafe ownership-release evidence when startup transport cleanup fails", async () => {
		const { httpClose, terminalClose } = stubRuntimeBoundaries();
		const { deps } = createDependencies();
		deps.diagnostics.markReady = vi.fn(async () => {
			throw new Error("Startup failed");
		});
		terminalClose.mockRejectedValueOnce(new Error("Transport cleanup failed"));
		await expect(createRuntimeServer(deps)).rejects.toMatchObject({
			name: "RuntimeStartupCleanupError",
			shutdownOutcome: { status: "incomplete", safeToReleaseOwnership: false },
		});
		expect(httpClose).toHaveBeenCalledOnce();
	});

	it("drains local transports after the startup process snapshot rejects", async () => {
		const { httpClose, terminalClose } = stubRuntimeBoundaries();
		const { deps } = createDependencies();
		deps.diagnostics.markReady = vi.fn(async () => {
			throw new Error("Startup failed");
		});
		vi.mocked(ownedProcesses.stopRuntimeOwnedProcessTrees).mockRejectedValueOnce(new Error("Snapshot failed"));
		await expect(createRuntimeServer(deps)).rejects.toMatchObject({
			name: "RuntimeStartupCleanupError",
			shutdownOutcome: { status: "incomplete", safeToReleaseOwnership: false },
		});
		expect(httpClose).toHaveBeenCalledOnce();
		expect(terminalClose).toHaveBeenCalledOnce();
	});

	it("reports native and structured live process owners independently of displayed task state", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const server = await createRuntimeServer(deps);
		vi.spyOn(CodexStructuredOwnerRegistry.prototype, "getOwnedProcessRootPids").mockReturnValue([303]);
		vi.spyOn(StructuredOwnerRegistry.prototype, "hasPendingLaunches").mockReturnValue(true);
		deps.projectRegistry.listManagedProjects = () => [
			{
				projectId: "project",
				projectPath: "/synthetic/project",
				terminalManager: {
					getOwnedProcessRootPids: () => [301, 302],
					hasPendingOwnedProcessLaunches: () => false,
				} as terminal.TerminalSessionManager,
			},
		];
		try {
			expect(server.getQuitSummary()).toEqual({ liveProcessCount: 3, pendingLaunches: true });
		} finally {
			await server.close();
		}
	});

	it("rejects orderly shutdown when a structured process could not be confirmed stopped", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const server = await createRuntimeServer(deps);
		vi.spyOn(StructuredOwnerRegistry.prototype, "stopAll").mockResolvedValue(1);
		await expect(server.close()).rejects.toThrow("One or more runtime shutdown steps failed");
	});

	it("fences producers without signaling structured or language servers before the process snapshot", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const server = await createRuntimeServer(deps);
		const structuredStop = vi.spyOn(StructuredOwnerRegistry.prototype, "stopAll");
		const languageStop = vi.spyOn(LanguageNavigationManager.prototype, "close");
		try {
			await server.prepareForShutdown();
			expect(structuredStop).not.toHaveBeenCalled();
			expect(languageStop).not.toHaveBeenCalled();
			// Bootstrap's exact-ownership helper invokes this only after its snapshot.
			await server.stopTaskOwnersForShutdown();
			expect(structuredStop).toHaveBeenCalledOnce();
			expect(languageStop).toHaveBeenCalledOnce();
		} finally {
			await server.close();
		}
	});

	it("drains an active progress read during shutdown without publishing or rearming its late result", async () => {
		vi.useFakeTimers();
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const store = new terminal.InMemorySessionSummaryStore();
		const previous = store.ensureEntry("task");
		store.update(
			"task",
			createTestTaskSessionSummary({
				taskId: "task",
				agentId: "codex",
				state: "running",
				pid: 123,
				sessionInstanceId: "native-a",
				resumeSessionId: "session-a",
				nativeWorkEvidence: createTestTaskNativeWorkEvidence({
					sessionInstanceId: "native-a",
					providerSessionId: "session-a",
				}),
			}),
		);
		deps.projectRegistry.listManagedProjects = () => [
			{
				projectId: "project",
				projectPath: "/synthetic/project",
				terminalManager: { store } as unknown as terminal.TerminalSessionManager,
			},
		];
		let resolveRead!: (result: ConversationProgressReadResult) => void;
		const result = new Promise<ConversationProgressReadResult>((resolve) => {
			resolveRead = resolve;
		});
		const read = vi.fn(() => result);
		const cursor: ConversationProgressCursor = { read, beginEpoch: vi.fn(), pause: vi.fn() };
		const createPreview = taskProgress.createTaskProgressPreview;
		vi.spyOn(taskProgress, "createTaskProgressPreview").mockImplementation((input) =>
			createPreview({ ...input, createCursor: () => cursor }),
		);
		const createHooksApi = vi.spyOn(trpc, "createHooksApi");
		const server = await createRuntimeServer(deps);
		try {
			const hooks = createHooksApi.mock.calls[0][0];
			if (!hooks.conversationSourceHints || !hooks.observeProgress)
				throw new Error("Runtime must wire progress hints and observation into hook ingest.");
			hooks.conversationSourceHints.recordProviderHookHint({
				projectId: "project",
				taskId: "task",
				expectedProviderSessionId: "session-a",
				metadata: { source: "codex", sessionId: "session-a", transcriptPath: "/synthetic/session-a.jsonl" },
			});
			hooks.observeProgress({ projectId: "project", taskId: "task", store, previous });
			expect(read).toHaveBeenCalledOnce();
			let prepared = false;
			const preparation = server.prepareForShutdown().then(() => {
				prepared = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(prepared).toBe(false);
			expect(cursor.pause).toHaveBeenCalledOnce();
			resolveRead({ text: "late", hasMore: true, sourceBytesExamined: 100 });
			await preparation;
			expect(prepared).toBe(true);
			expect(store.getSummary("task")?.progressMessage).toBeFalsy();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(taskProgress.PROGRESS_PREVIEW_INTERVAL_MS * 2);
			expect(read).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			resolveRead({ text: null, hasMore: false, sourceBytesExamined: 0 });
			await server.close();
		}
	});

	it("passes the independent persistence owner to hook ingest", async () => {
		stubRuntimeBoundaries();
		const { deps, persistenceClose, hubClose } = createDependencies();
		const createHooksApi = vi.spyOn(trpc, "createHooksApi");
		const server = await createRuntimeServer(deps);
		try {
			expect(createHooksApi).toHaveBeenCalledWith(
				expect.objectContaining({ persistSessionState: deps.runtimeSessionPersistence.persistRuntimeSessions }),
			);
		} finally {
			await server.close();
		}
		expect(persistenceClose).toHaveBeenCalledOnce();
		expect(hubClose).toHaveBeenCalledOnce();
	});

	it("drains persistence before closing transport and completes cleanup after a durability failure", async () => {
		const { httpClose, terminalClose } = stubRuntimeBoundaries();
		const { deps, persistenceClose, hubClose, diagnosticsClose, markFailed } = createDependencies();
		const persistenceError = new Error("session persistence failed");
		persistenceClose.mockImplementation(async () => {
			expect(hubClose).not.toHaveBeenCalled();
			throw persistenceError;
		});
		const server = await createRuntimeServer(deps);
		await expect(server.close()).rejects.toMatchObject({ errors: [persistenceError] });
		expect(hubClose).toHaveBeenCalledOnce();
		expect(terminalClose).toHaveBeenCalledOnce();
		expect(httpClose).toHaveBeenCalledOnce();
		expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ errors: [persistenceError] }));
		expect(diagnosticsClose).toHaveBeenCalledOnce();
	});

	it("admits terminal bursts without Git probes and fences queued input after a folder change", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const scope = { projectId: "terminal-project", projectPath: "/synthetic/project" };
		const { manager, write, createWriter } = createNativeManagerFixture();
		deps.projectRegistry.getProjectPathById = () => scope.projectPath;
		deps.projectRegistry.getTerminalManagerForProject = () => manager;
		const checkAvailability = vi.fn(async () => ({ status: "available" as const }));
		deps.projectRegistry.checkProjectAvailability = checkAvailability;
		const indexedScope = vi.spyOn(state, "loadProjectScopeById").mockResolvedValue({
			projectId: scope.projectId,
			repoPath: scope.projectPath,
			statePath: "/synthetic/state",
		});
		vi.spyOn(relocationJournal, "readProjectRelocationJournal").mockResolvedValue(null);
		const server = await createRuntimeServer(deps);
		try {
			const bridge = vi.mocked(terminal.createTerminalWebSocketBridge).mock.calls[0][0];
			const writer = bridge.createTaskInputWriter?.({
				projectId: scope.projectId,
				taskId: "task",
				terminalManager: manager,
			});
			if (!writer) throw new Error("Runtime must install a guarded terminal writer.");
			await Promise.all(Array.from({ length: 100 }, (_, index) => writer.write(Buffer.from(String(index)))));
			expect(write).toHaveBeenCalledTimes(100);
			expect(checkAvailability).not.toHaveBeenCalled();
			const operations = createWriter.mock.calls[0][0].taskResourceOperations as TaskResourceOperationCoordinator;
			let release!: () => void;
			const barrier = new Promise<void>((resolve) => {
				release = resolve;
			});
			const relocating = operations.runProjectExclusive(scope.projectId, async () => await barrier);
			const queuedWrite = writer.write(Buffer.from("old location"));
			indexedScope.mockResolvedValue({
				projectId: scope.projectId,
				repoPath: "/synthetic/renamed",
				statePath: "/synthetic/state",
			});
			release();
			await relocating;
			await expect(queuedWrite).rejects.toThrow("project folder changed");
			expect(write).toHaveBeenCalledTimes(100);
			writer.dispose();
		} finally {
			await server.close();
		}
	});

	it("preserves received byte order when project validations would finish in reverse", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const scope = { projectId: "terminal-project", projectPath: "/synthetic/project" };
		const { manager, write } = createNativeManagerFixture();
		deps.projectRegistry.getProjectPathById = () => scope.projectPath;
		deps.projectRegistry.getTerminalManagerForProject = () => manager;
		const entered = deferred();
		const first = deferred();
		const second = deferred();
		const third = deferred();
		const indexedScope = { projectId: scope.projectId, repoPath: scope.projectPath, statePath: "/synthetic/state" };
		const validation = vi
			.spyOn(state, "loadProjectScopeById")
			.mockImplementationOnce(async () => {
				entered.resolve();
				await first.promise;
				return indexedScope;
			})
			.mockImplementationOnce(async () => {
				await second.promise;
				return indexedScope;
			})
			.mockImplementationOnce(async () => {
				await third.promise;
				return indexedScope;
			});
		vi.spyOn(relocationJournal, "readProjectRelocationJournal").mockResolvedValue(null);
		const server = await createRuntimeServer(deps);
		try {
			const bridge = vi.mocked(terminal.createTerminalWebSocketBridge).mock.calls[0][0];
			const writer = bridge.createTaskInputWriter?.({
				projectId: scope.projectId,
				taskId: "task",
				terminalManager: manager,
			});
			if (!writer) throw new Error("Runtime must install a guarded terminal writer.");
			const writes = ["A", "B", "C"].map((data) => writer.write(Buffer.from(data)));
			await entered.promise;
			third.resolve();
			second.resolve();
			expect(validation).toHaveBeenCalledOnce();
			expect(write).not.toHaveBeenCalled();
			first.resolve();
			await Promise.all(writes);
			expect(write.mock.calls).toEqual([
				["task", Buffer.from("A")],
				["task", Buffer.from("B")],
				["task", Buffer.from("C")],
			]);
			writer.dispose();
		} finally {
			first.resolve();
			second.resolve();
			third.resolve();
			await server.close();
		}
	});

	it("drains input admitted before shutdown and rejects input received after its fence", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const scope = { projectId: "terminal-project", projectPath: "/synthetic/project" };
		const { manager, write, createWriter } = createNativeManagerFixture();
		deps.projectRegistry.getProjectPathById = () => scope.projectPath;
		deps.projectRegistry.getTerminalManagerForProject = () => manager;
		const entered = deferred();
		const release = deferred();
		vi.spyOn(state, "loadProjectScopeById").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { projectId: scope.projectId, repoPath: scope.projectPath, statePath: "/synthetic/state" };
		});
		vi.spyOn(relocationJournal, "readProjectRelocationJournal").mockResolvedValue(null);
		const server = await createRuntimeServer(deps);
		try {
			const bridge = vi.mocked(terminal.createTerminalWebSocketBridge).mock.calls[0][0];
			const writer = bridge.createTaskInputWriter?.({
				projectId: scope.projectId,
				taskId: "task",
				terminalManager: manager,
			});
			if (!writer) throw new Error("Runtime must install a guarded terminal writer.");
			const admitted = writer.write(Buffer.from("admitted"));
			await entered.promise;
			const operations = createWriter.mock.calls[0][0].taskResourceOperations as TaskResourceOperationCoordinator;
			const drainEntered = deferred();
			const waitForIdle = operations.waitForIdle.bind(operations);
			vi.spyOn(operations, "waitForIdle").mockImplementation(async () => {
				drainEntered.resolve();
				await waitForIdle();
			});
			let prepared = false;
			const preparation = server.prepareForShutdown().then(() => {
				prepared = true;
			});
			await drainEntered.promise;
			expect(prepared).toBe(false);
			await expect(writer.write(Buffer.from("late"))).rejects.toThrow("Runtime is shutting down");
			expect(write).not.toHaveBeenCalled();
			release.resolve();
			await Promise.all([admitted, preparation]);
			expect(prepared).toBe(true);
			expect(write).toHaveBeenCalledExactlyOnceWith("task", Buffer.from("admitted"));
			writer.dispose();
		} finally {
			release.resolve();
			await server.close();
		}
	});

	it("rejects terminal input when relocation recovery is pending or its journal is unreadable", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const scope = { projectId: "terminal-project", projectPath: "/synthetic/project" };
		const { manager, write } = createNativeManagerFixture();
		deps.projectRegistry.getProjectPathById = () => scope.projectPath;
		deps.projectRegistry.getTerminalManagerForProject = () => manager;
		vi.spyOn(state, "loadProjectScopeById").mockResolvedValue({
			projectId: scope.projectId,
			repoPath: scope.projectPath,
			statePath: "/synthetic/state",
		});
		const pending = vi.spyOn(relocationJournal, "readProjectRelocationJournal").mockResolvedValue({
			projectId: scope.projectId,
			operationId: "move",
			oldPath: scope.projectPath,
			newPath: "/synthetic/renamed",
			kind: "rename",
			folderOnly: true,
			directoryIdentity: { device: "1", inode: "2" },
			worktrees: [],
			taskWorkingDirectories: {},
			version: 1,
			phase: "prepared",
		});
		const server = await createRuntimeServer(deps);
		try {
			const bridge = vi.mocked(terminal.createTerminalWebSocketBridge).mock.calls[0][0];
			const writer = bridge.createTaskInputWriter?.({
				projectId: scope.projectId,
				taskId: "task",
				terminalManager: manager,
			});
			if (!writer) throw new Error("Runtime must install a guarded terminal writer.");
			await expect(writer.write(Buffer.from("pending"))).rejects.toThrow("awaiting recovery");
			pending.mockRejectedValueOnce(new Error("unreadable relocation journal"));
			await expect(writer.write(Buffer.from("uncertain"))).rejects.toThrow("unreadable relocation journal");
			expect(write).not.toHaveBeenCalled();
			writer.dispose();
		} finally {
			await server.close();
		}
	});
});
