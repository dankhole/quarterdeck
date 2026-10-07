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
	const shutdown = vi.fn(async () => ({ outcome: clean, completion: Promise.resolve(clean) }));
	return {
		clean,
		state,
		lease,
		shutdown,
		clearAccess: vi.fn(),
		recordEvent: vi.fn(),
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
		await runtime.shutdown(true);
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
