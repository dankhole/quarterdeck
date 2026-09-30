import { EventEmitter } from "node:events";
import * as http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskResourceOperationCoordinator } from "../../../src/core";
import * as nativeInput from "../../../src/execution/native-terminal-input";
import * as hookOutbox from "../../../src/hook-transition-outbox";
import { type CreateRuntimeServerDependencies, createRuntimeServer } from "../../../src/server/runtime-server";
import * as state from "../../../src/state";
import * as relocationJournal from "../../../src/state/project-relocation-journal";
import * as terminal from "../../../src/terminal";
import * as trpc from "../../../src/trpc";

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
	const httpClose = vi.fn((callback: () => void) => callback());
	const server = Object.assign(new EventEmitter(), {
		listen: (_port: number, _host: string, callback: () => void) => callback(),
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
	return { httpClose, terminalClose };
}

describe("runtime server composition", () => {
	afterEach(() => vi.restoreAllMocks());

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
		const manager = {} as terminal.TerminalSessionManager;
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
		const write = vi.fn(async () => null);
		const createWriter = vi.spyOn(nativeInput, "createNativeTerminalInputWriter").mockReturnValue({
			write,
			dispose: () => {},
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

	it("rejects terminal input when relocation recovery is pending or its journal is unreadable", async () => {
		stubRuntimeBoundaries();
		const { deps } = createDependencies();
		const scope = { projectId: "terminal-project", projectPath: "/synthetic/project" };
		const manager = {} as terminal.TerminalSessionManager;
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
		const write = vi.fn(async () => null);
		vi.spyOn(nativeInput, "createNativeTerminalInputWriter").mockReturnValue({ write, dispose: () => {} });
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
