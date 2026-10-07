import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coexistenceModule from "../../../scripts/agent-lab/desktop-browser-coexistence";
import {
	DesktopBrowserCoexistenceError,
	exerciseDesktopBrowserCoexistence,
} from "../../../scripts/agent-lab/desktop-browser-coexistence";
import { type DesktopLabFixture, prepareDesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import { exerciseDesktopMainLoss } from "../../../scripts/agent-lab/desktop-main-loss-scenario";
import { exerciseDesktopRendererRecovery } from "../../../scripts/agent-lab/desktop-renderer-recovery";
import type * as secondLaunchModule from "../../../scripts/agent-lab/desktop-second-launch";
import { proveDesktopSecondLaunch } from "../../../scripts/agent-lab/desktop-second-launch";
import { runDesktopSmoke } from "../../../scripts/agent-lab/desktop-smoke";

const mocks = vi.hoisted(() => {
	class Locator {
		waitFor = vi.fn(async () => {});
		click = vi.fn(async () => {});
		fill = vi.fn(async () => {});
		focus = vi.fn(async () => {});
		isVisible = vi.fn(async () => false);
		getAttribute = vi.fn(async () => "task-one");
		first() {
			return this;
		}
		filter() {
			return this;
		}
		getByRole() {
			return this;
		}
		getByPlaceholder() {
			return this;
		}
	}
	const locator = new Locator();
	const page = {
		url: () => "app://quarterdeck/project-one",
		evaluate: vi.fn(async () => ({ nodeRequire: false, nodeProcess: false })),
		locator: vi.fn(() => locator),
		getByRole: vi.fn(() => locator),
		keyboard: { type: vi.fn(async () => {}), press: vi.fn(async (_key: string) => {}) },
	};
	const driver = {
		launch: vi.fn(async () => page),
		markReady: vi.fn(async () => {}),
		inspect: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		resizeOwnedWindow: vi.fn(async () => {}),
		sockets: { assertTraffic: vi.fn() },
		app: {
			evaluate: vi.fn(async () => {
				throw new Error("Performance lane requested a native lifecycle action.");
			}),
		},
	};
	return { page, driver };
});

vi.mock("../../../scripts/agent-lab/desktop-driver", () => ({
	DesktopLabDriver: vi.fn(function Driver(fixture: DesktopLabFixture) {
		return { ...mocks.driver, fixture };
	}),
	withDesktopDeadline: <T>(promise: Promise<T>) => promise,
}));
vi.mock("../../../scripts/agent-lab/desktop-fixture", () => ({ prepareDesktopLabFixture: vi.fn() }));
vi.mock("../../../scripts/agent-lab/desktop-renderer-recovery", () => ({
	openDesktopPrimaryProject: vi.fn(async () => {}),
	exerciseDesktopRendererRecovery: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/desktop-main-loss-scenario", () => ({ exerciseDesktopMainLoss: vi.fn() }));
vi.mock("../../../scripts/agent-lab/desktop-second-launch", async (importOriginal) => ({
	...(await importOriginal<typeof secondLaunchModule>()),
	proveDesktopSecondLaunch: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/desktop-browser-coexistence", async (importOriginal) => ({
	...(await importOriginal<typeof coexistenceModule>()),
	exerciseDesktopBrowserCoexistence: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/desktop-session-evidence", () => ({
	readDesktopTaskSession: vi.fn(async () => ({})),
}));
vi.mock("../../../scripts/agent-lab/desktop-fake-readiness", () => ({
	projectDesktopFakeReadiness: vi.fn(() => ({ pid: 50003 })),
	assertDesktopFakeProcessOwnership: vi.fn(() => ({ startedAt: "synthetic-agent-birth" })),
	projectDesktopFakeReadinessDiagnostic: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/desktop-processes", () => ({
	listDesktopProcesses: vi.fn(async () => []),
	collectOwnedDesktopProcesses: vi.fn(),
	sameDesktopProcess: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/desktop-fake-history", () => ({ readDesktopFakeHistory: vi.fn(async () => ({})) }));

let fixture: DesktopLabFixture;
async function createFixture(): Promise<DesktopLabFixture> {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-performance-routing-"));
	const project = join(root, "project");
	const artifacts = join(root, "artifacts");
	await mkdir(project);
	await mkdir(artifacts);
	await writeFile(join(project, "desktop-smoke-proof.txt"), "packaged-pty-verified");
	return {
		config: {
			version: 1,
			tempRoot: root,
			stateHome: join(root, "state"),
			userDataPath: join(root, "user-data"),
			projectPath: project,
			hostSimulationConfigPath: join(root, "host.json"),
			processEvidencePath: join(root, "processes.json"),
		},
		configPath: join(root, "config.json"),
		manifestPath: join(artifacts, "desktop-manifest.json"),
		environment: {},
		forbiddenHostLaunchLogPath: join(artifacts, "forbidden-host-launches.log"),
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "routing-test",
			status: "ready",
			appPath: "/synthetic/Quarterdeck.app",
			executablePath: "/synthetic/Quarterdeck.app/Contents/MacOS/Quarterdeck",
			artifactDir: artifacts,
			tempRoot: root,
			userDataPath: join(root, "user-data"),
			stateHome: join(root, "state"),
			projectPath: project,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: 50001,
			helperPid: 50002,
			rendererPids: [],
			processes: [
				{ pid: 50002, parentPid: 50001, startedAt: "synthetic-helper-birth", command: "synthetic-helper" },
			],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
}

describe.skipIf(process.platform !== "darwin")("exclusive packaged performance routing", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		fixture = await createFixture();
		vi.mocked(prepareDesktopLabFixture).mockResolvedValue(fixture);
		vi.mocked(exerciseDesktopBrowserCoexistence).mockResolvedValue({
			owner: {
				pid: 50002,
				creationIdentity: "synthetic-helper-birth",
				generation: "generation",
				origin: "http://127.0.0.1:12345",
			},
			browserSession: "named-browser",
			before: {
				revision: 1,
				boardDigest: "board",
				taskId: "task-one",
				columnId: "review",
				sessionInstanceId: "pty",
				providerSessionId: "fake-session",
				pid: 50003,
				state: "awaiting_review",
				viewportRows: 30,
			},
			checkpoints: [],
			cleanupConfirmed: true,
			performance: undefined,
		});
	});
	afterEach(async () => {
		await rm(fixture.config.tempRoot, { recursive: true, force: true });
	});

	it("runs initial readiness, fake seed and paired measurement then normal owner cleanup without loss/reload/second launch", async () => {
		await runDesktopSmoke({ appPath: fixture.manifest.appPath, performance: true });
		expect(mocks.driver.launch).toHaveBeenCalledOnce();
		expect(mocks.driver.markReady).toHaveBeenCalledOnce();
		expect(exerciseDesktopBrowserCoexistence).toHaveBeenCalledOnce();
		const [, passedFixture, taskId, options] = vi.mocked(exerciseDesktopBrowserCoexistence).mock.calls[0] ?? [];
		expect(passedFixture).toBe(fixture);
		expect(taskId).toBe("task-one");
		expect(options?.performance).toEqual({ readAdmittedDesktop: expect.any(Function) });
		expect(mocks.driver.sockets.assertTraffic).toHaveBeenCalledOnce();
		expect(mocks.driver.inspect.mock.calls.at(-1)).toEqual(["completed"]);
		expect(mocks.driver.stop).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(mocks.driver.stop.mock.invocationCallOrder[0]).toBeGreaterThan(
			mocks.driver.inspect.mock.invocationCallOrder.at(-1) ?? 0,
		);
		expect(mocks.driver.app.evaluate).not.toHaveBeenCalled();
		expect(proveDesktopSecondLaunch).not.toHaveBeenCalled();
		expect(exerciseDesktopRendererRecovery).not.toHaveBeenCalled();
		expect(exerciseDesktopMainLoss).not.toHaveBeenCalled();
		expect(mocks.page.keyboard.press.mock.calls.every(([key]) => key === "Enter")).toBe(true);
		expect(await options?.performance?.readAdmittedDesktop()).toBe(fixture.manifest.processes);
	});

	it.each([true, false])(
		"preserves browser cleanup=%s failure ownership through normal stop",
		async (cleanupConfirmed) => {
			const error = new DesktopBrowserCoexistenceError(
				"named-browser",
				{
					pid: 50002,
					creationIdentity: "synthetic-helper-birth",
					generation: "generation",
					origin: "http://127.0.0.1:12345",
				},
				cleanupConfirmed,
				"performance",
			);
			vi.mocked(exerciseDesktopBrowserCoexistence).mockRejectedValueOnce(error);
			await expect(runDesktopSmoke({ appPath: fixture.manifest.appPath, performance: true })).rejects.toThrow(
				"Desktop evidence:",
			);
			expect(fixture.keepTemp).toBe(!cleanupConfirmed);
			expect(mocks.driver.stop).toHaveBeenCalledExactlyOnceWith(error);
			expect(exerciseDesktopRendererRecovery).not.toHaveBeenCalled();
			expect(mocks.driver.app.evaluate).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ includeAgent: false },
		{ showWindow: true },
		{ agentMode: "real-codex" as const },
		{ agentMode: "real-claude" as const },
		{ npmLaunch: true },
		{ manualShells: true },
		{ nativeExperience: true },
		{ mainLoss: true },
	])("rejects conflicting performance options before fixture or app launch: %j", async (options) => {
		await expect(
			runDesktopSmoke({ appPath: fixture.manifest.appPath, performance: true, ...options }),
		).rejects.toThrow(/performance|no other scenario/);
		expect(prepareDesktopLabFixture).not.toHaveBeenCalled();
		expect(mocks.driver.launch).not.toHaveBeenCalled();
	});
});
