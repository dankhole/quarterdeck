import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildClaudeHooksSettings,
	buildClaudeHttpHooksSettings,
	CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS,
	type ClaudeHookHandler,
	type ClaudeHooksSettings,
} from "../../../src/claude-hooks";
import { buildCodexHookConfigOverrides, buildCodexHooksConfig } from "../../../src/codex-hooks";
import { _resetLoggerForTests, type RuntimeDiagnosticLogSink, setRuntimeDiagnosticLogSink } from "../../../src/core";
import { buildQuarterdeckHookCommandLine } from "../../../src/core/quarterdeck-command";
import { prepareAgentLaunch } from "../../../src/terminal";
import {
	HookHttpChannel,
	QUARTERDECK_HOOK_HTTP_TOKEN_ENV,
	setActiveHookHttpChannel,
} from "../../../src/terminal/hook-http-channel";
import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
	QUARTERDECK_PI_HOOK_HTTP_URL_ENV,
} from "../../../src/terminal/pi-lifecycle-extension";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const buildWorktreeContextPromptMock = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../../../src/terminal/worktree-context.js", () => ({
	buildWorktreeContextPrompt: buildWorktreeContextPromptMock,
}));

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;
const originalQuarterdeckStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalAnthropicBedrockBaseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAwsEndpointUrlBedrockRuntime = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
const originalAwsBearerTokenBedrock = process.env.AWS_BEARER_TOKEN_BEDROCK;
const originalAwsRegion = process.env.AWS_REGION;
const codexSessionFlagsConfigSource =
	process.platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
type LogCandidate = Parameters<RuntimeDiagnosticLogSink["recordLog"]>[0];

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "quarterdeck-agent-adapters-"));
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	delete process.env.QUARTERDECK_STATE_HOME;
	return tempHome;
}

function claudeHookCommand(event: string, options: { reliable?: boolean } = {}): string {
	const subcommand = options.reliable || event !== "activity" ? "ingest" : "notify";
	return buildQuarterdeckHookCommandLine(["hooks", subcommand, "--event", event, "--source", "claude"]);
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg?.startsWith("-c=") && arg.slice("-c=".length).startsWith(`${key}=`)) {
			values.push(arg.slice("-c=".length + key.length + 1));
			continue;
		}
		if (arg?.startsWith("--config=") && arg.slice("--config=".length).startsWith(`${key}=`)) {
			values.push(arg.slice("--config=".length + key.length + 1));
		}
	}
	return values;
}

afterEach(() => {
	_resetLoggerForTests();
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
	if (originalQuarterdeckStateHome === undefined) {
		delete process.env.QUARTERDECK_STATE_HOME;
	} else {
		process.env.QUARTERDECK_STATE_HOME = originalQuarterdeckStateHome;
	}
	if (originalAnthropicBedrockBaseUrl === undefined) {
		delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
	} else {
		process.env.ANTHROPIC_BEDROCK_BASE_URL = originalAnthropicBedrockBaseUrl;
	}
	if (originalAnthropicAuthToken === undefined) {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
	}
	if (originalAwsEndpointUrlBedrockRuntime === undefined) {
		delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	} else {
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = originalAwsEndpointUrlBedrockRuntime;
	}
	if (originalAwsBearerTokenBedrock === undefined) {
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	} else {
		process.env.AWS_BEARER_TOKEN_BEDROCK = originalAwsBearerTokenBedrock;
	}
	if (originalAwsRegion === undefined) {
		delete process.env.AWS_REGION;
	} else {
		process.env.AWS_REGION = originalAwsRegion;
	}
});

describe("prepareAgentLaunch hook strategies", () => {
	it("keeps launch diagnostics free of prompts, paths, arguments, binaries, and provider session ids", async () => {
		const home = setupTempHome();
		const cwd = join(home, "sentinel-private-worktree");
		mkdirSync(cwd, { recursive: true });
		const candidates: LogCandidate[] = [];
		setRuntimeDiagnosticLogSink({ recordLog: (candidate) => candidates.push(candidate) });

		for (const agentId of ["claude", "codex"] as const) {
			await prepareAgentLaunch({
				taskId: `task-${agentId}`,
				agentId,
				binary: "sentinel-private-binary",
				args: ["--sentinel-private-argument"],
				cwd,
				projectPath: join(home, "sentinel-private-project"),
				prompt: "sentinel-private-prompt",
				resumeConversation: true,
				resumeSessionId: "sentinel-private-provider-session",
				projectId: "project-1",
				hookSessionInstanceId: "process-1",
			});
		}

		expect(JSON.stringify(candidates)).not.toContain("sentinel-private");
		expect(candidates).toContainEqual(
			expect.objectContaining({
				tag: "agent-launch",
				message: "codex adapter prepared launch",
				data: expect.objectContaining({ hasResumeSessionId: true, codexArgCount: expect.any(Number) }),
			}),
		);
		expect(candidates).toContainEqual(
			expect.objectContaining({
				tag: "agent-launch",
				message: "claude adapter prepared launch",
				data: expect.objectContaining({ resumeConversation: true, argCount: expect.any(Number) }),
			}),
		);
	});

	it("applies starting Codex choices over configured defaults before the prompt", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "starting-options",
			agentId: "codex",
			binary: "codex",
			cwd: "/tmp",
			prompt: "--test prompt",
			args: ["-m", "old", "--model=older", "-c", 'model="configured"', "--config=model_reasoning_effort=low"],
			codexOptions: { model: "test-model", reasoningEffort: "high" },
		});
		expect(launch.args).toContain("--model");
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("test-model");
		expect(launch.args).not.toContain("old");
		expect(launch.args).not.toContain("--model=older");
		expect(getCodexConfigOverrideValues(launch.args, "model")).toEqual([]);
		expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual(['"high"']);
		expect(launch.args.slice(-2)).toEqual(["--", "--test prompt"]);
	});

	it.each(["resume", "fork", "managed resume"])("does not reapply starting choices to %s", async (mode) => {
		const launch = await prepareAgentLaunch({
			taskId: "resume-options",
			agentId: "codex",
			binary: "codex",
			cwd: "/tmp",
			prompt: "",
			args: mode === "managed resume" ? [] : [mode, "session-id"],
			resumeConversation: mode === "managed resume",
			resumeSessionId: "session-id",
			codexOptions: { model: "test-model", reasoningEffort: "high" },
		});
		expect(launch.args).not.toContain("test-model");
		expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual([]);
	});

	it("inherits configured Codex model and effort when starting choices are unset", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "inherit-options",
			agentId: "codex",
			binary: "codex",
			cwd: "/tmp",
			prompt: "",
			args: ["--model", "configured", "-c", 'model_reasoning_effort="medium"'],
		});
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("configured");
		expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual(['"medium"']);
	});

	it("launches codex directly without implicitly writing hook files", async () => {
		const home = setupTempHome();
		const repoPath = join(home, "repo");
		mkdirSync(repoPath, { recursive: true });
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: repoPath,
			prompt: "",
			projectId: "project-1",
			hookSessionInstanceId: "process-1",
		});

		expect(launch.env.QUARTERDECK_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.QUARTERDECK_HOOK_PROJECT_ID).toBe("project-1");
		expect(launch.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID).toBe("process-1");
		expect(launch.binary).toBe("codex");
		expect(launch.detectOutputTransition).toEqual(expect.any(Function));
		expect(launch.shouldInspectOutputForTransition).toEqual(expect.any(Function));
		expect(launch.resetOutputTransitionDetection).toEqual(expect.any(Function));
		expect(
			launch.shouldInspectOutputForTransition?.(
				createTestTaskSessionSummary({ state: "running", agentId: "codex" }),
			),
		).toBe(true);
		expect(
			launch.shouldInspectOutputForTransition?.(
				createTestTaskSessionSummary({
					state: "awaiting_review",
					agentId: "codex",
					outstandingInteraction: {
						provider: "codex",
						kind: "permission",
						status: "waiting",
						requestEventName: "PermissionRequest",
						openedAt: 100,
						updatedAt: 100,
						responseSubmittedAt: null,
						responseKind: null,
						sessionInstanceId: "process-1",
						providerSessionId: "session-1",
						turnId: "turn-1",
						promptId: null,
						toolUseId: "tool-1",
						elicitationId: null,
						providerAgentId: null,
						toolName: "shell",
					},
				}),
			),
		).toBe(true);
		expect(
			launch.shouldInspectOutputForTransition?.(
				createTestTaskSessionSummary({
					state: "awaiting_review",
					agentId: "codex",
					outstandingInteraction: {
						provider: "codex",
						kind: "permission",
						status: "response_submitted",
						requestEventName: "RenderedApprovalOverlay",
						openedAt: 100,
						updatedAt: 110,
						responseSubmittedAt: 110,
						responseKind: "cancel",
						sessionInstanceId: "process-1",
						providerSessionId: null,
						turnId: null,
						promptId: null,
						toolUseId: null,
						elicitationId: null,
						providerAgentId: null,
						toolName: null,
					},
				}),
			),
		).toBe(true);
		expect(
			launch.shouldInspectOutputForTransition?.(
				createTestTaskSessionSummary({ state: "awaiting_review", agentId: "codex" }),
			),
		).toBe(false);
		expect(launch.args.slice(0, 2)).toEqual(["--enable", "hooks"]);
		const hookOverrideArgs = launch.args.slice(2);
		expect(hookOverrideArgs.length).toBe(Object.keys(buildCodexHooksConfig()).length * 2 + 11);
		expect(launch.args).toContain("--no-daemon");
		expect(hookOverrideArgs).toContain("-c");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.SessionStart=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.state=");
		expect(hookOverrideArgs.join("\n")).toContain(
			JSON.stringify(`${codexSessionFlagsConfigSource}:permission_request:0:0`),
		);
		expect(hookOverrideArgs.join("\n")).toContain("trusted_hash");
		expect(hookOverrideArgs.join("\n")).toContain("timeout = 5");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PostToolUse=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PermissionRequest=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PreCompact=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PostCompact=");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);

		const quarterdeckHooksPath = join(home, ".quarterdeck", "hooks", "codex", "hooks.json");
		const codexGlobalHooksPath = join(home, ".codex", "hooks.json");
		expect(existsSync(quarterdeckHooksPath)).toBe(false);
		expect(existsSync(codexGlobalHooksPath)).toBe(false);
		expect(existsSync(join(repoPath, ".codex", "hooks.json"))).toBe(false);
	});

	it("does not duplicate hooks enable flag when already configured", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-flags",
			agentId: "codex",
			binary: "codex",
			args: ["--enable", "hooks"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args.filter((arg) => arg === "--enable")).toHaveLength(1);
		expect(launch.args.filter((arg) => arg === "hooks")).toHaveLength(1);
		expect(launch.args.join("\n")).not.toContain("hooks.SessionStart=");
	});

	it("routes approvals through Codex auto-review before resume while preserving human approval hooks", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-auto-review",
			agentId: "codex",
			binary: "codex",
			args: ["--yolo", "-c", 'approvals_reviewer="user"', "resume", "session-123"],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
			codexApprovalsReviewer: "auto_review",
		});

		expect(launch.args.filter((arg) => arg === "--approve-for-me")).toHaveLength(1);
		expect(launch.args.indexOf("--approve-for-me")).toBeLessThan(launch.args.indexOf("resume"));
		expect(launch.args).not.toContain("--yolo");
		expect(getCodexConfigOverrideValues(launch.args, "approvals_reviewer")).toEqual([]);
		const expectedPermissionRequestOverride = buildCodexHookConfigOverrides()
			.filter((_, index) => index % 2 === 1)
			.find((value) => value.startsWith("hooks.PermissionRequest="));
		expect(getCodexConfigOverrideValues(launch.args, "hooks.PermissionRequest")[0]).toBe(
			expectedPermissionRequestOverride?.slice("hooks.PermissionRequest=".length),
		);
		expect(launch.args.join("\n")).toContain(
			JSON.stringify(`${codexSessionFlagsConfigSource}:permission_request:0:0`),
		);
	});

	it("does not duplicate an explicit Codex approve-for-me option", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-auto-review-explicit",
			agentId: "codex",
			binary: "codex",
			args: ["--approve-for-me"],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "auto_review",
		});

		expect(launch.args.filter((arg) => arg === "--approve-for-me")).toHaveLength(1);
	});

	it("recognizes the Codex not-so-yolo alias as an explicit auto-review option", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-auto-review-alias",
			agentId: "codex",
			binary: "codex",
			args: ["--not-so-yolo"],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "auto_review",
		});

		expect(launch.args).toContain("--not-so-yolo");
		expect(launch.args).not.toContain("--approve-for-me");
	});

	it("dangerously bypasses Codex approvals and sandboxing before resume and removes reviewer overrides", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-dangerously-bypass",
			agentId: "codex",
			binary: "codex",
			args: ["--approve-for-me", "--not-so-yolo", "-c", 'approvals_reviewer="user"', "resume", "session-123"],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "dangerously_bypass",
		});

		expect(launch.args.filter((arg) => arg === "--dangerously-bypass-approvals-and-sandbox")).toHaveLength(1);
		expect(launch.args.indexOf("--dangerously-bypass-approvals-and-sandbox")).toBeLessThan(
			launch.args.indexOf("resume"),
		);
		expect(launch.args).not.toContain("--approve-for-me");
		expect(launch.args).not.toContain("--not-so-yolo");
		expect(getCodexConfigOverrideValues(launch.args, "approvals_reviewer")).toEqual([]);
	});

	it("does not duplicate the explicit Codex dangerous bypass option", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-dangerously-bypass-explicit",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "dangerously_bypass",
		});

		expect(launch.args.filter((arg) => arg === "--dangerously-bypass-approvals-and-sandbox")).toHaveLength(1);
	});

	it("recognizes the explicit Codex --yolo compatibility alias", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-dangerously-bypass-alias",
			agentId: "codex",
			binary: "codex",
			args: ["--yolo"],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "dangerously_bypass",
		});

		expect(launch.args).toContain("--yolo");
		expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("forces human review when Ask me is selected", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-user-review",
			agentId: "codex",
			binary: "codex",
			args: [
				"--approve-for-me",
				"--not-so-yolo",
				"--dangerously-bypass-approvals-and-sandbox",
				"--yolo",
				"-c",
				'approvals_reviewer="auto_review"',
			],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "user",
		});

		expect(launch.args).not.toContain("--approve-for-me");
		expect(launch.args).not.toContain("--not-so-yolo");
		expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(launch.args).not.toContain("--yolo");
		expect(getCodexConfigOverrideValues(launch.args, "approvals_reviewer")).toEqual(['"user"']);
	});

	it("leaves the reviewer unset when Codex configuration is inherited", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-inherit-reviewer",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			codexApprovalsReviewer: "inherit",
		});

		expect(launch.args).not.toContain("--approve-for-me");
		expect(getCodexConfigOverrideValues(launch.args, "approvals_reviewer")).toEqual([]);
	});

	it.each(["start", "resume", "fork"])("enforces fullscreen without a daemon for Codex %s launches", async (mode) => {
		setupTempHome();
		const args = [
			"--no-alt-screen",
			"--no-daemon",
			"--no-daemon",
			"-c",
			"tui.fullscreen_transcript=false",
			"--config",
			'tui.alternate_screen="never"',
			"-c=tui.raw_output_mode=true",
			"--config=tui.fullscreen_transcript=false",
			...(mode === "start" ? [] : [mode, "session-1"]),
		];
		const originalArgs = [...args];
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fullscreen",
			agentId: "codex",
			binary: "codex",
			args,
			cwd: "/tmp",
			prompt: "--no-alt-screen",
		});

		const optionEnd = mode === "start" ? launch.args.indexOf("--") : launch.args.indexOf(mode);
		const options = launch.args.slice(0, optionEnd);
		expect(options).not.toContain("--no-alt-screen");
		expect(options.filter((arg) => arg === "--no-daemon")).toHaveLength(1);
		expect(getCodexConfigOverrideValues(options, "tui.fullscreen_transcript")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(options, "tui.alternate_screen")).toEqual(['"always"']);
		expect(getCodexConfigOverrideValues(options, "tui.raw_output_mode")).toEqual(["false"]);
		expect(launch.args.slice(optionEnd)).toEqual([
			...(mode === "start" ? [] : [mode, "session-1"]),
			"--",
			"--no-alt-screen",
		]);
		expect(args).toEqual(originalArgs);
	});

	it("disables Codex startup update checks for Quarterdeck-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex startup update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-updates",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
		});

		const settingsPath = join(homedir(), ".quarterdeck", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ReturnType<typeof buildClaudeHooksSettings>;
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.SessionStart).toBeDefined();
		expect(settings.hooks?.Stop).toBeDefined();
		expect(settings.hooks?.StopFailure).toBeDefined();
		expect(settings.hooks?.SubagentStart).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
		expect(settings.hooks?.PreCompact).toBeDefined();
		expect(settings.hooks?.PostCompact).toBeDefined();
		const commands = Object.values(settings.hooks).flatMap((groups) =>
			groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
		);
		expect(commands).toContain(claudeHookCommand("activity"));
		expect(commands).toContain(claudeHookCommand("to_review"));
		expect(commands).toContain(claudeHookCommand("to_in_progress"));
		expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(claudeHookCommand("activity", { reliable: true }));
	});

	it("delivers Claude best-effort hooks to the published runtime endpoint with a launch-scoped credential", async () => {
		setupTempHome();
		const channel = new HookHttpChannel();
		channel.publishEndpoint("http://127.0.0.1:43123");
		setActiveHookHttpChannel(channel);
		vi.stubEnv("NO_PROXY", undefined);
		vi.stubEnv("no_proxy", undefined);
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-http",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp",
				prompt: "",
				projectId: "project-1",
				hookSessionInstanceId: "instance-http",
				env: { NO_PROXY: "corp.example", HTTPS_PROXY: "http://proxy.example:8080" },
			});

			// An inherited proxy must not intercept the loopback hook POST; existing bypasses are kept.
			expect(launch.env.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
			expect(launch.env.no_proxy).toBe("corp.example,127.0.0.1,localhost,::1");

			const hooksDirectory = join(homedir(), ".quarterdeck", "hooks", "claude");
			const settingsPath = join(hooksDirectory, "settings-http.json");
			expect(launch.args[launch.args.indexOf("--settings") + 1]).toBe(settingsPath);
			expect(existsSync(join(hooksDirectory, "settings.json"))).toBe(false);
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeHooksSettings<ClaudeHookHandler>;
			const transport = channel.prepareLaunch({ taskId: "task-http", projectId: "project-1" })?.transport;
			if (!transport) throw new Error("Expected a published hook HTTP channel.");
			expect(settings).toEqual(buildClaudeHttpHooksSettings({ httpNotify: transport }));
			expect(settings.hooks.SubagentStart[0]?.hooks[0]?.type).toBe("http");
			expect(settings.hooks.SubagentStop[0]?.hooks[0]?.type).toBe("command");
			expect(settings.hooks.PostToolUse[0]?.hooks[0]).toEqual({
				type: "command",
				command: claudeHookCommand("to_in_progress"),
				timeout: CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS,
			});

			const credential = launch.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV];
			expect(launch.env).toMatchObject({
				QUARTERDECK_HOOK_TASK_ID: "task-http",
				QUARTERDECK_HOOK_PROJECT_ID: "project-1",
				QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "instance-http",
			});
			expect(
				channel.verifyCredential(
					{ taskId: "task-http", projectId: "project-1", sessionInstanceId: "instance-http" },
					credential,
				),
			).toBe(true);
		} finally {
			setActiveHookHttpChannel(null);
			vi.unstubAllEnvs();
		}
	});

	it("falls back to Claude command hooks without a published runtime endpoint", async () => {
		setupTempHome();
		const channel = new HookHttpChannel();
		setActiveHookHttpChannel(channel);
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-command",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp",
				prompt: "",
				projectId: "project-1",
				hookSessionInstanceId: "instance-command",
			});

			const settingsPath = join(homedir(), ".quarterdeck", "hooks", "claude", "settings.json");
			expect(launch.args[launch.args.indexOf("--settings") + 1]).toBe(settingsPath);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(buildClaudeHooksSettings());
			expect(launch.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV]).toBeUndefined();
			expect(launch.env.NO_PROXY).toBeUndefined();
		} finally {
			setActiveHookHttpChannel(null);
		}
	});

	it("keeps Claude SessionStart reliable so session ids are not best-effort", () => {
		const settings = buildClaudeHooksSettings();
		expect(settings.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear|compact|fork");
		expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(claudeHookCommand("activity", { reliable: true }));
		expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).not.toBe(claudeHookCommand("activity"));
	});

	it("never includes a Quarterdeck-generated status line in Claude settings", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-claude-statusline-removed",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
		});

		const settingsPath = join(homedir(), ".quarterdeck", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			statusLine?: unknown;
		};
		expect(settings.statusLine).toBeUndefined();
	});

	it("normalizes conflicting Claude permission arguments to the managed launch mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-permissions-managed",
			agentId: "claude",
			binary: "claude",
			args: [
				"--permission-mode",
				"plan",
				"--permission-mode=auto",
				"--dangerously-skip-permissions",
				"--allow-dangerously-skip-permissions",
				"--",
				"--permission-mode",
				"prompt text that must remain",
			],
			cwd: "/tmp",
			prompt: "",
			claudeLaunchPermissionMode: "acceptEdits",
		});

		expect(launch.args).toEqual([
			"--permission-mode",
			"acceptEdits",
			"--",
			"--permission-mode",
			"prompt text that must remain",
		]);
	});

	it("translates the configured default permission mode to Claude's current manual CLI spelling", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-permissions-default",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			claudeLaunchPermissionMode: "default",
		});

		expect(launch.args).toEqual(["--permission-mode", "manual"]);
	});

	it("preserves Claude's configured permission arguments when inheritance is selected", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-permissions-inherit",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "plan", "--allow-dangerously-skip-permissions"],
			cwd: "/tmp",
			prompt: "",
			claudeLaunchPermissionMode: "inherit",
		});

		expect(launch.args).toEqual(["--permission-mode", "plan", "--allow-dangerously-skip-permissions"]);
	});

	it("enables Claude fullscreen rendering through the launch environment", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fullscreen-enabled",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0" },
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe("1");
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("0");
		expect(launch.env.CLAUDE_CODE_SCROLL_SPEED).toBe("3");
	});

	it("preserves an explicit Claude fullscreen scroll speed", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fullscreen-scroll-speed",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			env: {
				CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0",
				CLAUDE_CODE_SCROLL_SPEED: "8",
			},
		});

		expect(launch.env.CLAUDE_CODE_SCROLL_SPEED).toBe("8");
	});

	it("overrides Claude's classic-renderer environment at launch", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fullscreen-escape-hatch",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe("1");
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("0");
	});

	it.each([
		{ args: ["--ax-screen-reader"], env: {} },
		{ args: [], env: { CLAUDE_AX_SCREEN_READER: "1" } },
	])("rejects screen-reader launches that require classic rendering", async ({ args, env }) => {
		setupTempHome();
		await expect(
			prepareAgentLaunch({
				taskId: "task-claude-screen-reader",
				agentId: "claude",
				args,
				cwd: "/tmp",
				prompt: "",
				env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0", ...env },
			}),
		).rejects.toThrow("Quarterdeck requires Claude fullscreen rendering");
	});

	it("does not apply the Claude fullscreen environment to other agents", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fullscreen-ignored",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBeUndefined();
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
	});

	it("registers reliable Claude input-wait and resolution hooks", () => {
		const settings = buildClaudeHooksSettings();
		expect(settings.hooks.PreToolUse[0]?.matcher).toBe("*");
		expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(claudeHookCommand("to_in_progress"));
		expect(settings.hooks.Notification).toHaveLength(1);
		expect(settings.hooks.Notification[0]?.matcher).toBe("*");
		expect(settings.hooks.Notification[0]?.hooks[0]?.command).toBe(claudeHookCommand("activity"));
		expect(settings.hooks.Elicitation[0]?.hooks[0]?.command).toBe(claudeHookCommand("to_review"));
		expect(settings.hooks.ElicitationResult[0]?.hooks[0]?.command).toBe(claudeHookCommand("to_in_progress"));
		expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(claudeHookCommand("to_review"));
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("materializes Windows-unsafe image names through a bounded safe filename", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images-unsafe-name",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect it",
			images: [
				{
					id: "img-unsafe",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: `${"x".repeat(300)}.bad?`,
				},
				{
					id: "img-trailing-dot",
					data: Buffer.from("second").toString("base64"),
					mimeType: "image/png",
					name: "..",
				},
				{
					id: "img-truncated-dot",
					data: Buffer.from("third").toString("base64"),
					mimeType: "application/octet-stream",
					name: `${"x".repeat(79)}.${"y".repeat(20)}.extension-too-long`,
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		const imagePath = initialPrompt.match(/1\. (.+?) \(/)?.[1] ?? "";
		expect(imagePath).not.toContain("?");
		expect(imagePath.split(/[\\/]/u).at(-1)?.length).toBeLessThanOrEqual(255);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
		const trailingDotImagePath = initialPrompt.match(/2\. (.+?) \(\.\.\)/)?.[1] ?? "";
		expect(trailingDotImagePath.split(/[\\/]/u).at(-1)).toBe("02-image.png");
		expect(readFileSync(trailingDotImagePath).toString("utf8")).toBe("second");
		const truncatedDotImagePath = initialPrompt.match(/3\. (.+?) \(/)?.[1] ?? "";
		expect(truncatedDotImagePath.split(/[\\/]/u).at(-1)).toBe(`03-${"x".repeat(79)}`);
		expect(readFileSync(truncatedDotImagePath).toString("utf8")).toBe("third");
	});

	it("uses a stored Codex session id for resume when available", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
		});

		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "019d6fa0-db65-7f83-9531-35df54674d76"]));
		expect(codexLaunch.args).not.toContain("--last");
	});

	it("falls back to --last when no Codex session id is stored", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));
	});

	it("separates regular Codex prompts from options", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-regular-prompt",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Investigate this failure",
		});

		expect(launch.args.at(-2)).toBe("--");
		expect(launch.args.at(-1)).toBe("Investigate this failure");
	});

	it("separates Codex prompts that look like options", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-dash-prompt",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "- investigate this failure",
		});

		expect(launch.args.at(-2)).toBe("--");
		expect(launch.args.at(-1)).toBe("- investigate this failure");
	});

	it("separates Codex resume prompts that look like options", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-dash-prompt",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "- continue after restart",
			resumeConversation: true,
			resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
		});

		expect(launch.args).toEqual(expect.arrayContaining(["resume", "019d6fa0-db65-7f83-9531-35df54674d76"]));
		expect(launch.args.at(-2)).toBe("--");
		expect(launch.args.at(-1)).toBe("- continue after restart");
	});

	it("places Codex global config before the resume subcommand", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValueOnce("Worktree context");

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "- continue after restart",
			projectId: "project-1",
			projectPath: "/repo",
			resumeConversation: true,
			resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		expect(launch.args.indexOf("--no-daemon")).toBeGreaterThan(-1);
		expect(launch.args.indexOf("--no-daemon")).toBeLessThan(resumeIndex);
		expect(launch.args.slice(resumeIndex, resumeIndex + 2)).toEqual([
			"resume",
			"019d6fa0-db65-7f83-9531-35df54674d76",
		]);
		const enableIndex = launch.args.indexOf("--enable");
		expect(enableIndex).toBeGreaterThan(-1);
		expect(enableIndex).toBeLessThan(resumeIndex);
		for (const key of [
			"hooks.state",
			"hooks.SessionStart",
			"hooks.PostToolUse",
			"hooks.PermissionRequest",
			"hooks.PreCompact",
			"hooks.PostCompact",
			"check_for_update_on_startup",
			"tui.fullscreen_transcript",
			"tui.alternate_screen",
			"tui.raw_output_mode",
			"developer_instructions",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
		expect(launch.args.at(-2)).toBe("--");
		expect(launch.args.at(-1)).toBe("- continue after restart");
	});

	it("uses a stored Claude session id for resume when available", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
		});

		expect(claudeLaunch.args).toEqual(expect.arrayContaining(["--resume", "019d6fa0-db65-7f83-9531-35df54674d76"]));
		expect(claudeLaunch.args).not.toContain("--continue");
	});

	it("falls back to Claude continue flags for legacy resume without a stored session id", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
		});
		expect(claudeLaunch.args).toContain("--continue");
	});

	it("launches Pi through the configured system CLI without bundled environment aliases", async () => {
		setupTempHome();
		process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock.example.test";
		process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-token";
		delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		delete process.env.AWS_REGION;

		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "Try the Pi TUI",
		});

		expect(launch.binary).toBe("pi");
		expect(launch.args).toEqual(["--", "Try the Pi TUI"]);
		expect(launch.env.PI_OFFLINE).toBeUndefined();
		expect(launch.env.PI_CODING_AGENT_DIR).toBeUndefined();
		expect(launch.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined();
		expect(launch.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		expect(launch.env.AWS_REGION).toBeUndefined();
	});

	it("loads the Quarterdeck Pi lifecycle extension when hook context is available", async () => {
		const tempHomePath = setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "Try the Pi TUI",
			projectId: "project-1",
		});

		const extensionPath = join(tempHomePath, ".quarterdeck", "hooks", "pi", "quarterdeck-lifecycle.js");
		expect(launch.args).toEqual(["--extension", extensionPath, "--", "Try the Pi TUI"]);
		expect(launch.env.QUARTERDECK_HOOK_TASK_ID).toBe("task-pi");
		expect(launch.env.QUARTERDECK_HOOK_PROJECT_ID).toBe("project-1");
		const hookCommand = JSON.parse(launch.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] ?? "[]") as string[];
		expect(hookCommand).toEqual(expect.arrayContaining(["hooks", "notify"]));
		const extensionSource = readFileSync(extensionPath, "utf8");
		expect(extensionSource).toBe(buildPiLifecycleExtensionSource());
		expect(extensionSource).toContain('pi.on("agent_end"');
		expect(extensionSource).toContain('pi.on("agent_settled"');
		expect(extensionSource).toContain('pi.on("agent_start"');
		expect(extensionSource).not.toContain('pi.on("tool_call"');
		expect(extensionSource).toContain('pi.on("project_trust"');
		expect(extensionSource).not.toContain("PermissionRequest");
		expect(extensionSource).toContain("enqueueDurableHook");
		expect(extensionSource).toContain("detached: !waitForExit");
		expect(extensionSource).toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(extensionSource).not.toContain("\\${");
		expect(launch.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV]).toBeUndefined();
	});

	it("publishes the runtime HTTP hook URL and credential to a Pi launch when a channel is active", async () => {
		setupTempHome();
		const channel = new HookHttpChannel();
		channel.publishEndpoint("http://127.0.0.1:43124");
		setActiveHookHttpChannel(channel);
		vi.stubEnv("NO_PROXY", undefined);
		vi.stubEnv("no_proxy", undefined);
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-pi-http",
				agentId: "pi",
				binary: "pi",
				args: [],
				cwd: "/tmp",
				prompt: "",
				projectId: "project-1",
				hookSessionInstanceId: "instance-pi-http",
				env: { NO_PROXY: "corp.example", HTTPS_PROXY: "http://proxy.example:8080" },
			});

			const transport = channel.prepareLaunch({ taskId: "task-pi-http", projectId: "project-1" })?.transport;
			if (!transport) throw new Error("Expected a published hook HTTP channel.");
			expect(launch.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV]).toBe(transport.url);
			expect(launch.env.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
			expect(launch.env.no_proxy).toBe("corp.example,127.0.0.1,localhost,::1");
			expect(launch.env).toMatchObject({
				QUARTERDECK_HOOK_TASK_ID: "task-pi-http",
				QUARTERDECK_HOOK_PROJECT_ID: "project-1",
				QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "instance-pi-http",
			});
			const credential = launch.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV];
			expect(
				channel.verifyCredential(
					{ taskId: "task-pi-http", projectId: "project-1", sessionInstanceId: "instance-pi-http" },
					credential,
				),
			).toBe(true);
			// The CLI fallback command stays configured even with a published
			// channel: a session outliving its runtime still needs it.
			const hookCommand = JSON.parse(launch.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] ?? "[]") as string[];
			expect(hookCommand).toEqual(expect.arrayContaining(["hooks", "notify"]));
		} finally {
			setActiveHookHttpChannel(null);
			vi.unstubAllEnvs();
		}
	});

	it("omits the Pi HTTP hook URL and credential without a published runtime endpoint", async () => {
		setupTempHome();
		const channel = new HookHttpChannel();
		setActiveHookHttpChannel(channel);
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-pi-command",
				agentId: "pi",
				binary: "pi",
				args: [],
				cwd: "/tmp",
				prompt: "",
				projectId: "project-1",
				hookSessionInstanceId: "instance-pi-command",
			});

			expect(launch.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV]).toBeUndefined();
			expect(launch.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV]).toBeUndefined();
			expect(launch.env.NO_PROXY).toBeUndefined();
		} finally {
			setActiveHookHttpChannel(null);
		}
	});

	it("uses a stored Pi session id for resume when available", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "Continue the task",
			resumeConversation: true,
			resumeSessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
		});

		expect(launch.args).toEqual(["--session", "019d6fa0-db65-7f83-9531-35df54674d76", "--", "Continue the task"]);
		expect(launch.args).not.toContain("--continue");
	});

	it.each([
		["--session", "other-session", "--continue"],
		["--session=other-session", "-c"],
		["--resume"],
		["-r"],
		["--fork", "other-session", "--session-id", "new-session"],
		["--no-session"],
	])("preserves exact Pi resume identity over custom selectors %j", async (...args) => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: ["--model", "sonnet", ...args],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "stored-session",
		});
		expect(launch.args).toEqual(["--model", "sonnet", "--session", "stored-session"]);
	});

	it("falls back to Pi --continue when no stored session id is available", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeConversation: true,
		});

		expect(launch.args).toEqual(["--continue"]);
	});

	it("inserts managed Pi options before a custom argument separator", async () => {
		const tempHomePath = setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: ["--model", "sonnet", "--", "--literal"],
			cwd: "/tmp",
			prompt: "Continue",
			projectId: "project-1",
			resumeConversation: true,
			resumeSessionId: "stored-session",
		});
		expect(launch.args).toEqual([
			"--model",
			"sonnet",
			"--session",
			"stored-session",
			"--extension",
			join(tempHomePath, ".quarterdeck", "hooks", "pi", "quarterdeck-lifecycle.js"),
			"--",
			"--literal",
			"Continue",
		]);
	});

	it("passes a dash-prefixed Pi task prompt as text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "--version is failing; investigate",
		});
		expect(launch.args).toEqual(["--", "--version is failing; investigate"]);
	});

	it("preserves custom Pi args without forcing extension suppression", async () => {
		setupTempHome();

		const launch = await prepareAgentLaunch({
			taskId: "task-pi",
			agentId: "pi",
			binary: "pi",
			args: ["--model", "sonnet"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.binary).toBe("pi");
		expect(launch.args).toEqual(["--model", "sonnet"]);
	});
});

describe("worktree context system prompt", () => {
	afterEach(() => {
		buildWorktreeContextPromptMock.mockReset().mockResolvedValue("");
	});

	it("injects --append-system-prompt when context builder returns content", async () => {
		setupTempHome();
		const contextText = "You are working in a git worktree.\n- Your working directory is /worktree.";
		buildWorktreeContextPromptMock.mockResolvedValue(contextText);

		const launch = await prepareAgentLaunch({
			taskId: "task-wt",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/worktree",
			prompt: "Fix the bug",
			projectId: "ws-1",
			projectPath: "/repo",
		});

		expect(launch.args).toContain("--append-system-prompt");
		const flagIndex = launch.args.indexOf("--append-system-prompt");
		expect(launch.args[flagIndex + 1]).toBe(contextText);

		// --append-system-prompt must appear before "--" separator
		const separatorIndex = launch.args.indexOf("--");
		expect(separatorIndex).toBeGreaterThan(flagIndex);
	});

	it("does not grant extra directories to Claude worktree launches", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValue("Worktree context");

		const launch = await prepareAgentLaunch({
			taskId: "task-no-add-dir",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/repo/.quarterdeck/worktrees/task-no-add-dir",
			prompt: "Fix the bug",
			projectId: "ws-1",
			projectPath: "/repo",
		});

		expect(launch.args).not.toContain("--add-dir");
		expect(launch.args.join("\n")).not.toContain("/repo/.git");
	});

	it("does not inject --append-system-prompt when context builder returns empty", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValue("");

		const launch = await prepareAgentLaunch({
			taskId: "task-no-wt",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/repo",
			prompt: "Fix the bug",
			projectId: "ws-1",
			projectPath: "/repo",
		});

		expect(launch.args).not.toContain("--append-system-prompt");
	});

	it("skips injection when --append-system-prompt is already present", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValue("Should not appear");

		const launch = await prepareAgentLaunch({
			taskId: "task-existing",
			agentId: "claude",
			binary: "claude",
			args: ["--append-system-prompt", "Custom prompt"],
			cwd: "/worktree",
			prompt: "Fix the bug",
			projectId: "ws-1",
			projectPath: "/repo",
		});

		const matches = launch.args.filter((a) => a === "--append-system-prompt");
		expect(matches).toHaveLength(1);
		expect(launch.args[launch.args.indexOf("--append-system-prompt") + 1]).toBe("Custom prompt");
	});

	it("skips injection when --system-prompt is already present", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValue("Should not appear");

		const launch = await prepareAgentLaunch({
			taskId: "task-sys",
			agentId: "claude",
			binary: "claude",
			args: ["--system-prompt", "Full override"],
			cwd: "/worktree",
			prompt: "Fix the bug",
			projectId: "ws-1",
			projectPath: "/repo",
		});

		expect(launch.args).not.toContain("--append-system-prompt");
	});

	it("injects Codex worktree context as developer instructions", async () => {
		setupTempHome();
		const contextText = "You are working in a git worktree.\n- Your working directory is /worktree.";
		buildWorktreeContextPromptMock.mockResolvedValue(contextText);

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-wt",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/worktree",
			prompt: "Fix the bug",
			projectPath: "/repo",
		});

		const configArg = launch.args.find((arg) => arg.startsWith("developer_instructions="));
		expect(configArg).toBe(`developer_instructions=${JSON.stringify(contextText)}`);
		expect(launch.args[launch.args.indexOf(configArg ?? "") - 1]).toBe("-c");
		expect(launch.args.at(-1)).toBe("Fix the bug");
	});

	it("skips Codex worktree context when developer instructions are already configured", async () => {
		setupTempHome();
		buildWorktreeContextPromptMock.mockResolvedValue("Should not appear");

		const launch = await prepareAgentLaunch({
			taskId: "task-codex-existing-dev",
			agentId: "codex",
			binary: "codex",
			args: ["-c", 'developer_instructions="Custom prompt"'],
			cwd: "/worktree",
			prompt: "Fix the bug",
			projectPath: "/repo",
		});

		const configArgs = launch.args.filter((arg) => arg.startsWith("developer_instructions="));
		expect(configArgs).toEqual(['developer_instructions="Custom prompt"']);
		expect(launch.args.join("\n")).not.toContain("Should not appear");
	});
});

describe("Claude task model and effort options", () => {
	function optionValues(args: string[], optionName: string): string[] {
		const values: string[] = [];
		const terminatorIndex = args.indexOf("--");
		const optionArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
		optionArgs.forEach((arg, index) => {
			if (arg === optionName) values.push(optionArgs[index + 1] ?? "");
			else if (arg.startsWith(`${optionName}=`)) values.push(arg.slice(optionName.length + 1));
		});
		return values;
	}

	it("applies task model and effort before the prompt separator", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-options",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "--test prompt",
			claudeOptions: { model: "opus", effort: "xhigh" },
		});
		expect(optionValues(launch.args, "--model")).toEqual(["opus"]);
		expect(optionValues(launch.args, "--effort")).toEqual(["xhigh"]);
		expect(launch.args.slice(-2)).toEqual(["--", "--test prompt"]);
	});

	it("overrides configured model and effort args, leaving text after -- untouched", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-options-configured",
			agentId: "claude",
			binary: "claude",
			args: ["--model=sonnet", "--effort", "low", "--verbose", "--", "--model", "kept"],
			cwd: "/tmp",
			prompt: "",
			claudeOptions: { model: "opus", effort: "max" },
		});
		expect(optionValues(launch.args, "--model")).toEqual(["opus"]);
		expect(optionValues(launch.args, "--effort")).toEqual(["max"]);
		expect(launch.args).toContain("--verbose");
		expect(launch.args.slice(launch.args.indexOf("--"))).toEqual(["--", "--model", "kept"]);
	});

	it("inherits configured model and effort when task options are unset", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-options-inherit",
			agentId: "claude",
			binary: "claude",
			args: ["--model", "sonnet", "--effort=low"],
			cwd: "/tmp",
			prompt: "",
			claudeOptions: { effort: "high" },
		});
		expect(optionValues(launch.args, "--model")).toEqual(["sonnet"]);
		expect(optionValues(launch.args, "--effort")).toEqual(["high"]);
	});

	it("drops a persisted effort level the CLI does not know and keeps the configured effort", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-options-unknown-effort",
			agentId: "claude",
			binary: "claude",
			args: ["--effort", "low"],
			cwd: "/tmp",
			prompt: "",
			claudeOptions: { model: "opus", effort: "future_level" },
		});
		expect(optionValues(launch.args, "--model")).toEqual(["opus"]);
		expect(optionValues(launch.args, "--effort")).toEqual(["low"]);
		expect(launch.args).not.toContain("future_level");
	});

	// Unlike a Codex thread, a resumed Claude conversation does not keep its launch model.
	it.each([
		["managed resume", [] as string[], true],
		["configured --continue", ["--continue"], false],
	])("reapplies task options on %s", async (_mode, args, resumeConversation) => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-options-resume",
			agentId: "claude",
			binary: "claude",
			args,
			cwd: "/tmp",
			prompt: "",
			resumeConversation,
			resumeSessionId: "session-id",
			claudeOptions: { model: "opus", effort: "high" },
		});
		expect(optionValues(launch.args, "--model")).toEqual(["opus"]);
		expect(optionValues(launch.args, "--effort")).toEqual(["high"]);
		expect(launch.args.some((arg) => arg === "--resume" || arg === "--continue")).toBe(true);
	});
});

describe("Claude rendered interruption launch hooks", () => {
	it("inspects Claude output only after a bare Escape for the same launch", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-escape",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
			hookSessionInstanceId: "process-1",
		});
		const running = createTestTaskSessionSummary({
			state: "running",
			agentId: "claude",
			sessionInstanceId: "process-1",
		});

		expect(launch.shouldInspectOutputForTransition?.(running)).toBe(false);
		launch.observeBareEscapeInput?.(running, Date.now());
		expect(launch.shouldInspectOutputForTransition?.(running)).toBe(true);
		expect(
			launch.shouldInspectOutputForTransition?.(
				createTestTaskSessionSummary({ state: "running", agentId: "claude", sessionInstanceId: "process-2" }),
			),
		).toBe(false);
		launch.resetOutputTransitionDetection?.();
		expect(launch.shouldInspectOutputForTransition?.(running)).toBe(false);
	});
});

describe("Pi starting model options", () => {
	it("replaces conflicting model/provider/scope args only on fresh launches before the separator", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "pi-task",
			agentId: "pi",
			binary: "pi",
			cwd: process.cwd(),
			prompt: "-task prompt",
			args: [
				"--provider=old",
				"--provider",
				"other",
				"--model",
				"old-model",
				"--model=another",
				"--models",
				"scope*",
				"--thinking",
				"high",
				"--",
				"custom positional",
			],
			piOptions: { model: { provider: "local", id: "qwen:7b" } },
		});
		expect(launch.args).toEqual([
			"--thinking",
			"high",
			"--provider",
			"local",
			"--model",
			"qwen:7b",
			"--",
			"custom positional",
			"-task prompt",
		]);
	});
	it.each([undefined, {}])("inherits custom arguments when starting options are %j", async (piOptions) => {
		const launch = await prepareAgentLaunch({
			taskId: "pi-task",
			agentId: "pi",
			binary: "pi",
			cwd: process.cwd(),
			prompt: "",
			args: ["--provider", "configured", "--model", "configured-model"],
			piOptions,
		});
		expect(launch.args).toEqual(["--provider", "configured", "--model", "configured-model"]);
	});
	it.each([undefined, "exact-session-id"])(
		"does not reapply starting choices on resume (id=%s)",
		async (resumeSessionId) => {
			const launch = await prepareAgentLaunch({
				taskId: "pi-task",
				agentId: "pi",
				binary: "pi",
				cwd: process.cwd(),
				prompt: "",
				args: [],
				resumeConversation: true,
				resumeSessionId,
				piOptions: { model: { provider: "alpha", id: "original-starting-model" } },
			});
			expect(launch.args).toEqual(resumeSessionId ? ["--session", resumeSessionId] : ["--continue"]);
		},
	);
});
