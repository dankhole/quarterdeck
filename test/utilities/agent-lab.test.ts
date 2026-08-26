import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { _testing as browserActionTesting } from "../../scripts/agent-lab/browser-actions";
import { runAgentLabCli } from "../../scripts/agent-lab/cli";
import { buildAgentLabEnvironment } from "../../scripts/agent-lab/environment";
import {
	extractPromptArgument,
	parseFakeAgentCommand,
	resolveFakeAgentScenario,
} from "../../scripts/agent-lab/fake-agent-protocol";
import { writeRealCodexLauncher } from "../../scripts/agent-lab/fixture";
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
import {
	AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES,
	buildRealCodexPreflightEnvironment,
	prepareIsolatedRealCodexAgent,
	resolveRealCodexAgent,
	toPublicAgentConfig,
} from "../../scripts/agent-lab/real-codex";

const execFileAsync = promisify(execFile);

describe("agent-lab browser cache", () => {
	it("shares browser binaries through the primary checkout", () => {
		expect(
			getAgentLabBrowserCachePath("/repo/.quarterdeck/worktrees/task/quarterdeck", "/repo/quarterdeck/.git"),
		).toBe("/repo/quarterdeck/.git/quarterdeck/agent-lab/playwright-browsers");
	});

	it("falls back to the active checkout for nonstandard Git layouts", () => {
		expect(getAgentLabBrowserCachePath("/repo/quarterdeck", "/repo/quarterdeck.git")).toBe(
			"/repo/quarterdeck.git/quarterdeck/agent-lab/playwright-browsers",
		);
	});

	it("keeps the durable cache outside every node_modules tree", () => {
		const paths = getAgentLabBrowserCachePaths(
			"/repo/.quarterdeck/worktrees/task/quarterdeck",
			"/repo/quarterdeck/.git",
		);
		expect(paths.stablePath.split("/")).not.toContain("node_modules");
		expect(paths.legacyPath).toBe("/repo/quarterdeck/web-ui/node_modules/.cache/agent-lab-playwright");
	});

	it("resolves the same cache for two worktrees sharing a Git common directory", () => {
		const commonDirectory = "/repo/quarterdeck/.git";
		expect(getAgentLabBrowserCachePath("/worktrees/one/quarterdeck", commonDirectory)).toBe(
			getAgentLabBrowserCachePath("/worktrees/two/quarterdeck", commonDirectory),
		);
	});

	it("keeps browser profiles, daemon state, and artifacts worktree-local", () => {
		const first = getAgentBrowserLocalPaths("/worktrees/one/quarterdeck");
		const second = getAgentBrowserLocalPaths("/worktrees/two/quarterdeck");
		expect(first).toEqual({
			artifactRoot: "/worktrees/one/quarterdeck/test-results/agent-lab",
			browserHomePath: "/worktrees/one/quarterdeck/test-results/agent-lab/browser-home",
			daemonSessionPath: "/worktrees/one/quarterdeck/test-results/agent-lab/browser-daemon",
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
				fakeCodexPath: "/repo/scripts/fake-codex.ts",
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
		expect(environment.QUARTERDECK_STATE_HOME).toBe("/tmp/lab/state");
		expect(environment.QUARTERDECK_RUNTIME_PORT).toBe("35001");
		expect(environment.QUARTERDECK_AGENT_LAB_ADDITIONAL_PROJECT).toBe("/tmp/lab/project-secondary");
		expect(environment.PATH).toBe(["/tmp/lab/bin", "/host/bin"].join(delimiter));
	});

	it("exposes real profile paths only through wrapper-specific variables", () => {
		const agent = resolveRealCodexAgent(
			{
				model: "gpt-5.6-luna",
				codexHomePath: "/account/home/.codex",
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
				fakeCodexPath: "/repo/scripts/fake-codex.ts",
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
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME).toBe("/account/home/.codex");
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_ACCOUNT_HOME).toBeUndefined();
		expect(environment.QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL).toBe("gpt-5.6-luna");
		expect(environment.QUARTERDECK_TITLE_PROVIDER).toBe("local");
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
		const agent = resolveRealCodexAgent({}, { CODEX_HOME: "/profiles/codex", PATH: "/host/bin" });
		expect(agent).toMatchObject({
			mode: "real-codex",
			model: "gpt-5.6-luna",
			modelProvider: "openai",
			reasoningEffort: "low",
			profileSource: "environment",
			codexHomePath: "/profiles/codex",
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

	it("preflights cached CLI authentication without forwarding API keys", () => {
		const agent = resolveRealCodexAgent({ codexHomePath: "/profiles/codex" }, {});
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
			CODEX_HOME: "/profiles/codex",
		});
		expect(environment.OPENAI_API_KEY).toBeUndefined();
	});

	it("writes a Windows launcher with the same profile and provider policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-real-codex-windows-"));
		try {
			await writeRealCodexLauncher(root);
			const launcher = await readFile(join(root, "codex.cmd"), "utf8");
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

	it.each([
		["--model", "gpt-5.6-luna"],
		["--codex-home", "/profiles/codex"],
		["--codex-sandbox", "workspace-write"],
		["--codex-approval-policy", "never"],
	])("rejects real-only option %s in fake mode", async (flag, value) => {
		await expect(runAgentLabCli(["node", "agent-lab", "start", flag, value])).rejects.toThrow(
			"require --agent real-codex",
		);
	});
});

describe("agent-lab fake agent protocol", () => {
	it("prefers a prompt scenario directive over the run default", () => {
		expect(resolveFakeAgentScenario("Please test [agent-lab:needs-input] now", "idle")).toBe("needs-input");
		expect(resolveFakeAgentScenario("No directive", "terminal-stress")).toBe("terminal-stress");
	});

	it("extracts only the prompt after Codex's explicit option separator", () => {
		expect(extractPromptArgument(["--enable", "hooks", "--", "- investigate", "the UI"])).toBe(
			"- investigate the UI",
		);
		expect(extractPromptArgument(["resume", "session-id"])).toBe("");
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
