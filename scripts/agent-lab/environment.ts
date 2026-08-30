import { delimiter, join } from "node:path";

import { resolveAgentLabProviderPolicy } from "./provider-policy";
import { AGENT_LAB_REAL_CLAUDE_GATEWAY_ENVIRONMENT_KEYS } from "./real-claude";
import type { AgentLabLaunchAgentConfig } from "./types";

interface AgentLabEnvironmentPaths {
	tempRoot: string;
	homePath: string;
	statePath: string;
	projectPath: string;
	additionalProjectPath: string;
	fakeBinPath: string;
	forbiddenHostLaunchLogPath: string;
	repoRoot: string;
	tsxCliPath: string;
	fakeAgentPath: string;
	cliEntrypointPath: string;
	runtimePort: number;
	webPort: number;
	scenario: string;
	agent: AgentLabLaunchAgentConfig;
}

const FORWARDED_ENVIRONMENT_KEYS = [
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"SHELL",
	"SystemRoot",
	"ComSpec",
	"PATHEXT",
	"CODEX_CA_CERTIFICATE",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
] as const;

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
	const providerPolicy = resolveAgentLabProviderPolicy(paths.agent);
	const realProviderEnvironment: NodeJS.ProcessEnv = (() => {
		switch (paths.agent.mode) {
			case "real-codex":
				return {
					QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH: sourcePath,
					QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME: paths.agent.codexHomePath,
					QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL: paths.agent.model,
					QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX: paths.agent.sandbox,
					QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: paths.agent.approvalPolicy,
					QUARTERDECK_TITLE_PROVIDER: "local",
				};
			case "real-claude":
				if (!paths.agent.mcpConfigPath) {
					throw new Error("Agent Lab real Claude is missing its isolated MCP configuration.");
				}
				return {
					...(paths.agent.authentication === "environment"
						? Object.fromEntries(
								AGENT_LAB_REAL_CLAUDE_GATEWAY_ENVIRONMENT_KEYS.flatMap((key) =>
									source[key] ? [[key, source[key]]] : [],
								),
							)
						: {}),
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH: sourcePath,
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR: paths.agent.claudeConfigDirPath,
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG: paths.agent.mcpConfigPath,
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL: paths.agent.model,
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE: paths.agent.permissionMode,
					QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH:
						paths.agent.authentication === "environment" ? "1" : "0",
					QUARTERDECK_TITLE_PROVIDER: "local",
				};
			case "fake":
			case "fake-claude":
				return {};
			default: {
				const unsupportedAgent: never = paths.agent;
				throw new Error(`Unsupported Agent Lab provider mode: ${String(unsupportedAgent)}`);
			}
		}
	})();

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
		QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS: providerPolicy.enabledAgentIds.join(","),
		VITE_QUARTERDECK_AGENT_LAB: "1",
		QUARTERDECK_AGENT_LAB_PROJECT: paths.projectPath,
		QUARTERDECK_AGENT_LAB_ADDITIONAL_PROJECT: paths.additionalProjectPath,
		QUARTERDECK_AGENT_LAB_FORBIDDEN_HOST_LAUNCH_LOG: paths.forbiddenHostLaunchLogPath,
		QUARTERDECK_AGENT_LAB_REPO_ROOT: paths.repoRoot,
		QUARTERDECK_AGENT_LAB_NODE: process.execPath,
		QUARTERDECK_AGENT_LAB_TSX_CLI: paths.tsxCliPath,
		QUARTERDECK_AGENT_LAB_FAKE_AGENT: paths.fakeAgentPath,
		QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: paths.cliEntrypointPath,
		QUARTERDECK_AGENT_LAB_SCENARIO: paths.scenario,
		...realProviderEnvironment,
	};
}

export function buildSupervisorEnvironment(
	source: NodeJS.ProcessEnv,
	tempRoot: string,
	agent: AgentLabLaunchAgentConfig,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of [...FORWARDED_ENVIRONMENT_KEYS, "PATH"] as const) {
		const value = source[key];
		if (value) {
			environment[key] = value;
		}
	}
	if (agent.mode === "real-claude" && agent.authentication === "environment") {
		for (const key of AGENT_LAB_REAL_CLAUDE_GATEWAY_ENVIRONMENT_KEYS) {
			const value = source[key];
			if (value) environment[key] = value;
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
