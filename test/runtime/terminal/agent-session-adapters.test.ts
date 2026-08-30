import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeHooksSettings } from "../../../src/claude-hooks";
import { buildCodexHooksConfig } from "../../../src/codex-hooks";
import { _resetLoggerForTests, type RuntimeDiagnosticLogSink, setRuntimeDiagnosticLogSink } from "../../../src/core";
import { prepareAgentLaunch } from "../../../src/terminal";
import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
	QUARTERDECK_PI_TOOL_APPROVALS_ENV,
} from "../../../src/terminal/pi-lifecycle-extension";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const buildWorktreeContextPromptMock = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../../../src/terminal/worktree-context.js", () => ({
	buildWorktreeContextPrompt: buildWorktreeContextPromptMock,
}));

const originalHome = process.env.HOME;
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
	delete process.env.QUARTERDECK_STATE_HOME;
	return tempHome;
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
		expect(hookOverrideArgs.length).toBe(Object.keys(buildCodexHooksConfig()).length * 2 + 4);
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
		expect(getCodexConfigOverrideValues(launch.args, "hooks.PermissionRequest")[0]).toContain("to_review");
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
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
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
		const serializedSettings = JSON.stringify(settings);
		expect(serializedSettings).toContain("'notify' '--event' 'activity'");
		expect(serializedSettings).toContain("'ingest' '--event' 'to_review'");
		expect(serializedSettings).toContain("'ingest' '--event' 'to_in_progress'");
		expect(JSON.stringify(settings.hooks?.SessionStart)).toContain("'ingest' '--event' 'activity'");
	});

	it("keeps Claude SessionStart reliable so session ids are not best-effort", () => {
		const settings = buildClaudeHooksSettings();
		expect(settings.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear|compact|fork");
		expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toContain("'ingest' '--event' 'activity'");
		expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).not.toContain("'notify' '--event' 'activity'");
	});

	it("leaves the Quarterdeck Claude status line disabled unless explicitly enabled", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-claude-statusline-default",
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

	it("leaves Claude fullscreen rendering disabled unless explicitly enabled", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fullscreen-default",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe("0");
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("1");
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
			claudeFullscreenEnabled: true,
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0" },
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe("1");
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
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
			claudeFullscreenEnabled: true,
			env: {
				CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0",
				CLAUDE_CODE_SCROLL_SPEED: "8",
			},
		});

		expect(launch.env.CLAUDE_CODE_SCROLL_SPEED).toBe("8");
	});

	it("honors Claude's explicit classic-renderer escape hatch", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fullscreen-escape-hatch",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			claudeFullscreenEnabled: true,
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe("0");
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("1");
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
			claudeFullscreenEnabled: true,
		});

		expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBeUndefined();
		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
	});

	it("injects the Quarterdeck Claude status line when explicitly enabled", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-claude-statusline-enabled",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
			statuslineEnabled: true,
		});

		const settingsPath = join(homedir(), ".quarterdeck", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			statusLine?: { type?: string; command?: string };
		};
		expect(settings.statusLine?.type).toBe("command");
		expect(settings.statusLine?.command).toContain("statusline");
	});

	it("registers reliable Claude input-wait and resolution hooks", () => {
		const settings = buildClaudeHooksSettings();
		expect(settings.hooks.PreToolUse[0]?.matcher).toBe("*");
		expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("'ingest' '--event' 'to_in_progress'");
		expect(settings.hooks.Notification).toHaveLength(1);
		expect(settings.hooks.Notification[0]?.matcher).toBe("*");
		expect(settings.hooks.Notification[0]?.hooks[0]?.command).toContain("'notify' '--event' 'activity'");
		expect(settings.hooks.Elicitation[0]?.hooks[0]?.command).toContain("'ingest' '--event' 'to_review'");
		expect(settings.hooks.ElicitationResult[0]?.hooks[0]?.command).toContain("'ingest' '--event' 'to_in_progress'");
		expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain("'ingest' '--event' 'to_review'");
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
		expect(launch.args).toEqual(["Try the Pi TUI"]);
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
		expect(launch.args).toEqual(["--extension", extensionPath, "Try the Pi TUI"]);
		expect(launch.env.QUARTERDECK_HOOK_TASK_ID).toBe("task-pi");
		expect(launch.env.QUARTERDECK_HOOK_PROJECT_ID).toBe("project-1");
		const hookCommand = JSON.parse(launch.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] ?? "[]") as string[];
		expect(hookCommand).toEqual(expect.arrayContaining(["hooks", "notify"]));
		expect(launch.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV]).toBe("enabled");
		const extensionSource = readFileSync(extensionPath, "utf8");
		expect(extensionSource).toBe(buildPiLifecycleExtensionSource());
		expect(extensionSource).toContain('pi.on("agent_end"');
		expect(extensionSource).toContain('pi.on("agent_settled"');
		expect(extensionSource).toContain('pi.on("input"');
		expect(extensionSource).toContain('pi.on("tool_call"');
		expect(extensionSource).toContain("PermissionRequest");
		expect(extensionSource).toContain("enqueueDurableHook");
		expect(extensionSource).toContain("detached: !waitForExit");
		expect(extensionSource).toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(extensionSource).not.toContain("\\${");
	});

	it("disables Pi tool approvals through the launch environment", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-pi-unrestricted-tools",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/tmp",
			prompt: "Run the checks",
			projectId: "project-1",
			piToolApprovalsEnabled: false,
		});

		expect(launch.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV]).toBe("disabled");
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

		expect(launch.args).toEqual(["--session", "019d6fa0-db65-7f83-9531-35df54674d76", "Continue the task"]);
		expect(launch.args).not.toContain("--continue");
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
