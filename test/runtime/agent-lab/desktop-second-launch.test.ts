import { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import {
	type DesktopSecondLaunchOptions,
	proveDesktopSecondLaunch,
} from "../../../scripts/agent-lab/desktop-second-launch";
import type { DesktopLabProcess, DesktopProcessEvidence } from "../../../scripts/agent-lab/desktop-types";
import {
	DESKTOP_LAUNCH_ARGUMENT,
	type DesktopLaunchRequest,
	serializeDesktopLaunchRequest,
} from "../../../src/shared/desktop-launch-contract";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<DesktopLabFixture> {
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-second-launch-")));
	roots.push(tempRoot);
	const config = {
		version: 1 as const,
		tempRoot,
		stateHome: join(tempRoot, "state"),
		userDataPath: join(tempRoot, "user data"),
		projectPath: join(tempRoot, "project"),
		hostSimulationConfigPath: join(tempRoot, "host.json"),
		processEvidencePath: join(tempRoot, "evidence.json"),
		showWindow: false,
	};
	await Promise.all([config.stateHome, config.userDataPath, config.projectPath].map((path) => mkdir(path)));
	await writeFile(config.hostSimulationConfigPath, "{}");
	const configPath = join(tempRoot, "config.json");
	await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
	const appPath = join(tempRoot, "Quarterdeck Ω.app");
	return {
		config,
		configPath,
		environment: { QUARTERDECK_DESKTOP_LAB_CONFIG: configPath, QUARTERDECK_STATE_HOME: config.stateHome },
		manifestPath: join(tempRoot, "manifest.json"),
		forbiddenHostLaunchLogPath: join(tempRoot, "forbidden.log"),
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "second-launch-test",
			status: "ready",
			appPath,
			executablePath: `${appPath}/Contents/MacOS/Quarterdeck`,
			artifactDir: tempRoot,
			tempRoot,
			stateHome: config.stateHome,
			userDataPath: config.userDataPath,
			projectPath: config.projectPath,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: 100,
			helperPid: 101,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
}

function scenario(input: DesktopLabFixture, behavior: "success" | "no-ack" | "running" = "success") {
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: 200 });
	let launched = false;
	let alive = false;
	let notificationCount = 0;
	const originals: DesktopLabProcess[] = [
		{
			pid: 100,
			parentPid: 1,
			startedAt: "original-app-birth",
			command: `${input.manifest.executablePath} --user-data-dir=${input.config.userDataPath}`,
		},
		{
			pid: 101,
			parentPid: 100,
			startedAt: "original-helper-birth",
			command: `${input.manifest.appPath}/Contents/Resources/runtime/bin/node runtime/dist/cli.js ${input.config.hostSimulationConfigPath}`,
		},
	];
	const second: DesktopLabProcess = {
		pid: 200,
		parentPid: process.pid,
		startedAt: "second-birth",
		command: `${input.manifest.executablePath} --use-mock-keychain --user-data-dir=${input.config.userDataPath}`,
	};
	const evidence: DesktopProcessEvidence = {
		version: 1,
		appPid: 100,
		helperPid: 101,
		generation: "original-generation",
		runtimeOrigin: "http://127.0.0.1:3501",
		phase: "ready",
	};
	const kill = vi.fn(() => {
		alive = false;
		child.emit("exit", null, "SIGTERM");
		return true;
	});
	child.kill = kill;
	const options = {
		timeoutMs: 100,
		cleanupTimeoutMs: 30,
		pollIntervalMs: 1,
		readEvidence: async () => ({ ...evidence }),
		readSecondInstanceCount: async () => notificationCount,
		listProcesses: async () => [...originals, ...(alive ? [second] : [])],
		spawnProcess: vi.fn(() => {
			launched = true;
			alive = true;
			if (behavior !== "running")
				setTimeout(() => {
					alive = false;
					if (behavior === "success") notificationCount += 1;
					child.emit("exit", 0, null);
				}, 5);
			return child;
		}),
	} satisfies DesktopSecondLaunchOptions;
	return { child, originals, second, evidence, options, kill, launched: () => launched, alive: () => alive };
}

describe("isolated packaged desktop second launch", () => {
	function request(input: DesktopLabFixture): DesktopLaunchRequest {
		return {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			appPath: input.manifest.appPath,
			buildId: "synthetic-build",
			appAsarSha256: "a".repeat(64),
			stateHome: input.config.stateHome,
			projectPath: input.config.projectPath,
		};
	}

	it("passes the bounded typed npm request through the real second-launch argument boundary", async () => {
		const input = await fixture();
		const test = scenario(input);
		const launchRequest = request(input);
		await proveDesktopSecondLaunch(input, { ...test.options, launchRequest });
		expect(test.options.spawnProcess).toHaveBeenCalledWith(
			input.manifest.executablePath,
			[
				"--use-mock-keychain",
				`--user-data-dir=${input.config.userDataPath}`,
				DESKTOP_LAUNCH_ARGUMENT,
				serializeDesktopLaunchRequest(launchRequest),
			],
			expect.objectContaining({ env: input.environment, shell: false }),
		);
	});

	it("rechecks driver admission after awaited reads and refuses a post-stop spawn", async () => {
		const input = await fixture();
		const test = scenario(input);
		let active = true;
		await expect(
			proveDesktopSecondLaunch(input, {
				...test.options,
				readSecondInstanceCount: async () => {
					active = false;
					return 0;
				},
				assertLaunchAllowed: () => {
					if (!active) throw new Error("Driver stopped before secondary spawn.");
				},
			}),
		).rejects.toMatchObject({ secondPid: null, cleanupConfirmed: true });
		expect(test.options.spawnProcess).not.toHaveBeenCalled();
	});

	it("uses a private alternate packaged installation without changing original process evidence", async () => {
		const input = await fixture();
		const test = scenario(input);
		const appPath = join(input.config.tempRoot, "npm-managed-alternate", "Quarterdeck.app");
		const selectedApplication = { appPath, executablePath: `${appPath}/Contents/MacOS/Quarterdeck` };
		const proof = await proveDesktopSecondLaunch(input, {
			...test.options,
			selectedApplication,
			launchRequest: { ...request(input), appPath },
		});
		expect(test.options.spawnProcess).toHaveBeenCalledWith(
			selectedApplication.executablePath,
			expect.any(Array),
			expect.objectContaining({ shell: false }),
		);
		expect(proof.original).toMatchObject({ appPid: 100, helperPid: 101, generation: "original-generation" });
		expect(test.kill).not.toHaveBeenCalled();
	});

	it.each(["state", "project", "alternate"])("rejects an escaped npm %s before spawning", async (target) => {
		const input = await fixture();
		const test = scenario(input);
		const launchRequest = request(input);
		if (target === "state") launchRequest.stateHome = "/private/tmp/another-state";
		if (target === "project") launchRequest.projectPath = "/Users/synthetic/outside";
		const selectedApplication =
			target === "alternate"
				? {
						appPath: "/Applications/Quarterdeck.app",
						executablePath: "/Applications/Quarterdeck.app/Contents/MacOS/Quarterdeck",
					}
				: undefined;
		await expect(
			proveDesktopSecondLaunch(input, { ...test.options, launchRequest, selectedApplication }),
		).rejects.toThrow("isolated fixture");
		expect(test.options.spawnProcess).not.toHaveBeenCalled();
	});

	it("uses the same hidden fixture, proves the notification path and leaves original identities unchanged", async () => {
		const input = await fixture();
		const test = scenario(input);
		const proof = await proveDesktopSecondLaunch(input, test.options);
		expect(proof).toEqual({
			secondPid: 200,
			exitCode: 0,
			original: {
				appPid: 100,
				appBirth: "original-app-birth",
				helperPid: 101,
				helperBirth: "original-helper-birth",
				generation: "original-generation",
			},
			notificationCountBefore: 0,
			notificationCountAfter: 1,
		});
		expect(test.options.spawnProcess).toHaveBeenCalledWith(
			input.manifest.executablePath,
			["--use-mock-keychain", `--user-data-dir=${input.config.userDataPath}`],
			expect.objectContaining({
				cwd: input.config.projectPath,
				env: input.environment,
				shell: false,
				detached: false,
				stdio: "ignore",
			}),
		);
		expect(test.kill).not.toHaveBeenCalled();
	});

	it("refuses to treat an early zero exit as proof of single-instance routing", async () => {
		const input = await fixture();
		const test = scenario(input, "no-ack");
		await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toMatchObject({
			code: "DesktopSecondLaunchFailed",
			secondPid: 200,
			cleanupConfirmed: true,
		});
		expect(test.kill).not.toHaveBeenCalled();
	});

	it.each(["helperBirth", "generation", "appPid"] as const)(
		"rejects changed original %s evidence and cleans only its exact second child",
		async (change) => {
			const input = await fixture();
			const test = scenario(input, "running");
			const list = test.options.listProcesses;
			test.options.listProcesses = async () => {
				if (test.launched()) {
					if (change === "helperBirth" && test.originals[1])
						test.originals[1] = { ...test.originals[1], startedAt: "reused-helper-pid" };
					if (change === "generation") test.evidence.generation = "replacement";
					if (change === "appPid") test.evidence.appPid = 200;
				}
				return await list();
			};
			await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toMatchObject({
				cleanupConfirmed: true,
				secondProcesses: [expect.objectContaining({ pid: 200, startedAt: "second-birth" })],
			});
			expect(test.kill).toHaveBeenCalledOnce();
		},
	);

	it("rejects a duplicate helper and reports its retained identity without signalling it or the original", async () => {
		const input = await fixture();
		const test = scenario(input, "running");
		const list = test.options.listProcesses;
		test.options.listProcesses = async () => [
			...(await list()),
			...(test.launched()
				? [
						{
							pid: 201,
							parentPid: 200,
							startedAt: "duplicate-helper-birth",
							command: `${input.manifest.appPath}/Contents/Resources/runtime/bin/node runtime/dist/cli.js ${input.config.hostSimulationConfigPath}`,
						},
					]
				: []),
		];
		await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toMatchObject({
			cleanupConfirmed: false,
			secondProcesses: expect.arrayContaining([
				expect.objectContaining({ pid: 201, startedAt: "duplicate-helper-birth" }),
			]),
		});
		expect(test.kill).toHaveBeenCalledOnce();
	});

	it("never signals a recycled second PID with a different birth", async () => {
		const input = await fixture();
		const test = scenario(input, "running");
		const list = test.options.listProcesses;
		let snapshots = 0;
		test.options.listProcesses = async () => {
			const rows = await list();
			if (test.launched() && ++snapshots > 1)
				return rows.map((item) =>
					item.pid === 200 ? { ...item, startedAt: "unrelated-reused-pid", parentPid: 1 } : item,
				);
			return rows;
		};
		await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toMatchObject({ cleanupConfirmed: false });
		expect(test.kill).not.toHaveBeenCalled();
	});

	it("bounds unavailable process inspection and retains unconfirmed cleanup", async () => {
		const input = await fixture();
		const test = scenario(input, "running");
		const list = test.options.listProcesses;
		test.options.timeoutMs = 10;
		test.options.cleanupTimeoutMs = 5;
		test.options.listProcesses = async () =>
			test.launched() ? await new Promise<DesktopLabProcess[]>(() => {}) : await list();
		await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toMatchObject({ cleanupConfirmed: false });
		expect(test.kill).not.toHaveBeenCalled();
	});

	it.each(["visible", "different-env", "not-ready"])(
		"refuses unsafe %s preconditions before spawning",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			if (kind === "visible") input.config.showWindow = true;
			if (kind === "different-env")
				input.environment.QUARTERDECK_DESKTOP_LAB_CONFIG = join(input.config.tempRoot, "other.json");
			if (kind === "not-ready") test.evidence.phase = "starting";
			await expect(proveDesktopSecondLaunch(input, test.options)).rejects.toThrow();
			expect(test.options.spawnProcess).not.toHaveBeenCalled();
		},
	);
});
