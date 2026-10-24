import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeShutdownOutcome } from "../../../src/core/api/runtime-shutdown";
import type { RuntimeBootstrapOptions } from "../../../src/server/runtime-bootstrap";
import { startAdmittedRuntime } from "../../../src/server/runtime-launch";
import type { AcquireRuntimeOwnershipOptions } from "../../../src/server/runtime-ownership";
import * as writeAdmission from "../../../src/state/runtime-write-admission";

const installWrites = writeAdmission.installRuntimeWriteAdmission;
const waitForWrites = writeAdmission.waitForRuntimeWriteQuiescence;
let disposeWrites: (() => void) | undefined;

const mocks = vi.hoisted(() => {
	const clean: RuntimeShutdownOutcome = { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
	const state: {
		current: boolean;
		onLost: (() => void) | undefined;
		bootstrap: RuntimeBootstrapOptions | null;
		beforeSpawn: (() => void) | null;
	} = { current: true, onLost: undefined, bootstrap: null, beforeSpawn: null };
	const lease = {
		canonicalStateHome: "/synthetic/quarterdeck",
		generation: "355c5709-6b94-48fa-936a-b8e9df87d1bc",
		bootIdentity: "synthetic-boot",
		isCurrent: vi.fn(() => state.current),
		assertCurrent: vi.fn(() => {
			if (!state.current) throw new Error("lost");
		}),
		markProcessCustodyDirty: vi.fn(),
		markReady: vi.fn(async () => undefined),
		markStopping: vi.fn(async () => undefined),
		release: vi.fn(async () => undefined),
	};
	const shutdown = vi.fn(
		async (): Promise<{
			outcome: RuntimeShutdownOutcome;
			completion: Promise<RuntimeShutdownOutcome>;
		}> => ({ outcome: clean, completion: Promise.resolve(clean) }),
	);
	return {
		clean,
		state,
		lease,
		shutdown,
		clearAccess: vi.fn(),
		recordEvent: vi.fn(),
		abortDeferredDeletes: vi.fn(),
		waitForWrites: vi.fn(async (_stateHome: string): Promise<void> => undefined),
	};
});

vi.mock("../../../src/core/index.js", () => ({
	createRuntimeCapabilities: () => ({ nativeUiAvailable: false }),
	getQuarterdeckRuntimeHost: () => "127.0.0.1",
	getQuarterdeckRuntimePort: () => 3500,
}));
vi.mock("../../../src/core/runtime-process-launch-admission.js", () => ({
	installRuntimeProcessLaunchAdmission: ({ beforeSpawn }: { beforeSpawn: () => void }) => {
		mocks.state.beforeSpawn = beforeSpawn;
	},
}));
vi.mock("../../../src/state/project-state.js", () => ({
	getRuntimeHomePath: () => "/synthetic/quarterdeck",
	isUnderWorktreesHome: () => false,
}));
vi.mock("../../../src/workdir/task-worktree-deferred-delete.js", () => ({
	deferredTaskWorkspaceDeletes: { abort: mocks.abortDeferredDeletes },
}));
vi.mock("../../../src/server/runtime-ownership.js", () => ({
	acquireRuntimeOwnership: async (options: AcquireRuntimeOwnershipOptions) => {
		mocks.state.onLost = options.onOwnershipLost;
		return { kind: "acquired", lease: mocks.lease };
	},
}));
vi.mock("../../../src/server/runtime-client-access.js", () => ({
	RuntimeClientAccess: class {
		clear = mocks.clearAccess;
	},
}));
vi.mock("../../../src/server/runtime-bootstrap.js", () => ({
	startRuntime: async (options: RuntimeBootstrapOptions) => {
		mocks.state.bootstrap = options;
		return {
			url: "http://127.0.0.1:3500/",
			shutdown: mocks.shutdown,
			diagnostics: { recordEvent: mocks.recordEvent, runtimeInstanceId: "8d2e6fad-de2a-4ffb-8123-c3ad8a5716d4" },
		};
	},
}));
vi.mock("../../../src/server/runtime-recovery-admission.js", () => ({
	assertRuntimeRecoveryAdmission: vi.fn(),
}));
vi.mock("../../../src/server/runtime-startup-paths.js", () => ({ hasGitRepository: vi.fn() }));
vi.mock("../../../src/server/runtime-owner-client.js", () => ({}));
vi.mock("../../../src/server/desktop-runtime-host-effects.js", () => ({}));

async function launch() {
	return await startAdmittedRuntime({
		quarterdeckVersion: "0.0.0-test",
		nativeUiAvailable: false,
		hostSimulationConfigPath: null,
		skipShutdownCleanup: false,
		desktopStartup: null,
	});
}

describe("admitted runtime shutdown composition", () => {
	const exitCode = process.exitCode;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(writeAdmission, "installRuntimeWriteAdmission").mockImplementation((options) => {
			disposeWrites = installWrites(options);
			return disposeWrites;
		});
		mocks.waitForWrites.mockImplementation(waitForWrites);
		vi.spyOn(writeAdmission, "waitForRuntimeWriteQuiescence").mockImplementation(mocks.waitForWrites);
		mocks.state.current = true;
		mocks.state.onLost = undefined;
		mocks.state.bootstrap = null;
		mocks.state.beforeSpawn = null;
		mocks.lease.markStopping.mockResolvedValue(undefined);
		vi.stubEnv("QUARTERDECK_STATE_HOME", "/synthetic/quarterdeck");
	});
	afterEach(async () => {
		await waitForWrites("/synthetic/quarterdeck");
		disposeWrites?.();
		disposeWrites = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = exitCode;
	});
	it("shares deadline cleanup until settlement, then retries an incomplete result", async () => {
		const incomplete: RuntimeShutdownOutcome = {
			status: "incomplete",
			safeToExit: false,
			safeToReleaseOwnership: false,
			reasons: ["processes_unconfirmed"],
		};
		let complete!: (outcome: RuntimeShutdownOutcome) => void;
		const completion = new Promise<RuntimeShutdownOutcome>((resolve) => {
			complete = resolve;
		});
		mocks.shutdown.mockResolvedValueOnce({
			outcome: { ...incomplete, reasons: ["deadline"] },
			completion,
		});
		const runtime = await launch();
		expect(await runtime.shutdown()).toMatchObject({ reasons: ["deadline"] });
		expect(await runtime.shutdown()).toMatchObject({ reasons: ["deadline"] });
		expect(mocks.shutdown).toHaveBeenCalledOnce();
		expect(mocks.lease.release).not.toHaveBeenCalled();
		let settled = false;
		const waiting = runtime.shutdown(true).then((outcome) => {
			settled = true;
			return outcome;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		complete(incomplete);
		expect(await waiting).toEqual(incomplete);
		expect(await runtime.shutdown(true)).toEqual(mocks.clean);
		expect(await runtime.shutdown(true)).toEqual(mocks.clean);
		expect(mocks.shutdown).toHaveBeenCalledTimes(2);
		expect(mocks.lease.release).toHaveBeenCalledOnce();
	});

	it("fences and drains admitted writes on incomplete completion without releasing ownership", async () => {
		const incomplete: RuntimeShutdownOutcome = {
			status: "incomplete",
			safeToExit: false,
			safeToReleaseOwnership: false,
			reasons: ["quiescence_failed", "processes_unconfirmed"],
		};
		mocks.shutdown.mockResolvedValueOnce({ outcome: incomplete, completion: Promise.resolve(incomplete) });
		const runtime = await launch();
		let releaseWriter!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const writing = writeAdmission.withRuntimeWriteOperation(
			["/synthetic/quarterdeck/sessions.json"],
			async () => await gate,
		);
		let settled = false;
		const stopping = runtime.shutdown(true).then((outcome) => {
			settled = true;
			return outcome;
		});
		try {
			await vi.waitFor(() => expect(mocks.waitForWrites).toHaveBeenCalledOnce());
			expect(settled).toBe(false);
			expect(mocks.lease.release).not.toHaveBeenCalled();
			await expect(
				writeAdmission.withRuntimeWriteOperation(["/synthetic/quarterdeck/board.json"], async () => {}),
			).rejects.toBeInstanceOf(writeAdmission.RuntimeWriteAdmissionError);
			releaseWriter();
			await writing;
			expect(await stopping).toEqual(incomplete);
			expect(mocks.lease.release).not.toHaveBeenCalled();
		} finally {
			releaseWriter();
			await writing;
		}
	});

	it("retries a rejected shutdown rather than caching the rejection", async () => {
		mocks.shutdown.mockRejectedValueOnce(new Error("synthetic failure"));
		const runtime = await launch();
		await expect(runtime.shutdown(true)).rejects.toThrow("synthetic failure");
		await expect(runtime.shutdown(true)).resolves.toEqual(mocks.clean);
		expect(mocks.shutdown).toHaveBeenCalledTimes(2);
	});

	it("rejects a new write queued after observing quiescence and before releasing custody", async () => {
		const write = vi.fn(async () => undefined);
		mocks.waitForWrites.mockImplementation(async (stateHome) => {
			await waitForWrites(stateHome);
			// Exercise the actual write guard in the async gap after its zero-count read.
			await expect(
				writeAdmission.withRuntimeWriteOperation([`${stateHome}/board.json`], write),
			).rejects.toBeInstanceOf(writeAdmission.RuntimeWriteAdmissionError);
		});
		const runtime = await launch();
		await expect(runtime.shutdown(true)).resolves.toEqual(mocks.clean);
		expect(write).not.toHaveBeenCalled();
		expect(mocks.abortDeferredDeletes.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.waitForWrites.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.lease.release).toHaveBeenCalledOnce();
		await expect(
			writeAdmission.withRuntimeWriteOperation(["/synthetic/quarterdeck/board.json"], write),
		).rejects.toBeInstanceOf(writeAdmission.RuntimeWriteAdmissionError);
	});
	it("publishes the exact diagnostic identity separately from runtime custody", async () => {
		const runtime = await launch();
		expect(runtime.ready.diagnosticInstanceId).toBe("8d2e6fad-de2a-4ffb-8123-c3ad8a5716d4");
		expect(runtime.ready.runtimeGeneration).toBe(mocks.lease.generation);
		expect(runtime.ready.diagnosticInstanceId).not.toBe(runtime.ready.runtimeGeneration);
		await runtime.shutdown(true);
	});

	it("still revokes access and completes cleanup when stopping descriptor publication fails", async () => {
		mocks.lease.markStopping.mockRejectedValue(new Error("synthetic disk failure"));
		const runtime = await launch();
		await expect(runtime.shutdown(true)).resolves.toEqual(mocks.clean);
		await expect(runtime.shutdown(true)).resolves.toEqual(mocks.clean);
		expect(mocks.clearAccess).toHaveBeenCalledOnce();
		expect(mocks.clearAccess.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.lease.markStopping.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.shutdown).toHaveBeenCalledOnce();
		expect(mocks.lease.release).toHaveBeenCalledOnce();
		expect(mocks.recordEvent).toHaveBeenCalledWith(
			"runtime.ownership_stopping_publication_failed",
			{},
			{},
			{ level: "warn", essential: true },
		);
	});

	it("shares one cleanup when descriptor publication synchronously discovers lease loss", async () => {
		mocks.lease.markStopping.mockImplementation(async () => {
			mocks.state.current = false;
			mocks.state.onLost?.();
			throw new Error("synthetic lost lease");
		});
		const runtime = await launch();
		await expect(runtime.shutdown(true)).resolves.toMatchObject({
			status: "incomplete",
			safeToReleaseOwnership: false,
			reasons: ["ownership_lost"],
		});
		expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith({
			skipSessionCleanup: false,
			persistenceAllowed: false,
		});
		expect(mocks.clearAccess).toHaveBeenCalledOnce();
		expect(mocks.lease.release).not.toHaveBeenCalled();
		await Promise.resolve();
	});

	it("permanently blocks late child launches at the snapshot boundary while retaining the write lease", async () => {
		await launch();
		expect(() => mocks.state.beforeSpawn?.()).not.toThrow();
		expect(mocks.lease.markProcessCustodyDirty).toHaveBeenCalledOnce();
		mocks.state.bootstrap?.beforeProcessSnapshot?.();
		expect(() => mocks.state.beforeSpawn?.()).toThrow("Runtime process launches have stopped.");
		expect(mocks.lease.markProcessCustodyDirty).toHaveBeenCalledOnce();
		expect(mocks.state.bootstrap?.persistenceAllowed?.()).toBe(true);
	});
});
