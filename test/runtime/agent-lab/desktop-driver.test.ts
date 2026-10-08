import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopLabDriver, withDesktopDeadline } from "../../../scripts/agent-lab/desktop-driver";
import type { DesktopEvaluationModule } from "../../../scripts/agent-lab/desktop-evaluation-types";
import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import { DesktopMainLossError, type DesktopMainLossProof } from "../../../scripts/agent-lab/desktop-main-loss";
import type * as desktopProcesses from "../../../scripts/agent-lab/desktop-processes";
import { listDesktopProcesses, stopOwnedDesktopProcesses } from "../../../scripts/agent-lab/desktop-processes";
import { captureDesktopShutdownEvidence } from "../../../scripts/agent-lab/desktop-shutdown-evidence";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

const cleanupPollWait = vi.fn(async (_milliseconds: number) => {});

vi.mock("playwright-core", () => ({ _electron: { launch: vi.fn() } }));
vi.mock("../../../scripts/agent-lab/desktop-shutdown-evidence", () => ({
	captureDesktopShutdownEvidence: vi.fn(async () => undefined),
}));
vi.mock("../../../scripts/agent-lab/desktop-processes", async (importOriginal) => {
	const original = await importOriginal<typeof desktopProcesses>();
	return { ...original, listDesktopProcesses: vi.fn(), stopOwnedDesktopProcesses: vi.fn() };
});

async function createFixture(): Promise<DesktopLabFixture> {
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-desktop-driver-test-")));
	const artifactDir = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-evidence-test-"));
	const config = {
		version: 1 as const,
		tempRoot,
		stateHome: join(tempRoot, "state"),
		userDataPath: join(tempRoot, "user-data"),
		projectPath: join(tempRoot, "project"),
		hostSimulationConfigPath: join(tempRoot, "host.json"),
		processEvidencePath: join(tempRoot, "processes.json"),
	};
	await mkdir(config.userDataPath);
	await writeFile(
		join(config.userDataPath, "DevToolsActivePort"),
		"9222\n/devtools/browser/11111111-1111-4111-8111-111111111111\n",
	);
	await writeFile(
		config.processEvidencePath,
		JSON.stringify({ version: 1, helperPid: null, generation: null, runtimeOrigin: null, phase: "starting" }),
	);
	const forbiddenHostLaunchLogPath = join(artifactDir, "forbidden-host-launches.log");
	await writeFile(forbiddenHostLaunchLogPath, "");
	return {
		config,
		configPath: join(tempRoot, "config.json"),
		manifestPath: join(artifactDir, "desktop-manifest.json"),
		environment: {},
		forbiddenHostLaunchLogPath,
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "driver-test",
			status: "starting",
			appPath: "/tmp/Quarterdeck.app",
			executablePath: "/tmp/Quarterdeck.app/Contents/MacOS/Quarterdeck",
			artifactDir,
			tempRoot,
			userDataPath: config.userDataPath,
			stateHome: config.stateHome,
			projectPath: config.projectPath,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: null,
			helperPid: null,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: new Date().toISOString(),
			stoppedAt: null,
			failure: null,
		},
	};
}

function mockApplication(mainPid: number, close: () => Promise<void>): ElectronApplication {
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: mainPid });
	const page = { on: vi.fn(), off: vi.fn(), setDefaultTimeout: vi.fn() };
	return {
		once: vi.fn(),
		process: () => child,
		context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
		windows: () => [page],
		firstWindow: async () => page,
		close,
	} as unknown as ElectronApplication;
}

function markedMain(fixture: DesktopLabFixture): DesktopLabProcess {
	return {
		pid: 50_000,
		parentPid: 1,
		startedAt: "Thu Oct  1 14:45:00 2026",
		command: `${fixture.manifest.executablePath} --user-data-dir=${fixture.config.userDataPath}`,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function mainLossProof(
	fixture: DesktopLabFixture,
	main: DesktopLabProcess,
	extras: DesktopLabProcess[] = [],
): DesktopMainLossProof {
	const helper = { ...main, pid: main.pid + 1, parentPid: main.pid, command: "synthetic helper" };
	const owner = {
		generation: "captured-generation",
		canonicalStateHome: fixture.config.stateHome,
		pid: helper.pid,
		creationIdentity: "captured-helper-birth",
		processState: "live",
		released: false,
	};
	return {
		signal: "SIGKILL",
		main,
		helper,
		fixtureIdentity: {
			runId: fixture.manifest.runId,
			appPath: fixture.manifest.appPath,
			executablePath: fixture.manifest.executablePath,
			configPath: fixture.configPath,
			tempRoot: fixture.config.tempRoot,
			stateHome: fixture.config.stateHome,
			userDataPath: fixture.config.userDataPath,
			projectPath: fixture.config.projectPath,
			hostSimulationConfigPath: fixture.config.hostSimulationConfigPath,
			processEvidencePath: fixture.config.processEvidencePath,
			home: fixture.environment.HOME ?? null,
			codexHome: fixture.environment.CODEX_HOME ?? null,
			fakeAgentScript: fixture.environment.QUARTERDECK_AGENT_LAB_FAKE_AGENT ?? null,
		},
		ownershipBefore: owner,
		ownershipAfter: { ...owner, processState: "dead", released: true },
		ownedProcesses: [main, helper, ...extras],
		remainingProcesses: [],
		fallbackUsed: false,
	} as unknown as DesktopMainLossProof;
}

async function prepareRetirement() {
	const fixture = await createFixture();
	const main = markedMain(fixture);
	const quit = vi.fn(async () => {
		vi.mocked(listDesktopProcesses).mockResolvedValue([]);
	});
	const application = mockApplication(main.pid, quit);
	const events = new EventEmitter();
	Reflect.set(application, "once", events.once.bind(events));
	vi.mocked(_electron.launch).mockResolvedValue(application);
	vi.mocked(listDesktopProcesses).mockResolvedValue([main]);
	const driver = new DesktopLabDriver(fixture, cleanupPollWait);
	await driver.launch();
	const proof = mainLossProof(fixture, main);
	vi.mocked(listDesktopProcesses).mockResolvedValue([]);
	events.emit("close");
	return { driver, fixture, main, proof, application, quit };
}

async function removeFixture(fixture: DesktopLabFixture): Promise<void> {
	await rm(fixture.config.tempRoot, { recursive: true, force: true });
	await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
}

describe("desktop driver cleanup orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(captureDesktopShutdownEvidence).mockReset();
		vi.mocked(listDesktopProcesses).mockResolvedValue([]);
		vi.mocked(stopOwnedDesktopProcesses).mockResolvedValue([]);
	});

	it("refuses a process-restricted host before spawning Electron", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		vi.mocked(listDesktopProcesses).mockRejectedValue(new Error("spawn /bin/ps EPERM"));
		try {
			await expect(driver.launch()).rejects.toThrow("no app was launched");
			expect(_electron.launch).not.toHaveBeenCalled();
			expect(fixture.manifest.mainPid).toBeNull();
		} finally {
			await removeFixture(fixture);
		}
	});

	it("does not spawn when stop arrives during the native preflight", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const census = deferred<DesktopLabProcess[]>();
		vi.mocked(listDesktopProcesses).mockReturnValueOnce(census.promise);
		try {
			const launch = expect(driver.launch()).rejects.toThrow("no longer accepting");
			const stop = driver.stop(new Error("cancelled preflight"));
			census.resolve([]);
			await Promise.all([launch, stop]);
			expect(_electron.launch).not.toHaveBeenCalled();
		} finally {
			census.resolve([]);
			await removeFixture(fixture);
		}
	});

	it("drains admitted installer preparation before deleting its cancelled fixture", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const prepared = deferred<void>();
		try {
			const preparation = driver.prepareFixture(() => prepared.promise);
			const rejectedPreparation = expect(preparation).rejects.toThrow("no longer accepting");
			await expect(driver.launch()).rejects.toThrow("fixture preparation settles");
			let removed = false;
			const stopping = driver.stop(new Error("fixture preparation cancelled")).finally(() => {
				removed = true;
			});
			const rejectedStop = expect(stopping).rejects.toThrow("no longer accepting");
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(removed).toBe(false);
			await access(fixture.config.tempRoot);
			prepared.resolve();
			await rejectedPreparation;
			await rejectedStop;
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
		} finally {
			prepared.resolve();
			await removeFixture(fixture);
		}
	});

	it("refuses installer I/O when stopped in the same turn as preparation admission", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const operation = vi.fn(async () => undefined);
		try {
			const preparation = driver.prepareFixture(operation);
			const rejectedPreparation = expect(preparation).rejects.toThrow("no longer accepting");
			await expect(driver.stop(new Error("same-turn interruption"))).rejects.toThrow("no longer accepting");
			await rejectedPreparation;
			expect(operation).not.toHaveBeenCalled();
		} finally {
			await removeFixture(fixture);
		}
	});

	it("attempts shutdown timeout evidence before fallback and removes auth even if capture fails", async () => {
		const fixture = await createFixture();
		fixture.keepTemp = true;
		await mkdir(join(fixture.config.tempRoot, "codex-home"));
		await writeFile(join(fixture.config.tempRoot, "codex-home", "auth.json"), "synthetic auth");
		const main = markedMain(fixture);
		vi.mocked(_electron.launch).mockResolvedValue(
			mockApplication(main.pid, async () => {
				throw new Error("SDK close failed");
			}),
		);
		vi.mocked(listDesktopProcesses).mockResolvedValue([main]);
		vi.mocked(captureDesktopShutdownEvidence).mockRejectedValueOnce(new Error("private diagnostic detail"));
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			await driver.launch();
			await expect(driver.stop()).rejects.toThrow("SDK close failed");
			expect(captureDesktopShutdownEvidence).toHaveBeenCalledWith(fixture, {
				attemptedAt: expect.any(String),
				timedOutAt: expect.any(String),
				originalMain: main,
				helper: null,
				retainedProcesses: [main],
			});
			expect(vi.mocked(captureDesktopShutdownEvidence).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(stopOwnedDesktopProcesses).mock.invocationCallOrder[0] ?? 0,
			);
			expect(fixture.manifest.failure).toContain("timeout evidence could not be retained");
			expect(fixture.manifest.failure).not.toContain("private diagnostic detail");
			expect(fixture.manifest.shutdown?.fallbackUsed).toBe(true);
			expect(cleanupPollWait).toHaveBeenCalledTimes(19);
			expect(cleanupPollWait.mock.calls.every(([milliseconds]) => milliseconds === 100)).toBe(true);
			await expect(access(join(fixture.config.tempRoot, "codex-home"))).rejects.toThrow();
		} finally {
			await driver.stop().catch(() => undefined);
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("observes actual second-instance acknowledgements without replacing the observer", async () => {
		const fixture = await createFixture();
		let secondInstanceListener: (() => void) | undefined;
		const on = vi.fn((_event: "second-instance", listener: () => void) => {
			secondInstanceListener = listener;
		});
		const module: DesktopEvaluationModule = {
			app: {
				isPackaged: true,
				getAppPath: () => fixture.manifest.appPath,
				getPath: () => fixture.config.userDataPath,
				emit: () => true,
				on,
			},
			BrowserWindow: { getAllWindows: () => [] },
		};
		const page = { on: vi.fn(), setDefaultTimeout: vi.fn() };
		const application = {
			once: vi.fn(),
			process: () => new ChildProcess(),
			context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
			windows: () => [page],
			firstWindow: async () => page,
			evaluate: async (callback: (value: DesktopEvaluationModule) => unknown) => callback(module),
			close: async () => {},
		} as unknown as ElectronApplication;
		vi.mocked(_electron.launch).mockResolvedValue(application);
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			await driver.launch();
			const readCount = await driver.observeSecondInstances();
			expect(await readCount()).toBe(0);
			secondInstanceListener?.();
			expect(await readCount()).toBe(1);
			const readAgain = await driver.observeSecondInstances();
			expect(await readAgain()).toBe(1);
			expect(on).toHaveBeenCalledTimes(1);
		} finally {
			await driver.stop();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("retains only the captured secondary fixture tree for exact cleanup", async () => {
		const fixture = await createFixture();
		fixture.manifest.mainPid = 51_000;
		fixture.manifest.helperPid = 51_001;
		const secondary: DesktopLabProcess = {
			pid: 52_000,
			parentPid: process.pid,
			startedAt: "Thu Oct  1 14:45:00 2026",
			command: `${fixture.manifest.executablePath} --user-data-dir=${fixture.config.userDataPath}`,
		};
		const descendant = { ...secondary, pid: 52_001, parentPid: secondary.pid, command: "synthetic child" };
		const unrelated = { ...secondary, pid: 53_000, command: "unrelated application" };
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			expect(() => driver.retainSecondaryLaunchProcesses([secondary, unrelated])).toThrow("isolated process tree");
			expect(() => driver.retainSecondaryLaunchProcesses([{ ...secondary, pid: 51_000 }])).toThrow(
				"isolated process tree",
			);
			driver.retainSecondaryLaunchProcesses([secondary, descendant]);
			vi.mocked(listDesktopProcesses).mockResolvedValue([secondary, descendant]);
			await driver.stop(new Error("Secondary cleanup only"));
			expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith([secondary, descendant]);
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("retains a marked alternate installation only inside the same private fixture", async () => {
		const fixture = await createFixture();
		const appPath = join(fixture.config.tempRoot, "managed-alternate/Quarterdeck.app");
		const secondary: DesktopLabProcess = {
			pid: 52_000,
			parentPid: process.pid,
			startedAt: "Thu Oct  1 14:45:00 2026",
			command: `${appPath}/Contents/MacOS/Quarterdeck --user-data-dir=${fixture.config.userDataPath}`,
		};
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			expect(() => driver.retainSecondaryLaunchProcesses([secondary], "/other/Quarterdeck.app")).toThrow(
				"outside its isolated fixture",
			);
			driver.retainSecondaryLaunchProcesses([secondary], appPath);
			vi.mocked(listDesktopProcesses).mockResolvedValue([secondary]);
			await driver.stop(new Error("Alternate secondary cleanup only"));
			expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith([secondary]);
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("never tracks or submits an unmarked reused main PID or its descendants to cleanup on the first capture", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const reused: DesktopLabProcess = {
			pid: 50_000,
			parentPid: 1,
			startedAt: "Thu Oct  1 14:45:01 2026",
			command: "unrelated application",
		};
		const unrelatedChild = { ...reused, pid: 50_001, parentPid: reused.pid, command: "unrelated child" };
		const child = new ChildProcess();
		Object.defineProperty(child, "pid", { value: reused.pid });
		const page = { on: vi.fn(), setDefaultTimeout: vi.fn() };
		vi.mocked(_electron.launch).mockResolvedValue({
			once: vi.fn(),
			process: () => child,
			context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
			windows: () => [page],
			firstWindow: async () => page,
			close: async () => {},
		} as unknown as ElectronApplication);
		vi.mocked(listDesktopProcesses).mockResolvedValue([reused, unrelatedChild]);
		await writeFile(
			fixture.config.processEvidencePath,
			JSON.stringify({
				version: 1,
				appPid: reused.pid,
				helperPid: null,
				generation: null,
				runtimeOrigin: null,
				phase: "starting",
			}),
		);
		try {
			await driver.launch();
			expect(fixture.manifest.mainPid).toBe(reused.pid);
			expect(fixture.manifest.processes).toEqual([]);
			await driver.stop();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
		} finally {
			await driver.stop();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("tracks a marked main tree and retains captured descendants after reparenting and main PID reuse", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const main: DesktopLabProcess = {
			pid: 50_000,
			parentPid: 1,
			startedAt: "Thu Oct  1 14:45:00 2026",
			command: `${fixture.manifest.executablePath} --user-data-dir=${fixture.config.userDataPath}`,
		};
		const helper = { ...main, pid: 50_001, parentPid: main.pid, command: "synthetic helper" };
		const provider = { ...main, pid: 50_002, parentPid: helper.pid, command: "synthetic provider" };
		const renderer = { ...main, pid: 50_003, parentPid: main.pid, command: "synthetic --type=renderer" };
		fixture.manifest.mainPid = main.pid;
		await writeFile(
			fixture.config.processEvidencePath,
			JSON.stringify({
				version: 1,
				appPid: main.pid,
				helperPid: helper.pid,
				generation: "synthetic",
				runtimeOrigin: "http://127.0.0.1:45000",
				phase: "ready",
			}),
		);
		try {
			vi.mocked(listDesktopProcesses).mockResolvedValue([main, helper, provider, renderer]);
			await driver.markReady();
			expect(fixture.manifest.processes).toEqual([main, helper, provider, renderer]);
			expect(fixture.manifest.rendererPids).toEqual([renderer.pid]);
			const orphanedHelper = { ...helper, parentPid: 1 };
			const orphanedRenderer = { ...renderer, parentPid: 1 };
			const reusedMain = { ...main, startedAt: "Thu Oct  1 14:45:01 2026", command: "unrelated application" };
			vi.mocked(listDesktopProcesses).mockResolvedValue([reusedMain, orphanedHelper, provider, orphanedRenderer]);
			await driver.markReady();
			expect(fixture.manifest.helperPid).toBe(helper.pid);
			expect(fixture.manifest.rendererPids).toEqual([renderer.pid]);
			expect(fixture.manifest.processes).toEqual([main, orphanedHelper, provider, orphanedRenderer]);
			vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			await driver.stop(new Error("Process capture only"));
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			expect(fixture.manifest.shutdown?.remainingBeforeFallback).toEqual([]);
		} finally {
			vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			await driver.stop();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("accepts completed SDK Quit only after the exact owned forest drains without fallback", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const main = markedMain(fixture);
		const helper = { ...main, pid: 50_001, parentPid: main.pid, command: "synthetic helper" };
		const close = vi.fn(async () => {});
		cleanupPollWait.mockImplementationOnce(async () => {
			vi.mocked(listDesktopProcesses).mockResolvedValue([]);
		});
		vi.mocked(_electron.launch).mockResolvedValue(mockApplication(main.pid, close));
		vi.mocked(listDesktopProcesses).mockResolvedValue([main, helper]);
		try {
			await driver.launch();
			await expect(driver.stop()).resolves.toBeUndefined();
			expect(close).toHaveBeenCalledOnce();
			expect(cleanupPollWait).toHaveBeenCalledExactlyOnceWith(100);
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			expect(fixture.manifest.shutdown).toEqual({
				gracefulQuit: { attempted: true, outcome: "sdk_close_completed" },
				remainingBeforeFallback: [],
				fallbackUsed: false,
			});
			expect(fixture.manifest.status).toBe("stopped");
			expect(fixture.manifest.remainingPids).toEqual([]);
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
			expect(JSON.parse(await readFile(fixture.manifestPath, "utf8"))).toMatchObject({
				shutdown: fixture.manifest.shutdown,
			});
		} finally {
			await driver.stop().catch(() => {});
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it.each(["normal", "earlier_failed_scenario"] as const)(
		"records successful fallback cleanup without treating it as graceful Quit: %s",
		async (scenario) => {
			const fixture = await createFixture();
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			const main = markedMain(fixture);
			const helper = { ...main, pid: 50_001, parentPid: main.pid, command: "synthetic helper" };
			const orphanedHelper = { ...helper, parentPid: 1 };
			const close = vi.fn(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([orphanedHelper]);
			});
			vi.mocked(_electron.launch).mockResolvedValue(mockApplication(main.pid, close));
			vi.mocked(listDesktopProcesses).mockResolvedValue([main, helper]);
			vi.mocked(stopOwnedDesktopProcesses).mockImplementation(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([]);
				return [];
			});
			try {
				await driver.launch();
				if (scenario === "normal") {
					await expect(driver.stop()).rejects.toThrow("graceful Quit required fallback");
					expect(fixture.manifest.failure).toBe("Desktop graceful Quit required fallback process cleanup.");
				} else {
					await expect(driver.stop(new Error("Original scenario failure"))).resolves.toBeUndefined();
					expect(fixture.manifest.failure).toBe("Original scenario failure");
				}
				expect(close).toHaveBeenCalledOnce();
				expect(stopOwnedDesktopProcesses).toHaveBeenCalledExactlyOnceWith([main, helper]);
				expect(fixture.manifest.shutdown).toEqual({
					gracefulQuit: { attempted: true, outcome: "sdk_close_completed" },
					remainingBeforeFallback: [orphanedHelper],
					fallbackUsed: true,
				});
				expect(fixture.manifest.status).toBe("failed");
				expect(fixture.manifest.remainingPids).toEqual([]);
				await expect(access(fixture.config.tempRoot)).rejects.toThrow();
			} finally {
				await driver.stop().catch(() => {});
				await rm(fixture.config.tempRoot, { recursive: true, force: true });
				await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
			}
		},
	);

	it("rejects an unconfirmed SDK Quit even when no owned processes need fallback", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		const main = markedMain(fixture);
		const close = vi.fn(async () => {
			vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			throw new Error("Synthetic SDK Quit failed");
		});
		vi.mocked(_electron.launch).mockResolvedValue(mockApplication(main.pid, close));
		vi.mocked(listDesktopProcesses).mockResolvedValue([main]);
		try {
			await driver.launch();
			await expect(driver.stop()).rejects.toThrow("Desktop graceful Quit was not confirmed.");
			expect(fixture.manifest.failure).toContain("Synthetic SDK Quit failed");
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			expect(fixture.manifest.shutdown).toEqual({
				gracefulQuit: { attempted: true, outcome: "unconfirmed" },
				remainingBeforeFallback: [],
				fallbackUsed: false,
			});
			expect(fixture.manifest.status).toBe("failed");
			expect(fixture.manifest.remainingPids).toEqual([]);
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
		} finally {
			await driver.stop().catch(() => {});
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("resizes only one private product window within the lab viewport bounds", async () => {
		const fixture = await createFixture();
		let url = "app://quarterdeck/project";
		let windowCount = 1;
		const setSize = vi.fn();
		const window = {
			id: 1,
			isVisible: () => false,
			isFocused: () => false,
			getBounds: () => ({ x: 0, y: 0, width: 1280, height: 860 }),
			setSize,
			close: () => {},
			webContents: { getURL: () => url, getOSProcessId: () => 50_005, forcefullyCrashRenderer: () => {} },
		};
		const module: DesktopEvaluationModule = {
			app: {
				isPackaged: true,
				getAppPath: () => fixture.manifest.appPath,
				getPath: () => fixture.config.userDataPath,
				emit: () => true,
				on: () => {},
			},
			BrowserWindow: { getAllWindows: () => Array.from({ length: windowCount }, () => window) },
		};
		const page = { on: vi.fn(), setDefaultTimeout: vi.fn() };
		const application = {
			once: vi.fn(),
			process: () => new ChildProcess(),
			context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
			windows: () => [page],
			firstWindow: async () => page,
			evaluate: async (
				callback: (value: DesktopEvaluationModule, size: { width: number; height: number }) => unknown,
				size: { width: number; height: number },
			) => callback(module, size),
			close: async () => {},
		} as unknown as ElectronApplication;
		vi.mocked(_electron.launch).mockResolvedValue(application);
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			await driver.launch();
			await expect(driver.resizeOwnedWindow(100_000, 720)).rejects.toThrow("bounded viewport");
			await expect(driver.resizeOwnedWindow(1180, 720)).resolves.toBeUndefined();
			expect(setSize).toHaveBeenCalledExactlyOnceWith(1180, 720);
			url = "https://example.invalid";
			await expect(driver.resizeOwnedWindow(1180, 720)).rejects.toThrow("isolated product surface");
			url = "app://quarterdeck/project";
			windowCount = 2;
			await expect(driver.resizeOwnedWindow(1180, 720)).rejects.toThrow("isolated product surface");
			expect(setSize).toHaveBeenCalledTimes(1);
		} finally {
			await driver.stop();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("fails a hidden checkpoint if the native window becomes visible or focused", async () => {
		const fixture = await createFixture();
		try {
			const child = new ChildProcess();
			const page = {
				on: vi.fn(),
				setDefaultTimeout: vi.fn(),
				locator: () => ({ ariaSnapshot: async () => "synthetic renderer" }),
			};
			const window = { id: 1, visible: false, focused: false };
			const inspection = {
				packaged: true,
				appPath: fixture.manifest.appPath,
				userDataPath: fixture.config.userDataPath,
				windows: [window],
			};
			const application = {
				once: vi.fn(),
				process: () => child,
				context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
				windows: () => [page],
				firstWindow: async () => page,
				evaluate: async () => inspection,
				close: async () => {},
			} as unknown as ElectronApplication;
			vi.mocked(_electron.launch).mockResolvedValue(application);
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			try {
				await driver.launch();
				await expect(driver.inspect("hidden")).resolves.toBeUndefined();
				window.focused = true;
				await expect(driver.inspect("focused")).rejects.toThrow("Hidden desktop lab");
				window.focused = false;
				window.visible = true;
				await expect(driver.inspect("visible")).rejects.toThrow("Hidden desktop lab");
				fixture.config.showWindow = true;
				await expect(driver.inspect("explicit-visible")).resolves.toBeUndefined();
			} finally {
				await driver.stop();
			}
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("cleans marked owned descendants after a failed SDK launch and records failure", async () => {
		const fixture = await createFixture();
		try {
			const remnant: DesktopLabProcess = {
				pid: 50_000,
				parentPid: 1,
				startedAt: "Thu Oct  1 12:00:00 2026",
				command: `${fixture.manifest.appPath}/Contents/Resources/node --simulate-host-integrations ${fixture.config.hostSimulationConfigPath}`,
			};
			vi.mocked(_electron.launch).mockRejectedValue(new Error("SDK handshake failed"));
			vi.mocked(listDesktopProcesses).mockResolvedValue([remnant]);
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			await expect(driver.launch()).rejects.toThrow("SDK handshake failed");
			await driver.stop(new Error("SDK handshake failed"));
			expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith([remnant]);
			expect(fixture.manifest.status).toBe("failed");
			expect(fixture.manifest.failure).toBe("SDK handshake failed");
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
			expect(JSON.parse(await readFile(fixture.manifestPath, "utf8"))).toMatchObject({
				surface: "electron",
				status: "failed",
				remainingPids: [],
			});
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("waits for an interrupted launch then closes its app exactly once before removing state", async () => {
		const fixture = await createFixture();
		try {
			let resolveLaunch: (application: ElectronApplication) => void = () => {
				throw new Error("Launch was not initialized.");
			};
			vi.mocked(_electron.launch).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveLaunch = resolve;
					}),
			);
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			const launched = driver.launch();
			await vi.waitFor(() => expect(_electron.launch).toHaveBeenCalledOnce());
			expect(_electron.launch).toHaveBeenCalledWith(
				expect.objectContaining({
					args: ["--use-mock-keychain", `--user-data-dir=${fixture.config.userDataPath}`],
					env: fixture.environment,
				}),
			);
			const rejectedLaunch = expect(launched).rejects.toThrow("cancelled");
			const stop = driver.stop(new Error("Interrupted"));
			expect(driver.stop()).toBe(stop);
			await expect(access(fixture.config.tempRoot)).resolves.toBeUndefined();
			const child = new ChildProcess();
			Object.defineProperty(child, "pid", { value: 50_000 });
			const close = vi.fn(async () => {});
			resolveLaunch({ once: vi.fn(), process: () => child, close } as unknown as ElectronApplication);
			await rejectedLaunch;
			await stop;
			expect(close).toHaveBeenCalledOnce();
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
			expect(fixture.manifest.status).toBe("failed");
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("retains synthetic state when process inspection cannot verify cleanup", async () => {
		const fixture = await createFixture();
		try {
			vi.mocked(_electron.launch).mockRejectedValue(new Error("SDK handshake failed"));
			vi.mocked(listDesktopProcesses)
				.mockResolvedValueOnce([])
				.mockRejectedValue(new Error("Process inspection unavailable"));
			vi.mocked(stopOwnedDesktopProcesses).mockRejectedValue(new Error("Process inspection unavailable"));
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			await expect(driver.launch()).rejects.toThrow("SDK handshake failed");
			await expect(driver.stop(new Error("SDK handshake failed"))).rejects.toThrow("Process inspection unavailable");
			await expect(access(fixture.config.tempRoot)).resolves.toBeUndefined();
			expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith([]);
			expect(fixture.manifest.status).toBe("failed");
			expect(fixture.manifest.shutdown).toEqual({
				gracefulQuit: { attempted: false, outcome: "not_attempted" },
				remainingBeforeFallback: null,
				fallbackUsed: true,
			});
			expect(fixture.manifest.failure).toContain("SDK handshake failed");
			expect(fixture.manifest.failure).toContain("Process inspection unavailable");
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("removes staged provider profiles even when keepTemp retains failed synthetic state", async () => {
		const fixture = await createFixture();
		fixture.keepTemp = true;
		try {
			for (const directory of ["codex-home", "claude-config"]) {
				await mkdir(join(fixture.config.tempRoot, directory));
				await writeFile(join(fixture.config.tempRoot, directory, "auth.json"), "synthetic-credential");
			}
			vi.mocked(_electron.launch).mockRejectedValue(new Error("SDK handshake failed"));
			const driver = new DesktopLabDriver(fixture, cleanupPollWait);
			await expect(driver.launch()).rejects.toThrow("SDK handshake failed");
			await driver.stop(new Error("SDK handshake failed"));
			await expect(access(fixture.config.tempRoot)).resolves.toBeUndefined();
			await expect(access(join(fixture.config.tempRoot, "codex-home"))).rejects.toThrow();
			await expect(access(join(fixture.config.tempRoot, "claude-config"))).rejects.toThrow();
			expect(await readFile(fixture.manifestPath, "utf8")).not.toContain("synthetic-credential");
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("restricts task cleanup to the exact provider identity below the owned helper", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			const process = (pid: number, parentPid: number, command: string): DesktopLabProcess => ({
				pid,
				parentPid,
				command,
				startedAt: "Thu Oct  1 12:00:00 2026",
			});
			const main = process(
				50_000,
				1,
				`${fixture.manifest.executablePath} --user-data-dir=${fixture.config.userDataPath}`,
			);
			const helper = process(
				50_001,
				main.pid,
				`${fixture.manifest.appPath}/Contents/Resources/node --simulate-host-integrations ${fixture.config.hostSimulationConfigPath}`,
			);
			const provider = process(50_002, helper.pid, "codex synthetic-provider");
			const renderer = process(50_003, main.pid, `${fixture.manifest.appPath}/Contents/renderer --type=renderer`);
			const unrelated = process(50_004, 1, "codex unrelated-provider");
			vi.mocked(listDesktopProcesses).mockResolvedValue([main, helper, provider, renderer, unrelated]);
			await writeFile(
				fixture.config.processEvidencePath,
				JSON.stringify({
					version: 1,
					appPid: main.pid,
					helperPid: helper.pid,
					generation: "synthetic",
					runtimeOrigin: "http://127.0.0.1:45000",
					phase: "ready",
				}),
			);
			const child = new ChildProcess();
			Object.defineProperty(child, "pid", { value: main.pid });
			const page = { on: vi.fn(), setDefaultTimeout: vi.fn() };
			vi.mocked(_electron.launch).mockResolvedValue({
				once: vi.fn(),
				process: () => child,
				context: () => ({ on: vi.fn(), off: vi.fn(), addInitScript: async () => {} }),
				windows: () => [page],
				firstWindow: async () => page,
				close: async () => {},
			} as unknown as ElectronApplication);
			await driver.launch();
			await expect(driver.stopOwnedTaskProcess(renderer)).rejects.toThrow("unverified");
			await expect(driver.stopOwnedTaskProcess(unrelated)).rejects.toThrow("unverified");
			await expect(driver.stopOwnedTaskProcess(helper)).rejects.toThrow("distinct owned provider");
			await expect(driver.stopOwnedTaskProcess({ ...provider, startedAt: "older process birth" })).rejects.toThrow(
				"unverified",
			);
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			await driver.stopOwnedTaskProcess(provider);
			expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith([provider]);
		} finally {
			vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			await driver.stop();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("disconnects only the recovered observer before graceful Electron Quit", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			vi.mocked(listDesktopProcesses).mockResolvedValue([markedMain(fixture)]);
			const quit = vi.fn(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			});
			vi.mocked(_electron.launch).mockResolvedValue(mockApplication(50_000, quit));
			await driver.launch();
			const disconnect = vi.fn(async () => {});
			Reflect.set(driver, "rendererObserver", { close: disconnect });
			await driver.stop();
			expect(disconnect).toHaveBeenCalledOnce();
			expect(quit).toHaveBeenCalledOnce();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			expect(
				JSON.parse(await readFile(join(fixture.manifest.artifactDir, "renderer-observer-disconnect.json"), "utf8")),
			).toMatchObject({ originalApplicationAlive: true, disconnected: true });
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("still quits Electron and removes staged auth when observer detach times out", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			await mkdir(join(fixture.config.tempRoot, "codex-home"));
			await writeFile(join(fixture.config.tempRoot, "codex-home", "auth.json"), "synthetic-credential");
			vi.mocked(listDesktopProcesses).mockResolvedValue([markedMain(fixture)]);
			const quit = vi.fn(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			});
			vi.mocked(_electron.launch).mockResolvedValue(mockApplication(50_000, quit));
			await driver.launch();
			const disconnectStarted = deferred<void>();
			Reflect.set(driver, "rendererObserver", {
				close: () => {
					disconnectStarted.resolve();
					return new Promise<void>(() => {});
				},
			});
			vi.useFakeTimers({ toFake: ["setTimeout"] });
			const stopped = expect(driver.stop()).rejects.toThrow("observer disconnect was not confirmed");
			await disconnectStarted.promise;
			await vi.advanceTimersByTimeAsync(5_001);
			await stopped;
			vi.useRealTimers();
			expect(quit).toHaveBeenCalledOnce();
			expect(fixture.keepTemp).toBe(true);
			expect(fixture.manifest.remainingPids).toEqual([]);
			await expect(access(join(fixture.config.tempRoot, "codex-home"))).rejects.toThrow();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it("waits for a pending observer registration before disconnect and Quit", async () => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			vi.mocked(listDesktopProcesses).mockResolvedValue([markedMain(fixture)]);
			const quit = vi.fn(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			});
			vi.mocked(_electron.launch).mockResolvedValue(mockApplication(50_000, quit));
			await driver.launch();
			let complete!: () => void;
			const disconnect = vi.fn(async () => {});
			const pending = new Promise<void>((resolve) => {
				complete = resolve;
			}).then(() => {
				Reflect.set(driver, "rendererObserver", { close: disconnect });
				return {} as Page;
			});
			Reflect.set(driver, "rendererObservation", pending);
			expect(driver.rendererPages()).toEqual([]);
			const stopping = driver.stop();
			await new Promise((resolve) => setImmediate(resolve));
			expect(quit).not.toHaveBeenCalled();
			complete();
			await stopping;
			expect(disconnect).toHaveBeenCalledOnce();
			expect(quit).toHaveBeenCalledOnce();
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});

	it.each(["main-reused", "wrong-fixture"])("rejects %s before attaching any observer", async (failure) => {
		const fixture = await createFixture();
		const driver = new DesktopLabDriver(fixture, cleanupPollWait);
		try {
			const main = markedMain(fixture);
			vi.mocked(listDesktopProcesses).mockResolvedValue([main]);
			const quit = vi.fn(async () => {
				vi.mocked(listDesktopProcesses).mockResolvedValue([]);
			});
			const application = mockApplication(main.pid, quit);
			Reflect.set(application, "evaluate", async () => ({
				mainPid: main.pid,
				packaged: true,
				appPath: "/foreign/app.asar",
				userDataPath: "/foreign/profile",
				windowId: 1,
				webContentsId: 1,
				rendererPid: 60_000,
				url: "app://quarterdeck/__desktop/error",
			}));
			vi.mocked(_electron.launch).mockResolvedValue(application);
			await driver.launch();
			if (failure === "main-reused")
				vi.mocked(listDesktopProcesses).mockResolvedValue([{ ...main, startedAt: "reused PID birth" }]);
			await expect(driver.reobserveAfterRendererCrash(1)).rejects.toThrow(
				failure === "main-reused" ? "original main process" : "another application fixture",
			);
			await driver.stop(new Error("expected refused observation"));
			expect(quit).toHaveBeenCalledOnce();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
		} finally {
			await rm(fixture.config.tempRoot, { recursive: true, force: true });
			await rm(fixture.manifest.artifactDir, { recursive: true, force: true });
		}
	});
});

describe("desktop main-loss retirement and admitted writer drain", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listDesktopProcesses).mockResolvedValue([]);
		vi.mocked(stopOwnedDesktopProcesses).mockResolvedValue([]);
	});

	it("archives a distinct first manifest, preserves profile/history and makes late old stop inert", async () => {
		const { fixture, driver, proof, quit } = await prepareRetirement();
		try {
			await writeFile(join(fixture.config.userDataPath, "synthetic-profile"), "same profile");
			await mkdir(join(fixture.config.tempRoot, "synthetic-history"));
			await writeFile(join(fixture.config.tempRoot, "synthetic-history", "conversation"), "exact history");
			const next = await driver.retireAfterMainLoss(proof);
			expect(next).not.toBe(fixture);
			expect(next.manifest).not.toBe(fixture.manifest);
			expect(next.config).toEqual(fixture.config);
			expect(next.environment).toEqual(fixture.environment);
			expect(next.manifest).toMatchObject({ status: "starting", mainPid: null, helperPid: null, processes: [] });
			const archived = JSON.parse(
				await readFile(join(fixture.manifest.artifactDir, "main-loss-first-manifest.json"), "utf8"),
			);
			expect(archived.manifest).toMatchObject({ status: "stopped", mainPid: proof.main.pid });
			expect(archived.manifest.shutdown).toBeUndefined();
			expect(archived.proof.ownershipAfter).toMatchObject({ released: true, processState: "dead" });
			const beforeLateStop = await readFile(fixture.manifestPath, "utf8");
			vi.mocked(listDesktopProcesses).mockResolvedValue([
				{ ...proof.main, pid: 60_000, startedAt: "new main birth" },
			]);
			await driver.stop(new Error("late first-leg cleanup"));
			expect(quit).not.toHaveBeenCalled();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
			expect(await readFile(fixture.manifestPath, "utf8")).toBe(beforeLateStop);
			expect(await readFile(join(fixture.config.userDataPath, "synthetic-profile"), "utf8")).toBe("same profile");
			expect(await readFile(join(fixture.config.tempRoot, "synthetic-history", "conversation"), "utf8")).toBe(
				"exact history",
			);
			expect(() => driver.inspect("late")).toThrow("no longer accepting");
		} finally {
			await removeFixture(fixture);
		}
	});

	it("drains every admitted sibling before propagating a capture rejection", async () => {
		const { fixture, driver, proof } = await prepareRetirement();
		const sibling = deferred<void>();
		const first = Promise.reject(new Error("first admitted capture failed"));
		void first.catch(() => {});
		Reflect.set(driver, "captures", new Set([first, sibling.promise]));
		try {
			const retiring = driver.retireAfterMainLoss(proof);
			let finished = false;
			void retiring.then(
				() => {
					finished = true;
				},
				() => {
					finished = true;
				},
			);
			await new Promise((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
			await expect(access(join(fixture.manifest.artifactDir, "main-loss-first-manifest.json"))).rejects.toThrow();
			sibling.resolve();
			await expect(retiring).rejects.toThrow("first admitted capture failed");
			expect(fixture.keepTemp).toBe(true);
			Reflect.set(driver, "captures", new Set());
			await driver.stop(new Error("original scenario failure"));
			expect(fixture.manifest.failure).toContain("original scenario failure");
		} finally {
			sibling.resolve();
			await removeFixture(fixture);
		}
	});

	it("waits for late observer registration, then disconnects it before handing off", async () => {
		const { fixture, driver, proof } = await prepareRetirement();
		const observation = deferred<Page>();
		const disconnect = vi.fn(async () => {});
		Reflect.set(
			driver,
			"rendererObservation",
			observation.promise.then((page) => {
				Reflect.set(driver, "rendererObserver", { close: disconnect });
				return page;
			}),
		);
		try {
			const retiring = driver.retireAfterMainLoss(proof);
			await new Promise((resolve) => setImmediate(resolve));
			expect(disconnect).not.toHaveBeenCalled();
			observation.resolve({} as Page);
			await retiring;
			expect(disconnect).toHaveBeenCalledOnce();
			await driver.stop();
			expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
		} finally {
			observation.resolve({} as Page);
			await removeFixture(fixture);
		}
	});

	it.each(["query", "survivor", "archive", "log", "observer", "identity", "release", "generation"])(
		"keeps the old cleanup owner on %s failure and retains proof-discovered orphan custody",
		async (failure) => {
			const { fixture, driver, main, proof, quit } = await prepareRetirement();
			const orphan = { ...main, pid: 50_099, parentPid: 1, command: "synthetic proven orphan" };
			proof.ownedProcesses.push(orphan);
			const rejectedLog = Promise.reject(new Error("synthetic log failure"));
			void rejectedLog.catch(() => {});
			try {
				if (failure === "query")
					vi.mocked(listDesktopProcesses).mockRejectedValueOnce(new Error("synthetic query failed"));
				if (failure === "survivor") vi.mocked(listDesktopProcesses).mockResolvedValue([orphan]);
				if (failure === "archive") await mkdir(join(fixture.manifest.artifactDir, "main-loss-first-manifest.json"));
				if (failure === "log") Reflect.set(driver, "logWrites", rejectedLog);
				if (failure === "observer")
					Reflect.set(driver, "rendererObserver", {
						close: async () => {
							throw new Error("synthetic observer failed");
						},
					});
				if (failure === "identity")
					proof.fixtureIdentity = { ...proof.fixtureIdentity, userDataPath: "/unrelated/profile" };
				if (failure === "release") proof.ownershipAfter.released = false;
				if (failure === "generation") proof.ownershipAfter.generation = "replacement-generation";
				await expect(driver.retireAfterMainLoss(proof)).rejects.toThrow();
				expect(fixture.keepTemp).toBe(true);
				Reflect.set(driver, "logWrites", Promise.resolve());
				Reflect.set(driver, "rendererObserver", null);
				vi.mocked(listDesktopProcesses).mockResolvedValue([orphan]);
				quit.mockImplementation(async () => {});
				const stopping = driver.stop(new Error("original main-loss failure"));
				await stopping;
				expect(stopOwnedDesktopProcesses).toHaveBeenCalledWith(expect.arrayContaining([orphan]));
				expect(fixture.manifest.failure).toContain("original main-loss failure");
				await access(fixture.config.tempRoot);
			} finally {
				await driver.stop(new Error("failure cleanup")).catch(() => {});
				await removeFixture(fixture);
			}
		},
	);

	it("does not start or signal a proof when stop wins before its admitted microtask", async () => {
		const { fixture, driver, proof, quit } = await prepareRetirement();
		const operation = vi.fn(async () => proof);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const observed = driver.observeMainLossProof(operation);
			const rejected = expect(observed).rejects.toThrow("no longer accepting");
			await driver.stop(new Error("interrupt before proof"));
			await rejected;
			expect(operation).not.toHaveBeenCalled();
			expect(kill).not.toHaveBeenCalled();
			expect(quit).toHaveBeenCalledOnce();
		} finally {
			kill.mockRestore();
			await removeFixture(fixture);
		}
	});

	it("denies the exact main signal if stop arrives during the proof's pre-signal read", async () => {
		const { fixture, driver, proof, quit } = await prepareRetirement();
		const entered = deferred<void>();
		const read = deferred<void>();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const observed = driver.observeMainLossProof(async (signalMain) => {
				entered.resolve();
				await read.promise;
				signalMain(proof.main.pid, "SIGKILL");
				return proof;
			});
			await entered.promise;
			const rejected = expect(observed).rejects.toThrow("no longer accepting");
			const stopping = driver.stop(new Error("interrupt during proof reads"));
			await new Promise((resolve) => setImmediate(resolve));
			expect(quit).not.toHaveBeenCalled();
			read.resolve();
			await rejected;
			await stopping;
			expect(kill).not.toHaveBeenCalled();
			expect(quit).toHaveBeenCalledOnce();
		} finally {
			read.resolve();
			kill.mockRestore();
			await removeFixture(fixture);
		}
	});

	it.each(["proof", "error"])(
		"waits after a main signal for %s custody before one exact orphan cleanup",
		async (outcome) => {
			const { fixture, driver, proof, main, quit } = await prepareRetirement();
			const signalled = deferred<void>();
			const finish = deferred<void>();
			const orphan = { ...main, pid: 50_099, parentPid: 1, command: "synthetic reparented provider" };
			proof.ownedProcesses.push(orphan);
			const failure = new DesktopMainLossError("parent-loss observation failed", true, proof.ownedProcesses);
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			try {
				const observed = driver.observeMainLossProof(async (signalMain) => {
					signalMain(main.pid, "SIGKILL");
					signalled.resolve();
					await finish.promise;
					if (outcome === "error") throw failure;
					return proof;
				});
				const observedOutcome =
					outcome === "error" ? expect(observed).rejects.toBe(failure) : expect(observed).resolves.toBe(proof);
				await signalled.promise;
				vi.mocked(listDesktopProcesses).mockResolvedValue([orphan]);
				quit.mockImplementation(async () => {});
				const stopping = driver.stop(new Error("interrupt after exact main loss"));
				expect(driver.stop()).toBe(stopping);
				await new Promise((resolve) => setImmediate(resolve));
				expect(quit).not.toHaveBeenCalled();
				expect(stopOwnedDesktopProcesses).not.toHaveBeenCalled();
				await access(fixture.config.tempRoot);
				finish.resolve();
				await observedOutcome;
				await stopping;
				expect(kill).toHaveBeenCalledExactlyOnceWith(main.pid, "SIGKILL");
				expect(quit).toHaveBeenCalledOnce();
				expect(stopOwnedDesktopProcesses).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([orphan]));
				expect(fixture.manifest.failure).toContain("interrupt after exact main loss");
				await expect(access(fixture.config.tempRoot)).rejects.toThrow();
			} finally {
				finish.resolve();
				kill.mockRestore();
				await removeFixture(fixture);
			}
		},
	);

	it("bounds a stuck retirement capture without handing off or making old cleanup inert", async () => {
		const { fixture, driver, proof, quit } = await prepareRetirement();
		const capture = deferred<void>();
		Reflect.set(driver, "captures", new Set([capture.promise]));
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const retiring = driver.retireAfterMainLoss(proof);
			const failed = expect(retiring).rejects.toThrow("main-loss admitted capture drain timed out");
			await vi.advanceTimersByTimeAsync(5_001);
			await failed;
			expect(fixture.keepTemp).toBe(true);
			await expect(access(join(fixture.manifest.artifactDir, "main-loss-first-manifest.json"))).rejects.toThrow();
			capture.resolve();
			vi.useRealTimers();
			await driver.stop(new Error("retirement admission deadline"));
			expect(quit).toHaveBeenCalledOnce();
			expect(fixture.manifest.failure).toContain("retirement admission deadline");
			await access(fixture.config.tempRoot);
		} finally {
			capture.resolve();
			vi.useRealTimers();
			await removeFixture(fixture);
		}
	});

	it("supplies exact historical helper custody to bounded timeout evidence after the current helper has exited", async () => {
		const { fixture, driver, main, application } = await prepareRetirement();
		const helper = { ...main, pid: main.pid + 1, parentPid: main.pid, command: "synthetic exited helper" };
		try {
			driver.retainMainLossProcesses(new DesktopMainLossError("expected main loss", true, [main, helper]));
			await writeFile(
				fixture.config.processEvidencePath,
				JSON.stringify({
					version: 1,
					appPid: main.pid,
					helperPid: helper.pid,
					generation: "historical-generation",
					runtimeOrigin: null,
					phase: "failed",
				}),
			);
			Reflect.set(application, "close", async () => {
				throw new Error("synthetic SDK close failure");
			});
			await expect(driver.stop(new Error("primary failure"))).rejects.toThrow("synthetic SDK close failure");
			expect(fixture.manifest.helperPid).toBeNull();
			expect(captureDesktopShutdownEvidence).toHaveBeenCalledWith(
				fixture,
				expect.objectContaining({
					helper: null,
					retainedProcesses: expect.arrayContaining([main, helper]),
				}),
			);
		} finally {
			await removeFixture(fixture);
		}
	});

	it("transfers leaf error custody synchronously while refusing identities without the original main", async () => {
		const { fixture, driver, main } = await prepareRetirement();
		const orphan = { ...main, pid: 50_099, parentPid: 1, command: "synthetic orphan" };
		try {
			expect(() => driver.retainMainLossProcesses(new DesktopMainLossError("unrelated", true, [orphan]))).toThrow(
				"captured application identity",
			);
			driver.retainMainLossProcesses(new DesktopMainLossError("drain failed", true, [main, orphan]));
			expect(fixture.manifest.processes).toContainEqual(orphan);
		} finally {
			await driver.stop(new Error("expected failure"));
			await removeFixture(fixture);
		}
	});

	it("cancels retirement when stop takes cleanup ownership while admitted work drains", async () => {
		const { fixture, driver, proof, quit } = await prepareRetirement();
		const capture = deferred<void>();
		Reflect.set(driver, "captures", new Set([capture.promise]));
		try {
			const retiring = driver.retireAfterMainLoss(proof);
			const stopped = driver.stop(new Error("interrupt during main loss"));
			capture.resolve();
			await expect(retiring).rejects.toThrow("cancelled by cleanup");
			await stopped;
			expect(quit).toHaveBeenCalledOnce();
			expect(fixture.manifest.failure).toContain("interrupt during main loss");
			await expect(access(join(fixture.manifest.artifactDir, "main-loss-first-manifest.json"))).rejects.toThrow();
		} finally {
			capture.resolve();
			await removeFixture(fixture);
		}
	});

	it("waits for an inspection that timed out at its caller before final publication and fixture deletion", async () => {
		const { fixture, driver, application, quit } = await prepareRetirement();
		const evaluated = deferred<{ packaged: boolean; appPath: string; userDataPath: string; windows: [] }>();
		const entered = deferred<void>();
		Reflect.set(application, "evaluate", () => {
			entered.resolve();
			return evaluated.promise;
		});
		Reflect.set(driver, "rendererPages", () => []);
		try {
			const inspection = driver.inspect("late-inspection");
			await entered.promise;
			await expect(withDesktopDeadline(inspection, "Caller capture", 5)).rejects.toThrow("timed out");
			let finished = false;
			const stopping = driver.stop().then(() => {
				finished = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(quit).toHaveBeenCalledOnce();
			expect(finished).toBe(false);
			await access(fixture.config.tempRoot);
			evaluated.resolve({
				packaged: true,
				appPath: fixture.manifest.appPath,
				userDataPath: fixture.config.userDataPath,
				windows: [],
			});
			await inspection;
			await stopping;
			expect(JSON.parse(await readFile(fixture.manifestPath, "utf8"))).toMatchObject({ status: "stopped" });
			await access(join(fixture.manifest.artifactDir, "late-inspection.json"));
			await expect(access(fixture.config.tempRoot)).rejects.toThrow();
		} finally {
			evaluated.resolve({
				packaged: true,
				appPath: fixture.manifest.appPath,
				userDataPath: fixture.config.userDataPath,
				windows: [],
			});
			await removeFixture(fixture);
		}
	});

	it("reports uncertain capture settlement, retains the fixture and never publishes success even after exact process drain", async () => {
		const { fixture, driver } = await prepareRetirement();
		const pending = deferred<void>();
		Reflect.set(driver, "captures", new Set([pending.promise]));
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const stopping = driver.stop();
			const failed = expect(stopping).rejects.toThrow("capture drain was not confirmed");
			while (!Reflect.get(driver, "logsClosed")) await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(5_001);
			await failed;
			expect(fixture.keepTemp).toBe(true);
			expect(fixture.manifest.status).toBe("failed");
			expect(fixture.manifest.remainingPids).toEqual([]);
			await access(fixture.config.tempRoot);
			expect(JSON.parse(await readFile(fixture.manifestPath, "utf8")).status).not.toBe("stopped");
		} finally {
			pending.resolve();
			vi.useRealTimers();
			await removeFixture(fixture);
		}
	});
});
