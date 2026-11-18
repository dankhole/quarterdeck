import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { buildAgentLabEnvironment, buildSupervisorEnvironment } from "../../scripts/agent-lab/environment";
import {
	buildClaudeHookPayload,
	extractPromptArgument,
	getFakeAgentVersionOutput,
	parseFakeAgentCommand,
	resolveFakeAgentInvocation,
	resolveFakeAgentScenario,
	shouldFakeAgentUseFullscreen,
} from "../../scripts/agent-lab/fake-agent-protocol";
import {
	writeAgentProviderLaunchers,
	writeRealClaudeLauncher,
	writeRealCodexLauncher,
} from "../../scripts/agent-lab/fixture";
import { createAgentLabLaunchConfig, persistAgentLabLaunchConfig } from "../../scripts/agent-lab/launch-config";
import { assertSafeRunId, createAgentLabRunId } from "../../scripts/agent-lab/paths";
import { toPublicAgentConfig } from "../../scripts/agent-lab/public-agent-config";
import {
	AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY,
	buildRealClaudePreflightEnvironment,
	prepareIsolatedRealClaudeAgent,
	resolveRealClaudeAgent,
} from "../../scripts/agent-lab/real-claude";
import {
	AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES,
	buildRealCodexPreflightEnvironment,
	getAgentLabRealCodexConfigOverrides,
	prepareIsolatedRealCodexAgent,
	resolveRealCodexAgent,
} from "../../scripts/agent-lab/real-codex";
import { AgentLabManifestSchema } from "../../scripts/agent-lab/types";
import {
	detectInstalledCommands,
	getAgentAvailability,
	resetAgentAvailabilityCache,
} from "../../src/config/agent-registry";
import { isBinaryAvailableOnPath, mergeProcessEnvironment, resolveWindowsPowerShellPath } from "../../src/core";
import { prepareAgentLaunch } from "../../src/terminal/agent-session-adapters";

const execFileAsync = promisify(execFile);

describe("agent-lab environment", () => {
	it("preserves Windows system variables from a copied mixed-case supervisor environment", () => {
		const originalPlatform = process.platform;
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			const environment = buildSupervisorEnvironment(
				{
					Path: "C:\\Windows\\System32",
					SYSTEMROOT: "C:\\Windows",
					windir: "C:\\Windows",
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					Pathext: ".COM;.EXE;.BAT;.CMD",
					TEMP: "C:\\Users\\host\\Temp",
					OPENAI_API_KEY: "must-not-leak",
					QUARTERDECK_STATE_HOME: "C:\\Users\\host\\state",
				},
				"C:\\synthetic\\lab",
				{ mode: "fake" },
			);
			expect(environment).toEqual({
				PATH: "C:\\Windows\\System32",
				SystemRoot: "C:\\Windows",
				WINDIR: "C:\\Windows",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				PATHEXT: ".COM;.EXE;.BAT;.CMD",
				TMPDIR: "C:\\synthetic\\lab",
				TEMP: "C:\\synthetic\\lab",
				TMP: "C:\\synthetic\\lab",
				NO_COLOR: "1",
			});
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});

	it("forwards only the small host allowlist and injects isolated paths", () => {
		const environment = buildAgentLabEnvironment(
			{
				PATH: "/host/bin",
				LANG: "en_US.UTF-8",
				OPENAI_API_KEY: "must-not-leak",
				AWS_SECRET_ACCESS_KEY: "must-not-leak",
			},
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeAgentPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
				agent: { mode: "fake" },
			},
		);

		expect(environment.OPENAI_API_KEY).toBeUndefined();
		expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(environment.HOME).toBe("/tmp/lab/home");
		expect(environment.APPDATA).toBe(join("/tmp/lab/home", "AppData", "Roaming"));
		expect(environment.LOCALAPPDATA).toBe(join("/tmp/lab/home", "AppData", "Local"));
		expect(environment.QUARTERDECK_STATE_HOME).toBe("/tmp/lab/state");
		expect(environment.QUARTERDECK_RUNTIME_PORT).toBe("35001");
		expect(environment.QUARTERDECK_AGENT_LAB_ADDITIONAL_PROJECT).toBe("/tmp/lab/project-secondary");
		expect(environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe("codex,pi");
		expect(environment.PATH).toBe(["/tmp/lab/bin", "/host/bin"].join(delimiter));
		expect(Object.keys(environment).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
	});

	it("exposes real profile paths only through wrapper-specific variables", () => {
		const codexHomePath = resolve("/account/home/.codex");
		const agent = resolveRealCodexAgent(
			{
				model: "gpt-5.6-luna",
				codexHomePath,
			},
			{ PATH: "/host/bin", OPENAI_API_KEY: "must-not-leak" },
		);
		const environment = buildAgentLabEnvironment(
			{ PATH: "/host/bin", OPENAI_API_KEY: "must-not-leak" },
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeAgentPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
				agent,
			},
		);

		expect(environment.HOME).toBe("/tmp/lab/home");
		expect(environment.CODEX_HOME).toBeUndefined();
		expect(environment.OPENAI_API_KEY).toBeUndefined();
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME).toBe(codexHomePath);
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_ACCOUNT_HOME).toBeUndefined();
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL).toBe("gpt-5.6-luna");
		expect(environment.QUARTERDECK_TITLE_PROVIDER).toBe("local");
		expect(environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe("codex");
	});

	it("selects only Claude in the deterministic fake-Claude lane", () => {
		const environment = buildAgentLabEnvironment(
			{ PATH: "/host/bin" },
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeAgentPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "claude-lifecycle",
				agent: { mode: "fake-claude" },
			},
		);

		expect(environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe("claude");
		expect(environment.QUARTERDECK_AGENT_LAB_FAKE_AGENT).toBe("/repo/scripts/fake-codex.ts");
	});

	it("exposes only isolated wrapper inputs in real-Claude mode", () => {
		const agent = {
			...resolveRealClaudeAgent({ claudeConfigDirPath: "/tmp/lab/claude-config" }, {}),
			mcpConfigPath: "/tmp/lab/claude-config/agent-lab-empty-mcp.json",
		} as const;
		const environment = buildAgentLabEnvironment(
			{
				PATH: "/host/bin",
				ANTHROPIC_API_KEY: "must-not-leak",
				CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
			},
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeAgentPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
				agent,
			},
		);

		expect(environment.HOME).toBe("/tmp/lab/home");
		expect(environment.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
		expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR).toBe(resolve("/tmp/lab/claude-config"));
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG).toBe(
			resolve("/tmp/lab/claude-config/agent-lab-empty-mcp.json"),
		);
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL).toBe("haiku");
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE).toBe("manual");
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH).toBe("0");
		expect(environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe("claude");
	});

	it("forwards only documented Claude gateway variables when explicitly selected", () => {
		const agent = {
			...resolveRealClaudeAgent(
				{ claudeConfigDirPath: "/tmp/lab/claude-config", environmentAuthentication: true },
				{},
			),
			mcpConfigPath: "/tmp/lab/claude-config/agent-lab-empty-mcp.json",
		} as const;
		const environment = buildAgentLabEnvironment(
			{
				PATH: "/host/bin",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token",
				ANTHROPIC_BEDROCK_BASE_URL: "https://gateway.example.invalid",
				CLAUDE_CODE_USE_BEDROCK: "1",
				CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
				QUARTERDECK_LLM_API_KEY: "must-not-leak",
			},
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeAgentPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
				agent,
			},
		);

		expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("synthetic-token");
		expect(environment.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://gateway.example.invalid");
		expect(environment.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(environment.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBe("1");
		expect(environment.QUARTERDECK_LLM_API_KEY).toBeUndefined();
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH).toBe("1");
	});

	it("carries explicit Claude gateway authentication through the isolated supervisor", () => {
		const environmentAgent = resolveRealClaudeAgent({ environmentAuthentication: true }, {});
		const environment = buildSupervisorEnvironment(
			{
				PATH: "/host/bin",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token",
				ANTHROPIC_BEDROCK_BASE_URL: "https://gateway.example.invalid",
				CLAUDE_CODE_USE_BEDROCK: "1",
				AWS_ACCESS_KEY_ID: "synthetic-access-key",
				AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
				AWS_SESSION_TOKEN: "synthetic-session-token",
				AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token",
				NODE_EXTRA_CA_CERTS: "/synthetic/custom-ca.pem",
				QUARTERDECK_LLM_API_KEY: "must-not-leak",
			},
			"/tmp/lab",
			environmentAgent,
		);
		expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("synthetic-token");
		expect(environment.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://gateway.example.invalid");
		expect(environment.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(environment.AWS_ACCESS_KEY_ID).toBe("synthetic-access-key");
		expect(environment.AWS_SECRET_ACCESS_KEY).toBe("synthetic-secret-key");
		expect(environment.AWS_SESSION_TOKEN).toBe("synthetic-session-token");
		expect(environment.AWS_BEARER_TOKEN_BEDROCK).toBe("synthetic-bedrock-token");
		expect(environment.NODE_EXTRA_CA_CERTS).toBe("/synthetic/custom-ca.pem");
		expect(environment.QUARTERDECK_LLM_API_KEY).toBeUndefined();

		const defaultEnvironment = buildSupervisorEnvironment(
			{ PATH: "/host/bin", ANTHROPIC_AUTH_TOKEN: "must-not-leak" },
			"/tmp/lab",
			resolveRealClaudeAgent({}, {}),
		);
		expect(defaultEnvironment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});
});

describe("agent-lab provider isolation", () => {
	it.runIf(process.platform !== "win32")(
		"shadows a host Claude installation in fake mode before discovery can launch it",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-provider-isolation-"));
			const fakeBinPath = join(root, "lab-bin");
			const hostBinPath = join(root, "host-bin");
			const hostLaunchSentinelPath = join(root, "host-claude-launched");
			const previousPath = process.env.PATH;
			const previousSentinelPath = process.env.HOST_PROVIDER_SENTINEL;
			const previousAgentLab = process.env.QUARTERDECK_AGENT_LAB;
			const previousAllowedAgentIds = process.env.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS;
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "claude"),
					'#!/bin/sh\nprintf "launched\\n" >> "$HOST_PROVIDER_SENTINEL"\nprintf "2.1.999\\n"\n',
					{ encoding: "utf8", mode: 0o755 },
				);
				expect(isBinaryAvailableOnPath("claude", { env: { PATH: hostBinPath } })).toBe(true);
				await writeAgentProviderLaunchers(fakeBinPath, { mode: "fake" });

				process.env.PATH = [fakeBinPath, hostBinPath].join(delimiter);
				process.env.HOST_PROVIDER_SENTINEL = hostLaunchSentinelPath;
				process.env.QUARTERDECK_AGENT_LAB = "1";
				process.env.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS = "codex,pi";
				resetAgentAvailabilityCache();

				expect(isBinaryAvailableOnPath("claude")).toBe(true);
				expect(detectInstalledCommands()).not.toContain("claude");
				await expect(getAgentAvailability("claude", { forceRefresh: true })).resolves.toMatchObject({
					installed: false,
					reason: "missing",
				});
				await expect(execFileAsync("claude", ["--version"], { env: process.env })).rejects.toMatchObject({
					code: 127,
				});
				await expect(readFile(hostLaunchSentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				resetAgentAvailabilityCache();
				if (previousPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = previousPath;
				}
				if (previousSentinelPath === undefined) {
					delete process.env.HOST_PROVIDER_SENTINEL;
				} else {
					process.env.HOST_PROVIDER_SENTINEL = previousSentinelPath;
				}
				if (previousAgentLab === undefined) {
					delete process.env.QUARTERDECK_AGENT_LAB;
				} else {
					process.env.QUARTERDECK_AGENT_LAB = previousAgentLab;
				}
				if (previousAllowedAgentIds === undefined) {
					delete process.env.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS;
				} else {
					process.env.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS = previousAllowedAgentIds;
				}
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("exposes only Codex in real-Codex mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-provider-policy-"));
		try {
			const agent = resolveRealCodexAgent({ codexHomePath: "/profiles/codex" }, {});
			await writeAgentProviderLaunchers(root, agent);

			expect(await readFile(join(root, "codex"), "utf8")).toContain("REAL_CODEX_HOST_PATH");
			expect(await readFile(join(root, "claude"), "utf8")).toContain("does not enable claude in this provider mode");
			expect(await readFile(join(root, "pi"), "utf8")).toContain("does not enable pi in this provider mode");
			expect(await readFile(join(root, "claude.cmd"), "utf8")).toContain("exit /b 127");
			expect(await readFile(join(root, "pi.cmd"), "utf8")).toContain("exit /b 127");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("exposes only the fake Claude launcher in fake-Claude mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-fake-claude-policy-"));
		try {
			await writeAgentProviderLaunchers(root, { mode: "fake-claude" });

			expect(await readFile(join(root, "claude"), "utf8")).toContain("QUARTERDECK_AGENT_LAB_PROVIDER=claude");
			expect(await readFile(join(root, "claude"), "utf8")).toContain("QUARTERDECK_AGENT_LAB_FAKE_AGENT");
			expect(await readFile(join(root, "codex"), "utf8")).toContain("does not enable codex in this provider mode");
			expect(await readFile(join(root, "pi"), "utf8")).toContain("does not enable pi in this provider mode");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("exposes only Claude in real-Claude mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-policy-"));
		try {
			const agent = resolveRealClaudeAgent({ claudeConfigDirPath: "/profiles/claude" }, {});
			await writeAgentProviderLaunchers(root, agent);

			expect(await readFile(join(root, "claude"), "utf8")).toContain("REAL_CLAUDE_HOST_PATH");
			expect(await readFile(join(root, "codex"), "utf8")).toContain("does not enable codex in this provider mode");
			expect(await readFile(join(root, "pi"), "utf8")).toContain("does not enable pi in this provider mode");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("agent-lab real Claude", () => {
	it("resolves cheap defaults without exposing the selected config path", () => {
		const agent = resolveRealClaudeAgent({}, { CLAUDE_CONFIG_DIR: "/profiles/claude", PATH: "/host/bin" });
		expect(agent).toMatchObject({
			mode: "real-claude",
			model: "haiku",
			modelProvider: "anthropic",
			profileSource: "environment",
			claudeConfigDirPath: resolve("/profiles/claude"),
			permissionMode: "manual",
			mcpConfigPath: null,
		});
		expect(toPublicAgentConfig(agent)).toEqual({
			mode: "real-claude",
			model: "haiku",
			modelProvider: "anthropic",
			authentication: "existing-cli",
			profileSource: "environment",
			credentialBoundary: "host-store-reused",
			permissionMode: "manual",
			settingsSources: "none",
			managedSettings: "inherited",
			historyPersistence: "disposable",
			externalIntegrations: "unmanaged-disabled",
			profileHooks: "isolated",
			telemetry: "disabled",
			budgetLimit: "model-and-prompt-only",
		});
	});

	it("preflights CLI authentication without forwarding API credentials", () => {
		const agent = resolveRealClaudeAgent({ claudeConfigDirPath: "/profiles/claude" }, {});
		const environment = buildRealClaudePreflightEnvironment(
			{
				PATH: "/host/bin",
				HOME: "/account/home",
				USERPROFILE: "/account/home",
				LANG: "en_US.UTF-8",
				ANTHROPIC_API_KEY: "must-not-leak",
				ANTHROPIC_AUTH_TOKEN: "must-not-leak",
				CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
			},
			agent,
		);
		expect(environment).toMatchObject({
			PATH: "/host/bin",
			HOME: "/account/home",
			USERPROFILE: "/account/home",
			LANG: "en_US.UTF-8",
			CLAUDE_CONFIG_DIR: resolve("/profiles/claude"),
			...AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY,
		});
		expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
		expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it("records and preflights explicitly selected gateway authentication without exposing values publicly", () => {
		const agent = resolveRealClaudeAgent(
			{ claudeConfigDirPath: "/profiles/claude", environmentAuthentication: true },
			{},
		);
		expect(toPublicAgentConfig(agent)).toMatchObject({
			authentication: "environment",
			credentialBoundary: "provider-environment-forwarded",
		});
		const environment = buildRealClaudePreflightEnvironment(
			{
				PATH: "/host/bin",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token",
				ANTHROPIC_BEDROCK_BASE_URL: "https://gateway.example.invalid",
				CLAUDE_CODE_USE_BEDROCK: "1",
				AWS_ACCESS_KEY_ID: "synthetic-access-key",
				AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
				AWS_SESSION_TOKEN: "synthetic-session-token",
				AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token",
				QUARTERDECK_LLM_API_KEY: "must-not-leak",
			},
			agent,
		);
		expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("synthetic-token");
		expect(environment.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://gateway.example.invalid");
		expect(environment.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(environment.AWS_ACCESS_KEY_ID).toBe("synthetic-access-key");
		expect(environment.AWS_SECRET_ACCESS_KEY).toBe("synthetic-secret-key");
		expect(environment.AWS_SESSION_TOKEN).toBe("synthetic-session-token");
		expect(environment.AWS_BEARER_TOKEN_BEDROCK).toBe("synthetic-bedrock-token");
		expect(environment.QUARTERDECK_LLM_API_KEY).toBeUndefined();
	});

	it("stages only a file credential and empty MCP config into the disposable profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-config-"));
		const sourceConfigPath = join(root, "source-config");
		await mkdir(sourceConfigPath, { recursive: true });
		await writeFile(join(sourceConfigPath, ".credentials.json"), "synthetic credential\n", { mode: 0o600 });
		const sourceAgent = resolveRealClaudeAgent({ claudeConfigDirPath: sourceConfigPath }, {});
		const validateAuthentication = vi.fn(async () => {});
		try {
			const isolatedAgent = await prepareIsolatedRealClaudeAgent(
				sourceAgent,
				join(root, "temp"),
				{},
				{
					platform: "win32",
					validateAuthentication,
				},
			);
			expect(isolatedAgent.claudeConfigDirPath).toBe(join(root, "temp", "claude-config"));
			expect(await readFile(join(isolatedAgent.claudeConfigDirPath, ".credentials.json"), "utf8")).toBe(
				"synthetic credential\n",
			);
			expect(await readFile(isolatedAgent.mcpConfigPath ?? "", "utf8")).toBe('{"mcpServers":{}}\n');
			expect(await readFile(join(isolatedAgent.claudeConfigDirPath, ".claude.json"), "utf8")).toBe(
				'{"hasCompletedOnboarding":true}\n',
			);
			expect(validateAuthentication).toHaveBeenCalledWith(isolatedAgent, {});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes a Windows launcher that clears wrapper paths before Claude starts", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-windows-"));
		try {
			await writeRealClaudeLauncher(root);
			const launcher = await readFile(join(root, "claude.cmd"), "utf8");
			expect(launcher).toContain('set "CLAUDE_CONFIG_DIR=%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR%"');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG="');
			expect(launcher).toContain('set "ANTHROPIC_API_KEY="');
			expect(launcher).toContain('--model "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL%"');
			expect(launcher).toContain('--permission-mode "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE%"');
			expect(launcher).toContain('--setting-sources "" --strict-mcp-config');
			expect(launcher).toContain("--no-chrome --disable-slash-commands");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")(
		"executes the host Claude with the isolated config and bounded launch policy",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-launcher-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			const capturePath = join(root, "capture.txt");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "claude"),
					`#!/bin/sh\nprintf "%s\\n" "$HOME" "$CLAUDE_CONFIG_DIR" "\${ANTHROPIC_API_KEY-unset}" "$DISABLE_TELEMETRY" "$@" > "$CAPTURE_PATH"\n`,
					{ encoding: "utf8", mode: 0o755 },
				);
				await writeRealClaudeLauncher(fakeBinPath);
				await execFileAsync(
					join(fakeBinPath, "claude"),
					["--resume", "session-123", "--settings", "/tmp/hooks.json", "--", "synthetic prompt"],
					{
						env: {
							HOME: "/tmp/lab/home",
							PATH: [fakeBinPath, hostBinPath].join(delimiter),
							QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH: hostBinPath,
							QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR: "/tmp/lab/claude-config",
							QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG: "/tmp/lab/claude-config/empty-mcp.json",
							QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL: "haiku",
							QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE: "manual",
							ANTHROPIC_API_KEY: "must-not-leak",
							CAPTURE_PATH: capturePath,
						},
					},
				);
				const [home, configDir, apiKey, telemetry, ...capturedArgs] = (await readFile(capturePath, "utf8"))
					.trimEnd()
					.split("\n");
				expect(home).toBe("/tmp/lab/home");
				expect(configDir).toBe("/tmp/lab/claude-config");
				expect(apiKey).toBe("unset");
				expect(telemetry).toBe("1");
				expect(capturedArgs).toEqual([
					"--model",
					"haiku",
					"--permission-mode",
					"manual",
					"--setting-sources",
					"",
					"--strict-mcp-config",
					"--mcp-config",
					"/tmp/lab/claude-config/empty-mcp.json",
					"--no-chrome",
					"--disable-slash-commands",
					"--resume",
					"session-123",
					"--settings",
					"/tmp/hooks.json",
					"--",
					"synthetic prompt",
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"retains gateway authentication only for the explicitly selected provider launch",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-gateway-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			const capturePath = join(root, "capture.txt");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "claude"),
					`#!/bin/sh\nprintf "%s\\n" "\${ANTHROPIC_AUTH_TOKEN-unset}" "\${QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH-unset}" > "$CAPTURE_PATH"\n`,
					{ encoding: "utf8", mode: 0o755 },
				);
				await writeRealClaudeLauncher(fakeBinPath);
				await execFileAsync(join(fakeBinPath, "claude"), ["--settings", "/tmp/hooks.json"], {
					env: {
						PATH: [fakeBinPath, hostBinPath].join(delimiter),
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH: hostBinPath,
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR: "/tmp/lab/claude-config",
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG: "/tmp/lab/claude-config/empty-mcp.json",
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL: "haiku",
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE: "manual",
						QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH: "1",
						ANTHROPIC_AUTH_TOKEN: "synthetic-token",
						CAPTURE_PATH: capturePath,
					},
				});
				expect((await readFile(capturePath, "utf8")).trimEnd().split("\n")).toEqual(["synthetic-token", "unset"]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"fails closed on a second settings source",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-claude-conflict-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(join(hostBinPath, "claude"), "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
				await writeRealClaudeLauncher(fakeBinPath);
				await expect(
					execFileAsync(
						join(fakeBinPath, "claude"),
						["--settings", "/tmp/user.json", "--settings", "/tmp/hooks.json"],
						{
							env: {
								PATH: [fakeBinPath, hostBinPath].join(delimiter),
								QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH: hostBinPath,
								QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR: "/tmp/lab/claude-config",
								QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG: "/tmp/lab/claude-config/empty-mcp.json",
								QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL: "haiku",
								QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE: "manual",
							},
						},
					),
				).rejects.toMatchObject({ code: 64 });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("agent-lab real Codex", () => {
	it("stages only the existing credential into an isolated disposable profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-private-config-"));
		const sourceProfilePath = join(root, "source-profile");
		const artifactRoot = join(root, "artifacts");
		await mkdir(sourceProfilePath, { recursive: true });
		await writeFile(join(sourceProfilePath, "auth.json"), "synthetic credential\n", { mode: 0o600 });
		const sourceAgent = resolveRealCodexAgent({ codexHomePath: sourceProfilePath }, {});
		let config = await createAgentLabLaunchConfig({ artifactRoot, agent: sourceAgent });
		const validateAuthentication = vi.fn(async () => {});
		try {
			const isolatedAgent = await prepareIsolatedRealCodexAgent(
				sourceAgent,
				config.tempRoot,
				{},
				{
					platform: "win32",
					validateAuthentication,
				},
			);
			config = { ...config, agent: isolatedAgent };
			const configPath = await persistAgentLabLaunchConfig(config);
			expect(configPath).toBe(join(config.tempRoot, "supervisor-config.json"));
			expect(configPath.startsWith(config.artifactDir)).toBe(false);
			expect(isolatedAgent.codexHomePath).toBe(join(config.tempRoot, "codex-home"));
			expect(await readFile(join(isolatedAgent.codexHomePath, "auth.json"), "utf8")).toBe("synthetic credential\n");
			expect(await readFile(configPath, "utf8")).not.toContain(sourceProfilePath);
			expect(validateAuthentication).toHaveBeenCalledWith(isolatedAgent, {});
		} finally {
			await rm(config.tempRoot, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	it("resolves the existing profile without copying credentials into the public manifest", () => {
		const codexHomePath = resolve("/profiles/codex");
		const agent = resolveRealCodexAgent({}, { CODEX_HOME: codexHomePath, PATH: "/host/bin" });
		expect(agent).toMatchObject({
			mode: "real-codex",
			model: "gpt-5.6-luna",
			modelProvider: "openai",
			reasoningEffort: "low",
			profileSource: "environment",
			codexHomePath,
			sandbox: "read-only",
			approvalPolicy: "on-request",
		});
		expect(toPublicAgentConfig(agent)).toEqual({
			mode: "real-codex",
			multiAgent: false,
			model: "gpt-5.6-luna",
			modelProvider: "openai",
			reasoningEffort: "low",
			authentication: "existing-cli",
			profileSource: "environment",
			sandbox: "read-only",
			approvalPolicy: "on-request",
			serviceTier: "default",
			historyPersistence: "none",
			webSearch: "disabled",
			externalIntegrations: "disabled",
			profileHooks: "isolated",
			telemetry: "disabled",
		});
	});

	it("opts into one native subagent while preserving the isolated provider policy", async () => {
		const agent = resolveRealCodexAgent({ multiAgent: true }, {});
		expect(toPublicAgentConfig(agent)).toMatchObject({
			multiAgent: true,
			sandbox: "read-only",
			externalIntegrations: "disabled",
			profileHooks: "isolated",
		});
		const overrides = getAgentLabRealCodexConfigOverrides(agent.multiAgent);
		expect(overrides).toEqual([
			...AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES.filter(
				(value) => value !== "agents.enabled=false" && value !== "features.multi_agent=false",
			),
			"agents.enabled=true",
			"features.multi_agent=true",
			"features.multi_agent_v2=false",
			"agents.max_concurrent_threads_per_session=1",
			"agents.max_depth=1",
		]);
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-subagent-"));
		try {
			await writeAgentProviderLaunchers(root, agent);
			for (const name of ["codex", "codex.cmd", "codex.ps1"]) {
				const launcher = await readFile(join(root, name), "utf8");
				for (const value of [
					"agents.enabled=true",
					"features.multi_agent=true",
					"features.multi_agent_v2=false",
					"agents.max_concurrent_threads_per_session=1",
					"agents.max_depth=1",
					"features.apps=false",
					"allow_login_shell=false",
				])
					expect(launcher).toContain(value);
				expect(launcher).not.toContain("agents.enabled=false");
				expect(launcher).not.toContain("features.multi_agent=false");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("defaults older real-Codex public manifests to disabled subagents", () => {
		const { multiAgent: _omitted, ...legacy } = toPublicAgentConfig(resolveRealCodexAgent({}, {})) as Extract<
			ReturnType<typeof toPublicAgentConfig>,
			{ mode: "real-codex" }
		>;
		expect(AgentLabManifestSchema.shape.agent.parse(legacy)).toMatchObject({ multiAgent: false });
	});

	it("resolves copied Windows Codex environment keys case-insensitively", () => {
		const agent = resolveRealCodexAgent(
			{ platform: "win32" },
			{ Codex_Home: "C:\\Profiles\\codex", Path: "C:\\Tools" },
		);

		expect(agent).toMatchObject({
			profileSource: "environment",
			codexHomePath: "C:\\Profiles\\codex",
		});
	});

	it("preflights cached CLI authentication without forwarding API keys", () => {
		const codexHomePath = resolve("/profiles/codex");
		const agent = resolveRealCodexAgent({ codexHomePath }, {});
		const environment = buildRealCodexPreflightEnvironment(
			{
				PATH: "/host/bin",
				HOME: "/account/home",
				USERPROFILE: "/account/home",
				LANG: "en_US.UTF-8",
				OPENAI_API_KEY: "must-not-leak",
			},
			agent,
		);
		expect(environment).toMatchObject({
			PATH: "/host/bin",
			LANG: "en_US.UTF-8",
			HOME: "/account/home",
			USERPROFILE: "/account/home",
			CODEX_HOME: codexHomePath,
		});
		expect(environment.OPENAI_API_KEY).toBeUndefined();
	});

	it("copies Windows preflight environment keys case-insensitively", () => {
		const agent = resolveRealCodexAgent({ codexHomePath: "C:\\Profiles\\codex", platform: "win32" }, {});
		const environment = buildRealCodexPreflightEnvironment(
			{
				Path: "C:\\Host\\bin",
				systemroot: "C:\\Windows",
				pathext: ".EXE;.CMD",
				appdata: "C:\\Users\\tester\\AppData\\Roaming",
				localappdata: "C:\\Users\\tester\\AppData\\Local",
			},
			agent,
			"win32",
		);

		expect(environment).toMatchObject({
			PATH: "C:\\Host\\bin",
			SystemRoot: "C:\\Windows",
			PATHEXT: ".EXE;.CMD",
			APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
			CODEX_HOME: "C:\\Profiles\\codex",
		});
		expect(Object.keys(environment).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
	});

	it("writes a Windows launcher with the same profile and provider policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-windows-"));
		try {
			await writeRealCodexLauncher(root);
			const launcher = await readFile(join(root, "codex.cmd"), "utf8");
			const powerShellLauncher = await readFile(join(root, "codex.ps1"), "utf8");
			expect(launcher).not.toContain("REAL_CODEX_ACCOUNT_HOME");
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH=%PATH%"');
			expect(launcher).toContain('set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH%"');
			expect(launcher).toContain('set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH%"');
			expect(launcher).toContain('call "%QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY%"');
			expect(launcher).toContain('set "CODEX_HOME=%QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME%"');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX="');
			expect(launcher).toContain('set "QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY="');
			expect(launcher).toContain("-c service_tier='default'");
			expect(launcher).toContain("-c model_provider='openai'");
			expect(launcher).toContain("-c features.apps=false");
			expect(launcher).toContain("-c features.multi_agent=false");
			expect(launcher).not.toContain("-c mcp_servers={}");
			expect(launcher).not.toContain("-c hooks={}");
			expect(launcher).toContain("-c otel.exporter='none'");
			expect(launcher).toContain('set "_QD_MODEL_ARGUMENT=--model %QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL%"');
			expect(launcher).toContain('set "_QD_SANDBOX_ARGUMENT=--sandbox %QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX%"');
			expect(launcher).toContain(
				'set "_QD_APPROVAL_ARGUMENT=--ask-for-approval %QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY%"',
			);
			expect(launcher).toContain('if /I "%~1"=="--approve-for-me" set "_QD_HAS_APPROVAL_POLICY=1"');
			expect(launcher).toContain('if /I "%~1"=="--not-so-yolo" set "_QD_HAS_APPROVAL_POLICY=1"');
			expect(launcher).toContain('if /I "%~1"=="--approve-for-me" set "_QD_HAS_SANDBOX=1"');
			expect(launcher).toContain('if /I "%~1"=="--not-so-yolo" set "_QD_HAS_SANDBOX=1"');
			expect(powerShellLauncher).toContain("Get-Command codex -CommandType Application,ExternalScript");
			expect(powerShellLauncher).toContain("& $realCodexBinary @launchArguments");
			expect(powerShellLauncher).toContain("features.multi_agent=false");
			expect(launcher).toContain(
				'if /I "%~1"=="--dangerously-bypass-approvals-and-sandbox" set "_QD_HAS_APPROVAL_POLICY=1"',
			);
			expect(launcher).toContain('if /I "%~1"=="--yolo" set "_QD_HAS_SANDBOX=1"');
			expect(launcher).toContain("%_QD_APPROVAL_ARGUMENT% %*");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")(
		"executes the host Codex with bounded real-provider policy and exact profile identity",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			const capturePath = join(root, "capture.json");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "codex"),
					`#!/bin/sh\nprintf "%s\\n" "$HOME" "$CODEX_HOME" "\${QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME-unset}" "\${QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH-unset}" "$PATH" "$@" > "$CAPTURE_PATH"\n`,
					{ encoding: "utf8", mode: 0o755 },
				);
				await writeRealCodexLauncher(fakeBinPath);
				const runtimePath = [fakeBinPath, hostBinPath].join(delimiter);
				await execFileAsync(join(fakeBinPath, "codex"), ["-c", "hooks.state={}", "--", "--model=prompt-text"], {
					env: {
						HOME: "/tmp/lab/home",
						PATH: runtimePath,
						QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH: hostBinPath,
						QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME: "/profiles/codex",
						QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL: "gpt-5.6-luna",
						QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX: "read-only",
						QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: "on-request",
						CAPTURE_PATH: capturePath,
					},
				});
				const [
					capturedHome,
					capturedCodexHome,
					capturedProfileVariable,
					capturedHostPathVariable,
					capturedPath,
					...capturedArgs
				] = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
				expect(capturedHome).toBe("/tmp/lab/home");
				expect(capturedCodexHome).toBe("/profiles/codex");
				expect(capturedProfileVariable).toBe("unset");
				expect(capturedHostPathVariable).toBe("unset");
				expect(capturedPath).toBe(runtimePath);
				expect(capturedArgs).toEqual([
					...AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
					"--ask-for-approval",
					"on-request",
					"--sandbox",
					"read-only",
					"--model",
					"gpt-5.6-luna",
					"-c",
					"hooks.state={}",
					"--",
					"--model=prompt-text",
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform === "win32")(
		"executes the host Codex through the PowerShell launcher with bounded policy and exact profile identity",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-windows-exec-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			const capturePath = join(root, "capture.json");
			const labHome = join(root, "lab-home");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "codex.ps1"),
					[
						"$payload = [pscustomobject]@{",
						"  home = $env:HOME",
						"  codexHome = $env:CODEX_HOME",
						"  profileVariable = $env:QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME",
						"  hostPathVariable = $env:QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH",
						"  runtimePath = $env:PATH",
						"  arguments = @($args)",
						"}",
						"[System.IO.File]::WriteAllText($env:CAPTURE_PATH, (ConvertTo-Json -InputObject $payload -Depth 4 -Compress))",
						"",
					].join("\r\n"),
					"utf8",
				);
				await writeRealCodexLauncher(fakeBinPath);
				const runtimePath = [fakeBinPath, hostBinPath].join(delimiter);
				await execFileAsync(
					resolveWindowsPowerShellPath(),
					[
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						join(fakeBinPath, "codex.ps1"),
						"-c",
						"hooks.state={}",
						"--",
						"--model=prompt-text",
					],
					{
						env: mergeProcessEnvironment(
							process.env,
							{
								...process.env,
								HOME: labHome,
								PATH: runtimePath,
								QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH: hostBinPath,
								QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME: join(root, "profiles", "codex"),
								QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL: "gpt-5.6-luna",
								QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX: "read-only",
								QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: "on-request",
								CAPTURE_PATH: capturePath,
							},
							"win32",
						),
						windowsHide: true,
					},
				);
				const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
					home: string;
					codexHome: string;
					profileVariable: string | null;
					hostPathVariable: string | null;
					runtimePath: string;
					arguments: string[];
				};
				expect(captured).toMatchObject({
					home: labHome,
					codexHome: join(root, "profiles", "codex"),
					profileVariable: null,
					hostPathVariable: null,
					runtimePath,
				});
				expect(captured.arguments).toEqual([
					...AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
					"--model",
					"gpt-5.6-luna",
					"--sandbox",
					"read-only",
					"--ask-for-approval",
					"on-request",
					"-c",
					"hooks.state={}",
					"--",
					"--model=prompt-text",
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform !== "win32").each([
		{ explicitArgs: ["--approve-for-me"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--not-so-yolo"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--dangerously-bypass-approvals-and-sandbox"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--yolo"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--ask-for-approval", "never"], expectedApprovalFlagCount: 1 },
	])("does not combine the real Codex launcher with explicit approval mode $explicitArgs", async (testCase) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-approval-"));
		const fakeBinPath = join(root, "fake-bin");
		const hostBinPath = join(root, "host-bin");
		const capturePath = join(root, "capture.txt");
		try {
			await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
			await writeFile(join(hostBinPath, "codex"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_PATH"\n', {
				encoding: "utf8",
				mode: 0o755,
			});
			await writeRealCodexLauncher(fakeBinPath);
			await execFileAsync(join(fakeBinPath, "codex"), testCase.explicitArgs, {
				env: {
					HOME: "/tmp/lab/home",
					PATH: [fakeBinPath, hostBinPath].join(delimiter),
					QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH: hostBinPath,
					QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME: "/profiles/codex",
					QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL: "gpt-5.6-luna",
					QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX: "read-only",
					QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: "on-request",
					CAPTURE_PATH: capturePath,
				},
			});
			const capturedArgs = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
			expect(capturedArgs.filter((argument) => argument === "--ask-for-approval")).toHaveLength(
				testCase.expectedApprovalFlagCount,
			);
			for (const explicitArg of testCase.explicitArgs) {
				expect(capturedArgs).toContain(explicitArg);
			}
			if (testCase.expectedApprovalFlagCount === 0) {
				expect(capturedArgs).not.toContain("--sandbox");
			} else {
				expect(capturedArgs).toContain("--sandbox");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === "win32").each([
		{ explicitArgs: ["--approve-for-me"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--not-so-yolo"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--dangerously-bypass-approvals-and-sandbox"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--yolo"], expectedApprovalFlagCount: 0 },
		{ explicitArgs: ["--ask-for-approval", "never"], expectedApprovalFlagCount: 1 },
	])(
		"does not combine the Windows real Codex launcher with explicit approval mode $explicitArgs",
		async (testCase) => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-windows-approval-"));
			const fakeBinPath = join(root, "fake-bin");
			const hostBinPath = join(root, "host-bin");
			const capturePath = join(root, "capture.json");
			try {
				await Promise.all([mkdir(fakeBinPath, { recursive: true }), mkdir(hostBinPath, { recursive: true })]);
				await writeFile(
					join(hostBinPath, "codex.ps1"),
					"[System.IO.File]::WriteAllText($env:CAPTURE_PATH, (ConvertTo-Json -InputObject @($args) -Compress))\r\n",
					"utf8",
				);
				await writeRealCodexLauncher(fakeBinPath);
				await execFileAsync(
					resolveWindowsPowerShellPath(),
					[
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						join(fakeBinPath, "codex.ps1"),
						...testCase.explicitArgs,
					],
					{
						env: mergeProcessEnvironment(
							process.env,
							{
								...process.env,
								PATH: [fakeBinPath, hostBinPath].join(delimiter),
								QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH: hostBinPath,
								QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME: join(root, "profiles", "codex"),
								QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL: "gpt-5.6-luna",
								QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX: "read-only",
								QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: "on-request",
								CAPTURE_PATH: capturePath,
							},
							"win32",
						),
						windowsHide: true,
					},
				);
				const parsed = JSON.parse(await readFile(capturePath, "utf8")) as string | string[];
				const capturedArgs = Array.isArray(parsed) ? parsed : [parsed];
				expect(capturedArgs.filter((argument) => argument === "--ask-for-approval")).toHaveLength(
					testCase.expectedApprovalFlagCount,
				);
				for (const explicitArg of testCase.explicitArgs) expect(capturedArgs).toContain(explicitArg);
				if (testCase.expectedApprovalFlagCount === 0) {
					expect(capturedArgs).not.toContain("--sandbox");
				} else {
					expect(capturedArgs).toContain("--sandbox");
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

describe("agent-lab fake agent protocol", () => {
	it("prefers a prompt scenario directive over the run default", () => {
		expect(resolveFakeAgentScenario("Please test [agent-lab:needs-input] now", "idle")).toBe("needs-input");
		expect(resolveFakeAgentScenario("No directive", "terminal-stress")).toBe("terminal-stress");
		expect(resolveFakeAgentScenario("No directive", "claude-failure")).toBe("claude-failure");
	});

	it("extracts only the prompt after Codex's explicit option separator", () => {
		expect(extractPromptArgument(["--enable", "hooks", "--", "- investigate", "the UI"])).toBe(
			"- investigate the UI",
		);
		expect(extractPromptArgument(["resume", "session-id"])).toBe("");
	});

	it("models Claude's minimum version, launch settings, prompt, and exact resume arguments", () => {
		expect(getFakeAgentVersionOutput("claude")).toBe("2.1.198 (Claude Code)");
		expect(
			resolveFakeAgentInvocation("claude", [
				"--resume",
				"claude-session-123",
				"--settings",
				"/tmp/hooks.json",
				"--",
				"- continue safely",
			]),
		).toEqual({
			prompt: "- continue safely",
			resumeKind: "targeted",
			requestedSessionId: "claude-session-123",
			settingsPath: "/tmp/hooks.json",
		});
		expect(resolveFakeAgentInvocation("claude", ["--continue", "--settings=/tmp/hooks.json"])).toEqual({
			prompt: "",
			resumeKind: "continue",
			requestedSessionId: null,
			settingsPath: "/tmp/hooks.json",
		});
	});

	it("mirrors Claude's fullscreen renderer environment across deterministic launches", () => {
		expect(shouldFakeAgentUseFullscreen("claude", [], { CLAUDE_CODE_NO_FLICKER: "1" })).toBe(true);
		expect(
			shouldFakeAgentUseFullscreen("claude", [], {
				CLAUDE_CODE_NO_FLICKER: "1",
				CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
			}),
		).toBe(false);
		expect(shouldFakeAgentUseFullscreen("claude", [], { CLAUDE_CODE_NO_FLICKER: "0" })).toBe(false);
		for (const provider of ["claude", "codex", "pi"] as const) {
			expect(shouldFakeAgentUseFullscreen(provider, [], {})).toBe(false);
		}
		expect(shouldFakeAgentUseFullscreen("codex", [], { CLAUDE_CODE_NO_FLICKER: "1" })).toBe(false);
	});

	it.each(
		(["claude", "codex", "pi"] as const).flatMap((provider) =>
			(["fresh", "continue", "targeted"] as const).map((resumeKind) => ({ provider, resumeKind })),
		),
	)("follows actual $provider adapter policy for $resumeKind launches", async ({ provider, resumeKind }) => {
		const launch = await prepareAgentLaunch({
			agentId: provider,
			taskId: "fullscreen-fixture",
			args: [],
			cwd: "/synthetic/project",
			projectPath: "/synthetic/project",
			// Renderer arguments must not depend on hook installation/admission.
			prompt: resumeKind === "fresh" ? "- synthetic prompt" : "",
			resumeConversation: resumeKind !== "fresh",
			resumeSessionId: resumeKind === "targeted" ? "agent-lab-fullscreen" : undefined,
		});
		expect(shouldFakeAgentUseFullscreen(provider, launch.args, launch.env)).toBe(true);
		expect(resolveFakeAgentInvocation(provider, launch.args)).toMatchObject({
			prompt: resumeKind === "fresh" ? "- synthetic prompt" : "",
			resumeKind,
			requestedSessionId: resumeKind === "targeted" ? "agent-lab-fullscreen" : null,
		});
	});

	it.each([{ args: [] }, { args: ["--append-system-prompt", "--"] }])(
		"keeps a prompt-less Pi start prompt-less with native option arguments $args",
		async ({ args }) => {
			const launch = await prepareAgentLaunch({
				agentId: "pi",
				taskId: "fullscreen-fixture",
				args,
				cwd: "/synthetic/project",
				prompt: "",
			});
			expect(shouldFakeAgentUseFullscreen("pi", launch.args, launch.env)).toBe(true);
			expect(resolveFakeAgentInvocation("pi", launch.args)).toMatchObject({
				prompt: "",
				resumeKind: "fresh",
				requestedSessionId: null,
			});
		},
	);

	it("requires every managed Codex renderer override and respects conflicting flags", () => {
		const policy = [
			"-c",
			"tui.fullscreen_transcript=true",
			"--config",
			'tui.alternate_screen="always"',
			"--config=tui.raw_output_mode=false",
		] as const;
		expect(shouldFakeAgentUseFullscreen("codex", policy, {})).toBe(true);
		for (const args of [
			policy.slice(2),
			[...policy.slice(0, 2), policy[4]],
			policy.slice(0, 4),
			[...policy, "--no-alt-screen"],
			[...policy, "-c=tui.fullscreen_transcript=false"],
			[...policy, "-c", "tui.alternate_screen='never'"],
			[...policy, "-c", "tui.raw_output_mode=true"],
			["--", ...policy],
			["--model", policy[4], ...policy.slice(0, 4)],
		]) {
			expect(shouldFakeAgentUseFullscreen("codex", args, {})).toBe(false);
		}
		expect(shouldFakeAgentUseFullscreen("codex", [...policy, "--", "--no-alt-screen"], {})).toBe(true);
	});

	it("parses Pi renderer, resume, and prompt tokens without treating option values as prompts", () => {
		expect(getFakeAgentVersionOutput("pi")).toBe("1.5.2");
		for (const args of [
			["--tui-mode", "fullscreen"],
			["--tui-mode", "regular", "--tui-mode", "fullscreen"],
		]) {
			expect(shouldFakeAgentUseFullscreen("pi", args, {})).toBe(true);
			expect(resolveFakeAgentInvocation("pi", args).prompt).toBe("");
		}
		for (const args of [
			["--tui-mode", "regular"],
			["--tui-mode", "fullscreen", "--tui-mode", "regular"],
			["--tui-mode=fullscreen"],
			["--system-prompt", "--tui-mode", "fullscreen"],
			["--", "--tui-mode", "fullscreen"],
		]) {
			expect(shouldFakeAgentUseFullscreen("pi", args, {})).toBe(false);
		}
		expect(
			resolveFakeAgentInvocation("pi", [
				"--session",
				"/synthetic/session.jsonl",
				"--extension",
				"/synthetic/hooks.js",
				"--tui-mode",
				"fullscreen",
			]),
		).toMatchObject({ prompt: "", resumeKind: "targeted", requestedSessionId: "/synthetic/session.jsonl" });
		expect(resolveFakeAgentInvocation("pi", ["--tui-mode", "fullscreen", "--", "--continue"])).toMatchObject({
			prompt: "--continue",
			resumeKind: "fresh",
		});
		expect(resolveFakeAgentInvocation("pi", ["--system-prompt", "--continue"])).toMatchObject({
			prompt: "",
			resumeKind: "fresh",
		});
	});

	it.each([
		{ args: ["--plan", "extension value", "review this"], prompt: "review this" },
		{ args: ["--plan=extension value", "review this"], prompt: "review this" },
		{ args: ["--plan", "@context.txt", "review this"], prompt: "review this" },
		{ args: ["--plan", "--", "review this"], prompt: "review this" },
		{ args: ["--continue", "review this"], prompt: "review this" },
		{ args: ["--offline", "review this"], prompt: "review this" },
		{ args: ["--", "--plan", "review this", "@context.txt"], prompt: "--plan review this" },
	])("preserves native Pi extension-flag positional ownership for $args", ({ args, prompt }) => {
		expect(resolveFakeAgentInvocation("pi", args).prompt).toBe(prompt);
	});

	it("keeps a positional Pi prompt after a renderer option adjacent to an extension flag", async () => {
		const args = ["--plan", "--tui-mode", "regular", "review this"];
		expect(resolveFakeAgentInvocation("pi", args).prompt).toBe("review this");
		// Deleting the native mode pair would make --plan consume the prompt.
		expect(resolveFakeAgentInvocation("pi", ["--plan", "review this"]).prompt).toBe("");
		const launch = await prepareAgentLaunch({
			agentId: "pi",
			taskId: "fullscreen-fixture",
			args,
			cwd: "/synthetic/project",
			prompt: "",
		});
		expect(shouldFakeAgentUseFullscreen("pi", launch.args, launch.env)).toBe(true);
		expect(resolveFakeAgentInvocation("pi", launch.args).prompt).toBe("review this");
	});

	it("retains explicit alternate-screen and normal-buffer fallback commands", () => {
		expect(parseFakeAgentCommand("/alt-on")).toEqual({ kind: "alternate-screen", enabled: true });
		expect(parseFakeAgentCommand("/alt-off")).toEqual({ kind: "alternate-screen", enabled: false });
	});

	it("builds Claude-shaped native hook payloads with provider identities", () => {
		expect(
			buildClaudeHookPayload("Stop", {
				sessionId: "claude-session-123",
				cwd: "/tmp/project",
				promptId: "prompt-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				elicitationId: "elicitation-1",
				providerAgentId: "background-agent-1",
				notificationType: "agent_needs_input",
				finalMessage: "Waiting for background work",
				backgroundWork: true,
			}),
		).toEqual(
			expect.objectContaining({
				session_id: "claude-session-123",
				hook_event_name: "Stop",
				prompt_id: "prompt-1",
				tool_name: "Bash",
				tool_use_id: "tool-1",
				elicitation_id: "elicitation-1",
				agent_id: "background-agent-1",
				notification_type: "agent_needs_input",
				last_assistant_message: "Waiting for background work",
				background_tasks: [{ id: "agent-lab-background-1" }],
			}),
		);
	});

	it("parses bounded deterministic commands", () => {
		expect(getFakeAgentVersionOutput("codex")).toBe("codex-cli 0.157.0");
		expect(parseFakeAgentCommand("/needs-input-auto provider approved")).toEqual({
			kind: "needs-input-auto",
			message: "provider approved",
		});
		expect(parseFakeAgentCommand("/approval-overlay")).toEqual({ kind: "approval-overlay" });
		expect(parseFakeAgentCommand("/hyperlink")).toEqual({ kind: "hyperlink" });
		expect(parseFakeAgentCommand("/turn-interrupted")).toEqual({ kind: "turn-interrupted" });
		expect(parseFakeAgentCommand("/native-interrupt")).toEqual({ kind: "native-interrupt" });
		expect(parseFakeAgentCommand("/new-turn continue")).toEqual({ kind: "new-turn", message: "continue" });
		expect(parseFakeAgentCommand("/redraw-interruption-history")).toEqual({
			kind: "redraw-interruption-history",
		});
		expect(parseFakeAgentCommand("/local-action model changed")).toEqual({
			kind: "local-action",
			message: "model changed",
		});
		expect(parseFakeAgentCommand("/compact")).toEqual({ kind: "compact" });
		expect(parseFakeAgentCommand("/notification check input")).toEqual({
			kind: "notification",
			message: "check input",
		});
		expect(parseFakeAgentCommand("/elicitation choose one")).toEqual({
			kind: "elicitation",
			message: "choose one",
		});
		expect(parseFakeAgentCommand("/elicitation-result selected one")).toEqual({
			kind: "elicitation-result",
			message: "selected one",
		});
		expect(parseFakeAgentCommand("/background-stop still working")).toEqual({
			kind: "background-stop",
			message: "still working",
		});
		expect(parseFakeAgentCommand("/stop-failure rate limited")).toEqual({
			kind: "stop-failure",
			message: "rate limited",
		});
		expect(parseFakeAgentCommand("/queued-follow-up continue now")).toEqual({
			kind: "queued-follow-up",
			message: "continue now",
		});
		expect(parseFakeAgentCommand("/stale-run")).toEqual({ kind: "stale-run" });
		expect(parseFakeAgentCommand("/fail-next-resume")).toEqual({ kind: "fail-next-resume" });
		expect(parseFakeAgentCommand("/write nested/result.txt hello world")).toEqual({
			kind: "write",
			relativePath: "nested/result.txt",
			contents: "hello world",
		});
		expect(parseFakeAgentCommand("/delay-review 999999 done")).toEqual({
			kind: "delay-review",
			delayMs: 30_000,
			message: "done",
		});
		expect(parseFakeAgentCommand("/spam nope")).toEqual({ kind: "spam", count: 100 });
	});
});

describe("agent-lab run ids", () => {
	it("creates filesystem-safe, sortable ids", () => {
		const runId = createAgentLabRunId("Visual Debug", new Date("2026-08-23T12:34:56.789Z"));
		expect(runId).toMatch(/^visual-debug-20260823T123456Z-[a-f0-9]{6}$/);
		expect(assertSafeRunId(runId)).toBe(runId);
		expect(() => assertSafeRunId("../escape")).toThrow("Invalid agent-lab run id");
		expect(() => assertSafeRunId("con", "win32")).toThrow("Invalid agent-lab run id");
		expect(assertSafeRunId("con", "linux")).toBe("con");
	});
});
