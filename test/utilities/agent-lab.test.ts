import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { _testing as browserActionTesting } from "../../scripts/agent-lab/browser-actions";
import { resolveGitCommonDirectory } from "../../scripts/agent-lab/browser-cache.mjs";
import { describeAgentLabAgent, parseAgentLabPort, runAgentLabCli } from "../../scripts/agent-lab/cli";
import { buildAgentLabEnvironment, buildSupervisorEnvironment } from "../../scripts/agent-lab/environment";
import {
	buildClaudeHookPayload,
	extractPromptArgument,
	getFakeAgentVersionOutput,
	parseFakeAgentCommand,
	resolveFakeAgentInvocation,
	resolveFakeAgentScenario,
	shouldFakeClaudeUseFullscreen,
} from "../../scripts/agent-lab/fake-agent-protocol";
import {
	writeAgentProviderLaunchers,
	writeRealClaudeLauncher,
	writeRealCodexLauncher,
} from "../../scripts/agent-lab/fixture";
import { createAgentLabLaunchConfig, persistAgentLabLaunchConfig } from "../../scripts/agent-lab/launch-config";
import { resolveLoopbackPort } from "../../scripts/agent-lab/loopback-port";
import {
	AGENT_LAB_BROWSER_INSTALL_COMMAND,
	assertSafeRunId,
	createAgentLabRunId,
	getAgentBrowserLocalPaths,
	getAgentLabArtifactRoot,
	getAgentLabBrowserCachePath,
	getAgentLabBrowserCachePaths,
	prepareAgentLabBrowserCache,
	readAgentLabManifest,
} from "../../scripts/agent-lab/paths";
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
	prepareIsolatedRealCodexAgent,
	resolveRealCodexAgent,
} from "../../scripts/agent-lab/real-codex";
import {
	detectInstalledCommands,
	getAgentAvailability,
	resetAgentAvailabilityCache,
} from "../../src/config/agent-registry";
import { isBinaryAvailableOnPath, mergeProcessEnvironment, resolveWindowsPowerShellPath } from "../../src/core";

const execFileAsync = promisify(execFile);

describe("agent-lab browser cache", () => {
	it("derives a linked worktree common directory without launching Git from the checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-gitdir-"));
		try {
			const repoRoot = join(root, "task-worktree");
			const commonDirectory = join(root, "primary", ".git");
			const worktreeGitDirectory = join(commonDirectory, "worktrees", "task");
			await mkdir(repoRoot, { recursive: true });
			await mkdir(worktreeGitDirectory, { recursive: true });
			await writeFile(join(repoRoot, ".git"), `gitdir: ${worktreeGitDirectory}\n`, "utf8");
			await writeFile(join(worktreeGitDirectory, "commondir"), "../..\n", "utf8");

			expect(resolveGitCommonDirectory(repoRoot)).toBe(resolve(commonDirectory));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shares browser binaries through the primary checkout", () => {
		const commonDirectory = "/repo/quarterdeck/.git";
		expect(getAgentLabBrowserCachePath("/repo/.quarterdeck/worktrees/task/quarterdeck", commonDirectory)).toBe(
			join(resolve(commonDirectory), "quarterdeck", "agent-lab", "playwright-browsers"),
		);
	});

	it("falls back to the active checkout for nonstandard Git layouts", () => {
		const commonDirectory = "/repo/quarterdeck.git";
		expect(getAgentLabBrowserCachePath("/repo/quarterdeck", commonDirectory)).toBe(
			join(resolve(commonDirectory), "quarterdeck", "agent-lab", "playwright-browsers"),
		);
	});

	it("keeps the durable cache outside every node_modules tree", () => {
		const paths = getAgentLabBrowserCachePaths(
			"/repo/.quarterdeck/worktrees/task/quarterdeck",
			"/repo/quarterdeck/.git",
		);
		expect(paths.stablePath.split(/[\\/]/u)).not.toContain("node_modules");
		expect(paths.legacyPath).toBe(
			join(dirname(resolve("/repo/quarterdeck/.git")), "web-ui", "node_modules", ".cache", "agent-lab-playwright"),
		);
	});

	it("resolves the same cache for two worktrees sharing a Git common directory", () => {
		const commonDirectory = "/repo/quarterdeck/.git";
		expect(getAgentLabBrowserCachePath("/worktrees/one/quarterdeck", commonDirectory)).toBe(
			getAgentLabBrowserCachePath("/worktrees/two/quarterdeck", commonDirectory),
		);
	});

	it("keeps browser profiles, daemon state, and artifacts worktree-local", () => {
		const firstRepoRoot = "/worktrees/one/quarterdeck";
		const secondRepoRoot = "/worktrees/two/quarterdeck";
		const first = getAgentBrowserLocalPaths(firstRepoRoot);
		const second = getAgentBrowserLocalPaths(secondRepoRoot);
		expect(first).toEqual({
			artifactRoot: join(firstRepoRoot, "test-results", "agent-lab"),
			browserHomePath: join(firstRepoRoot, "test-results", "agent-lab", "browser-home"),
			daemonSessionPath: join(firstRepoRoot, "test-results", "agent-lab", "browser-daemon"),
		});
		expect(second.artifactRoot).not.toBe(first.artifactRoot);
	});

	it("uses a worktree-local fallback when legacy test-results is a shared symlink", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-artifact-root-"));
		const repoRoot = join(root, "worktree");
		const sharedResults = join(root, "shared-results");
		const previousOverride = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
		try {
			delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			await mkdir(repoRoot, { recursive: true });
			await mkdir(sharedResults, { recursive: true });
			await symlink(
				sharedResults,
				join(repoRoot, "test-results"),
				process.platform === "win32" ? "junction" : "dir",
			);

			expect(getAgentLabArtifactRoot(repoRoot)).toBe(join(repoRoot, ".agent-lab-results"));
		} finally {
			if (previousOverride === undefined) {
				delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			} else {
				process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = previousOverride;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("survives root and web dependency reinstalls", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-survival-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		try {
			await mkdir(join(repoRoot, "node_modules"), { recursive: true });
			await mkdir(join(repoRoot, "web-ui", "node_modules"), { recursive: true });
			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			const sentinelPath = join(prepared.path, "cache-sentinel");
			await writeFile(sentinelPath, "browser-binary-cache\n", "utf8");
			await rm(join(repoRoot, "node_modules"), { recursive: true, force: true });
			await rm(join(repoRoot, "web-ui", "node_modules"), { recursive: true, force: true });
			expect(await readFile(sentinelPath, "utf8")).toBe("browser-binary-cache\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("migrates a complete legacy Chromium cache without deleting it", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-migration-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		const legacyInstallation = join(paths.legacyPath, "chromium-1237");
		try {
			await mkdir(legacyInstallation, { recursive: true });
			await writeFile(join(legacyInstallation, "INSTALLATION_COMPLETE"), "", "utf8");
			await writeFile(join(legacyInstallation, "browser-binary"), "complete\n", "utf8");

			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(prepared).toEqual({ path: paths.stablePath, status: "migrated" });
			const launchPreparation = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(launchPreparation).toEqual({ path: prepared.path, status: "ready" });
			expect(await readFile(join(paths.stablePath, "chromium-1237", "browser-binary"), "utf8")).toBe("complete\n");
			expect(await readFile(join(legacyInstallation, "browser-binary"), "utf8")).toBe("complete\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not migrate a partial Playwright installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-partial-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		try {
			await mkdir(join(paths.legacyPath, "chromium-1237"), { recursive: true });
			await writeFile(join(paths.legacyPath, "chromium-1237", "browser-binary"), "partial\n", "utf8");
			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(prepared).toEqual({ path: paths.stablePath, status: "empty" });
			expect(await readFile(join(paths.legacyPath, "chromium-1237", "browser-binary"), "utf8")).toBe("partial\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink at the stable cache path without following it", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-symlink-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		const externalDirectory = join(root, "external-cache-target");
		try {
			await mkdir(externalDirectory, { recursive: true });
			await writeFile(join(externalDirectory, "sentinel"), "untouched\n", "utf8");
			await mkdir(join(commonDirectory, "quarterdeck", "agent-lab"), { recursive: true });
			await symlink(externalDirectory, paths.stablePath, process.platform === "win32" ? "junction" : "dir");

			await expect(prepareAgentLabBrowserCache(repoRoot, commonDirectory)).rejects.toThrow(
				"must be a real directory",
			);
			expect(await readFile(join(externalDirectory, "sentinel"), "utf8")).toBe("untouched\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the explicit install flow when no browser cache exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-empty-"));
		try {
			const prepared = await prepareAgentLabBrowserCache(join(root, "repo"), join(root, "repo", ".git"));
			expect(prepared.status).toBe("empty");
			expect(AGENT_LAB_BROWSER_INSTALL_COMMAND).toBe("npm run agent:browser -- install-browser chromium");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("agent-lab environment", () => {
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
	it("describes the selected authentication boundary in human-readable summaries", () => {
		expect(describeAgentLabAgent(resolveRealClaudeAgent({}, {}))).toBe("real Claude (haiku, existing CLI auth)");
		expect(describeAgentLabAgent(resolveRealClaudeAgent({ environmentAuthentication: true }, {}))).toBe(
			"real Claude (haiku, environment auth)",
		);
	});

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

	it.runIf(process.platform !== "win32")("fails closed on a second settings source", async () => {
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
	});
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

	it.each([
		["--model", "gpt-5.6-luna"],
		["--codex-home", "/profiles/codex"],
		["--claude-config-dir", "/profiles/claude"],
		["--codex-sandbox", "workspace-write"],
		["--codex-approval-policy", "never"],
	])("rejects real-only option %s in fake mode", async (flag, value) => {
		await expect(runAgentLabCli(["node", "agent-lab", "start", flag, value])).rejects.toThrow(
			"require --agent real-codex or --agent real-claude",
		);
	});

	it("rejects Claude environment authentication in fake mode", async () => {
		await expect(runAgentLabCli(["node", "agent-lab", "start", "--claude-environment-auth"])).rejects.toThrow(
			"require --agent real-codex or --agent real-claude",
		);
	});
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
		expect(shouldFakeClaudeUseFullscreen("claude", { CLAUDE_CODE_NO_FLICKER: "1" })).toBe(true);
		expect(
			shouldFakeClaudeUseFullscreen("claude", {
				CLAUDE_CODE_NO_FLICKER: "1",
				CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
			}),
		).toBe(false);
		expect(shouldFakeClaudeUseFullscreen("claude", { CLAUDE_CODE_NO_FLICKER: "0" })).toBe(false);
		expect(shouldFakeClaudeUseFullscreen("codex", { CLAUDE_CODE_NO_FLICKER: "1" })).toBe(false);
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
		expect(parseFakeAgentCommand("/needs-input-auto provider approved")).toEqual({
			kind: "needs-input-auto",
			message: "provider approved",
		});
		expect(parseFakeAgentCommand("/approval-overlay")).toEqual({ kind: "approval-overlay" });
		expect(parseFakeAgentCommand("/turn-interrupted")).toEqual({ kind: "turn-interrupted" });
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

	it("keeps Claude-only scenarios out of the default fake lane", async () => {
		await expect(
			runAgentLabCli(["node", "agent-lab", "start", "--agent", "fake", "--scenario", "claude-lifecycle"]),
		).rejects.toThrow("require --agent fake-claude");
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

describe("agent-lab manifest compatibility", () => {
	it("keeps version-1 runs readable for status, list, and stop lifecycle operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-manifest-test-"));
		const runDirectory = join(root, "legacy-run");
		const manifestPath = join(runDirectory, "manifest.json");
		const previousArtifactRoot = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await mkdir(runDirectory, { recursive: true });
			process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = root;
			await writeFile(
				manifestPath,
				`${JSON.stringify({
					schemaVersion: 1,
					runId: "legacy-run",
					status: "stopped",
					repoRoot: "/repo",
					artifactDir: root,
					manifestPath,
					stopRequestPath: join(root, "stop-request.json"),
					tempRoot: join(root, "temp"),
					homePath: join(root, "home"),
					statePath: join(root, "state"),
					projectPath: join(root, "project"),
					additionalProjectPath: join(root, "project-secondary"),
					forbiddenHostLaunchLogPath: join(root, "forbidden-host-launches.log"),
					runtimeCapabilities: { nativeUiAvailable: false },
					projectUrl: "http://127.0.0.1:4174/project",
					runtimeUrl: "http://127.0.0.1:3597",
					webUrl: "http://127.0.0.1:4174",
					browserConfigPath: join(root, "browser.json"),
					browserOutputPath: join(root, "browser"),
					browserSession: "legacy-browser",
					scenario: "idle",
					keepTemp: true,
					supervisorPid: process.pid,
					processes: { runtime: null, web: null },
					createdAt: "2026-08-23T12:34:56.000Z",
					readyAt: "2026-08-23T12:34:57.000Z",
					stoppedAt: "2026-08-23T12:35:00.000Z",
					failure: null,
				})}\n`,
				"utf8",
			);

			await expect(readAgentLabManifest(manifestPath)).resolves.toMatchObject({
				schemaVersion: 1,
				runId: "legacy-run",
				status: "stopped",
				stopRequestPath: join(root, "stop-request.json"),
			});

			for (const args of [
				["node", "agent-lab", "status", "legacy-run", "--json"],
				["node", "agent-lab", "list", "--json"],
				["node", "agent-lab", "stop", "legacy-run", "--json"],
			]) {
				stdout.mockClear();
				await runAgentLabCli(args);
				expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain('"runId": "legacy-run"');
			}
			stdout.mockClear();
			await runAgentLabCli(["node", "agent-lab", "snapshot", "legacy-run", "--label", "legacy", "--json"]);
			expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain('"label": "legacy"');

			const versionOneManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				manifestPath,
				`${JSON.stringify({
					...versionOneManifest,
					schemaVersion: 2,
					hostEventLedgerPath: join(root, "host-events.jsonl"),
					runtimeCapabilities: { nativeUiAvailable: false, hostIntegrationMode: "simulated" },
				})}\n`,
				"utf8",
			);
			await expect(readAgentLabManifest(manifestPath)).resolves.toMatchObject({
				schemaVersion: 2,
				runId: "legacy-run",
			});
			await expect(runAgentLabCli(["node", "agent-lab", "restart-runtime", "legacy-run", "--json"])).rejects.toThrow(
				"predates same-state runtime restart support",
			);

			const versionTwoManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				manifestPath,
				`${JSON.stringify({
					...versionTwoManifest,
					schemaVersion: 3,
					runtimeRestartRequestPath: join(root, "runtime-restart-request.json"),
					runtimeRestartResultPath: join(root, "runtime-restart-result.json"),
					runtimeGeneration: 1,
					runtimeRestarts: [],
				})}\n`,
				"utf8",
			);
			await expect(readAgentLabManifest(manifestPath)).resolves.toMatchObject({
				schemaVersion: 3,
				runtimeGeneration: 1,
			});
		} finally {
			stdout.mockRestore();
			if (previousArtifactRoot === undefined) {
				delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			} else {
				process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = previousArtifactRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("agent-lab loopback ports", () => {
	it("maps the documented auto CLI value to an ephemeral numeric port", () => {
		expect(parseAgentLabPort("auto")).toBe(0);
		expect(parseAgentLabPort("41731")).toBe(41_731);
		expect(() => parseAgentLabPort("invalid")).toThrow('use 1-65535 or "auto"');
	});

	it("allocates an ephemeral port through the shared supervisor boundary", async () => {
		const port = await resolveLoopbackPort(null, "test");
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThanOrEqual(65_535);
	});
});

describe("agent-lab browser action summaries", () => {
	it("keeps synthetic interaction text while aliasing lab paths", () => {
		const manifest = {
			artifactDir: "/repo/test-results/agent-lab/run-1",
			tempRoot: "/tmp/lab-run",
			repoRoot: "/repo",
		} as Parameters<typeof browserActionTesting.summarizeArguments>[0];
		const summary = browserActionTesting.summarizeArguments(manifest, [
			"-s=qd-run-1",
			"fill",
			"e12",
			"synthetic prompt",
			"--filename=/repo/test-results/agent-lab/run-1/browser/checkpoint.png",
		]);
		expect(summary).toContain("synthetic prompt");
		expect(summary).toContain("--filename=$LAB_ARTIFACT/browser/checkpoint.png");
		expect(summary.join(" ")).not.toContain("/repo/test-results");
	});
});
