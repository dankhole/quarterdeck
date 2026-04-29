import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCodexHooksConfig } from "../../../src/codex-hooks";
import { prepareAgentLaunch } from "../../../src/terminal";
import { QUARTERDECK_PI_HOOK_COMMAND_ENV } from "../../../src/terminal/pi-lifecycle-extension";

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

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "quarterdeck-agent-adapters-"));
	process.env.HOME = tempHome;
	delete process.env.QUARTERDECK_STATE_HOME;
	return tempHome;
}

afterEach(() => {
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
		});

		expect(launch.env.QUARTERDECK_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.QUARTERDECK_HOOK_PROJECT_ID).toBe("project-1");
		expect(launch.binary).toBe("codex");
		expect(launch.detectOutputTransition).toBeUndefined();
		expect(launch.shouldInspectOutputForTransition).toBeUndefined();
		expect(launch.args.slice(0, 2)).toEqual(["--enable", "codex_hooks"]);
		const hookOverrideArgs = launch.args.slice(2);
		expect(hookOverrideArgs.length).toBe(Object.keys(buildCodexHooksConfig()).length * 2);
		expect(hookOverrideArgs).toContain("-c");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.SessionStart=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PostToolUse=");
		expect(hookOverrideArgs.join("\n")).toContain("hooks.PermissionRequest=");

		const quarterdeckHooksPath = join(home, ".quarterdeck", "hooks", "codex", "hooks.json");
		const codexGlobalHooksPath = join(home, ".codex", "hooks.json");
		expect(existsSync(quarterdeckHooksPath)).toBe(false);
		expect(existsSync(codexGlobalHooksPath)).toBe(false);
		expect(existsSync(join(repoPath, ".codex", "hooks.json"))).toBe(false);
	});

	it("does not duplicate codex_hooks enable flag when already configured", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-flags",
			agentId: "codex",
			binary: "codex",
			args: ["--enable", "codex_hooks"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args.filter((arg) => arg === "--enable")).toHaveLength(1);
		expect(launch.args.filter((arg) => arg === "codex_hooks")).toHaveLength(1);
		expect(launch.args.join("\n")).not.toContain("hooks.SessionStart=");
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
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
		const serializedSettings = JSON.stringify(settings);
		expect(serializedSettings).toContain("'notify' '--event' 'activity'");
		expect(serializedSettings).toContain("'ingest' '--event' 'to_review'");
		expect(serializedSettings).toContain("'ingest' '--event' 'to_in_progress'");
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

	it("adds Claude continue flags for resume", async () => {
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
		const extensionSource = readFileSync(extensionPath, "utf8");
		expect(extensionSource).toContain('pi.on("agent_end"');
		expect(extensionSource).toContain('pi.on("input"');
		expect(extensionSource).toContain('pi.on("tool_call"');
		expect(extensionSource).toContain("PermissionRequest");
		expect(extensionSource).toContain("enqueueDurableHook");
		expect(extensionSource).toContain("detached: !waitForExit");
		expect(extensionSource).toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(extensionSource).not.toContain("\\${");
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
