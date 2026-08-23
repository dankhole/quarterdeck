import { delimiter, join } from "node:path";

interface AgentLabEnvironmentPaths {
	tempRoot: string;
	homePath: string;
	statePath: string;
	projectPath: string;
	fakeBinPath: string;
	repoRoot: string;
	tsxCliPath: string;
	fakeCodexPath: string;
	cliEntrypointPath: string;
	runtimePort: number;
	webPort: number;
	scenario: string;
}

const FORWARDED_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "SHELL", "SystemRoot", "ComSpec", "PATHEXT"] as const;

export function buildAgentLabEnvironment(
	source: NodeJS.ProcessEnv,
	paths: AgentLabEnvironmentPaths,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of FORWARDED_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value) {
			environment[key] = value;
		}
	}

	const sourcePath = source.PATH ?? source.Path ?? "";
	const pathValue = [paths.fakeBinPath, sourcePath].filter(Boolean).join(delimiter);
	const emptyGitConfigPath = join(paths.tempRoot, "empty-gitconfig");

	return {
		...environment,
		PATH: pathValue,
		Path: process.platform === "win32" ? pathValue : undefined,
		HOME: paths.homePath,
		USERPROFILE: paths.homePath,
		XDG_CACHE_HOME: join(paths.homePath, ".cache"),
		XDG_CONFIG_HOME: join(paths.homePath, ".config"),
		XDG_DATA_HOME: join(paths.homePath, ".local", "share"),
		TMPDIR: paths.tempRoot,
		TEMP: paths.tempRoot,
		TMP: paths.tempRoot,
		TERM: "xterm-256color",
		NO_COLOR: "1",
		NODE_ENV: "development",
		GIT_CONFIG_GLOBAL: emptyGitConfigPath,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		QUARTERDECK_STATE_HOME: paths.statePath,
		QUARTERDECK_RUNTIME_PORT: String(paths.runtimePort),
		QUARTERDECK_E2E_RUNTIME_PORT: String(paths.runtimePort),
		QUARTERDECK_E2E_WEB_PORT: String(paths.webPort),
		QUARTERDECK_DEBUG_MODE: "true",
		QUARTERDECK_AGENT_LAB: "1",
		VITE_QUARTERDECK_AGENT_LAB: "1",
		QUARTERDECK_AGENT_LAB_PROJECT: paths.projectPath,
		QUARTERDECK_AGENT_LAB_REPO_ROOT: paths.repoRoot,
		QUARTERDECK_AGENT_LAB_NODE: process.execPath,
		QUARTERDECK_AGENT_LAB_TSX_CLI: paths.tsxCliPath,
		QUARTERDECK_AGENT_LAB_FAKE_CODEX: paths.fakeCodexPath,
		QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: paths.cliEntrypointPath,
		QUARTERDECK_AGENT_LAB_SCENARIO: paths.scenario,
	};
}

export function buildSupervisorEnvironment(source: NodeJS.ProcessEnv, tempRoot: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of [...FORWARDED_ENVIRONMENT_KEYS, "PATH"] as const) {
		const value = source[key];
		if (value) {
			environment[key] = value;
		}
	}
	return {
		...environment,
		TMPDIR: tempRoot,
		TEMP: tempRoot,
		TMP: tempRoot,
		NO_COLOR: "1",
	};
}
