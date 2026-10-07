import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import {
	isolateDesktopProvider,
	readDesktopProviderVersion,
	removeDesktopProviderProfiles,
	resolveDesktopProvider,
} from "./desktop-provider";
import type { DesktopAgentMode, DesktopLabConfig, DesktopLabManifest } from "./desktop-types";
import { buildAgentLabEnvironment } from "./environment";
import { prepareAgentLabFixture } from "./fixture";
import { createAgentLabLaunchConfig } from "./launch-config";
import { AGENT_LAB_REPO_ROOT, writeJsonAtomic } from "./paths";
import { toPublicAgentConfig } from "./public-agent-config";

export async function resolveDesktopAppExecutable(
	appPath: string,
): Promise<{ appPath: string; executablePath: string }> {
	const canonicalAppPath = await realpath(resolve(appPath));
	if (!canonicalAppPath.endsWith(".app")) throw new Error("Desktop Agent Lab requires a packaged macOS .app.");
	const executableDirectory = join(canonicalAppPath, "Contents", "MacOS");
	const executables: string[] = [];
	for (const entry of await readdir(executableDirectory, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(executableDirectory, entry.name);
		try {
			await access(path, constants.X_OK);
			executables.push(path);
		} catch {
			// Ignore bundle metadata and non-executable resources.
		}
	}
	if (executables.length !== 1) throw new Error("Packaged .app must have exactly one main executable.");
	return { appPath: canonicalAppPath, executablePath: executables[0] as string };
}

export interface DesktopLabFixture {
	manifest: DesktopLabManifest;
	manifestPath: string;
	config: DesktopLabConfig;
	configPath: string;
	environment: Record<string, string>;
	forbiddenHostLaunchLogPath: string;
	keepTemp: boolean;
	launchRequest?: DesktopLaunchRequest;
	/** Private installer copies; thaw only after their exact processes have drained. */
	managedInstallationRoots?: string[];
}

export async function prepareDesktopLabFixture(options: {
	appPath: string;
	name?: string;
	repoRoot?: string;
	artifactRoot?: string;
	keepTemp?: boolean;
	showWindow?: boolean;
	agentMode?: DesktopAgentMode;
	sourceEnvironment?: NodeJS.ProcessEnv;
}): Promise<DesktopLabFixture> {
	const app = await resolveDesktopAppExecutable(options.appPath);
	const repoRoot = options.repoRoot ?? AGENT_LAB_REPO_ROOT;
	const source = options.sourceEnvironment ?? process.env;
	let launch = await createAgentLabLaunchConfig({
		name: options.name ?? "desktop",
		repoRoot,
		artifactRoot: options.artifactRoot,
		keepTemp: options.keepTemp,
		agent: resolveDesktopProvider(options.agentMode ?? "fake", source),
	});
	try {
		launch = { ...launch, agent: await isolateDesktopProvider(launch.agent, launch.tempRoot, source) };
		const providerVersion = await readDesktopProviderVersion(launch.agent, source);
		// The desktop owns its helper. Reuse synthetic data and fake-agent launchers,
		// never start the Chromium supervisor or another runtime for this state home.
		const fixture = await prepareAgentLabFixture(launch, "http://127.0.0.1");
		const tempRoot = await realpath(launch.tempRoot);
		const userDataPath = join(tempRoot, "electron-user-data");
		const controlPath = join(tempRoot, "desktop-control");
		await Promise.all([
			mkdir(userDataPath, { recursive: true, mode: 0o700 }),
			mkdir(controlPath, { recursive: true, mode: 0o700 }),
		]);
		const hostSimulationConfigPath = join(tempRoot, "host-simulation-config.json");
		await copyFile(fixture.hostSimulationConfigPath, hostSimulationConfigPath);
		const config: DesktopLabConfig = {
			version: 1,
			tempRoot,
			stateHome: await realpath(fixture.statePath),
			userDataPath,
			projectPath: await realpath(fixture.projectPath),
			hostSimulationConfigPath,
			processEvidencePath: join(controlPath, "processes.json"),
			showWindow: options.showWindow ?? false,
		};
		const configPath = join(tempRoot, "desktop-lab-config.json");
		await writeJsonAtomic(configPath, config);
		await writeJsonAtomic(config.processEvidencePath, {
			version: 1,
			helperPid: null,
			generation: null,
			runtimeOrigin: null,
			phase: "starting",
		});
		const environment = buildAgentLabEnvironment(source, {
			...fixture,
			homePath: await realpath(fixture.homePath),
			statePath: config.stateHome,
			projectPath: config.projectPath,
			additionalProjectPath: await realpath(fixture.additionalProjectPath),
			fakeBinPath: await realpath(fixture.fakeBinPath),
			tempRoot,
			repoRoot,
			tsxCliPath: join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			fakeAgentPath: join(repoRoot, "scripts", "agent-lab", "fake-codex.ts"),
			cliEntrypointPath: join(repoRoot, "src", "cli.ts"),
			runtimePort: 0,
			webPort: 0,
			scenario: "idle",
			agent: launch.agent,
		});
		// The desktop helper selects an auto port before publishing its private
		// bootstrap. A placeholder zero would fail runtime module initialization.
		delete environment.QUARTERDECK_RUNTIME_PORT;
		delete environment.QUARTERDECK_E2E_RUNTIME_PORT;
		delete environment.QUARTERDECK_E2E_WEB_PORT;
		const manifest: DesktopLabManifest = {
			schemaVersion: 1,
			surface: "electron",
			runId: launch.runId,
			status: "starting",
			...app,
			artifactDir: launch.artifactDir,
			tempRoot,
			userDataPath,
			stateHome: config.stateHome,
			projectPath: config.projectPath,
			showWindow: config.showWindow ?? false,
			agent: toPublicAgentConfig(launch.agent),
			providerVersion,
			mainPid: null,
			helperPid: null,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: new Date().toISOString(),
			stoppedAt: null,
			failure: null,
		};
		const manifestPath = join(launch.artifactDir, "desktop-manifest.json");
		await writeJsonAtomic(manifestPath, manifest);
		return {
			manifest,
			manifestPath,
			config,
			configPath,
			environment: Object.fromEntries(
				Object.entries({
					...environment,
					QUARTERDECK_DESKTOP_LAB_CONFIG: configPath,
					QUARTERDECK_TITLE_PROVIDER: "local",
				}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			),
			forbiddenHostLaunchLogPath: fixture.forbiddenHostLaunchLogPath,
			keepTemp: options.keepTemp ?? false,
		};
	} catch (error) {
		await removeDesktopProviderProfiles(launch.tempRoot);
		if (!options.keepTemp) await rm(launch.tempRoot, { recursive: true, force: true });
		throw error;
	}
}
