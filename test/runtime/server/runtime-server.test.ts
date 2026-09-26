import { EventEmitter } from "node:events";
import * as http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as hookOutbox from "../../../src/hook-transition-outbox";
import { type CreateRuntimeServerDependencies, createRuntimeServer } from "../../../src/server/runtime-server";
import * as state from "../../../src/state";
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
			setProjectRemovalPreparationHandler: vi.fn(),
			getActiveProjectId: () => null,
			listManagedProjects: () => [],
		} as unknown as CreateRuntimeServerDependencies["projectRegistry"],
		runtimeStateHub: { close: hubClose } as unknown as CreateRuntimeServerDependencies["runtimeStateHub"],
		runtimeSessionPersistence: {
			persistRuntimeSessions: vi.fn(async () => {}),
			close: persistenceClose,
		},
		boardCommands: {
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

describe("runtime server persistence composition", () => {
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
});
