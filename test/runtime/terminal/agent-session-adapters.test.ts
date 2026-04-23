import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareAgentLaunch } from "../../../src/terminal";

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

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "quarterdeck-agent-adapters-"));
	process.env.HOME = tempHome;
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
});

describe("prepareAgentLaunch hook strategies", () => {
	it("routes codex through hooks codex-wrapper command", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			projectId: "project-1",
		});

		expect(launch.env.QUARTERDECK_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.QUARTERDECK_HOOK_PROJECT_ID).toBe("project-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("hooks");
		expect(launchCommand).toContain("codex-wrapper");
		expect(launchCommand).toContain("--real-binary");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("--");

		const wrapperPath = join(homedir(), ".quarterdeck", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
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

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("adds resume flags for each agent", async () => {
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
});
