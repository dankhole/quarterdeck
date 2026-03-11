import { describe, expect, it } from "vitest";

import {
	buildTaskStartServicePromptContent,
	detectTaskStartServicePromptIds,
	getTaskStartServicePromptKey,
} from "@/hooks/use-task-start-service-prompts";

describe("detectTaskStartServicePromptIds", () => {
	it("detects linear links", () => {
		expect(detectTaskStartServicePromptIds("Use https://linear.app/factory/issue/ABC-123 for context")).toEqual([
			"linear_mcp",
		]);
	});

	it("detects plain linear mentions", () => {
		expect(detectTaskStartServicePromptIds("Please sync this with linear before starting")).toEqual(["linear_mcp"]);
	});

	it("detects linear ticket ids", () => {
		expect(detectTaskStartServicePromptIds("Please fix linear issue ABC-321 today")).toEqual(["linear_mcp"]);
	});

	it("does not detect generic ticket ids without linear context", () => {
		expect(detectTaskStartServicePromptIds("Please fix issue ABC-321 today")).toEqual([]);
	});

	it("detects github links", () => {
		expect(detectTaskStartServicePromptIds("See https://github.com/cline/kanban/issues/42")).toEqual([
			"github_cli",
		]);
	});

	it("detects plain github mentions", () => {
		expect(detectTaskStartServicePromptIds("Please check github for related PRs")).toEqual(["github_cli"]);
	});

	it("detects task creation prompts for kanban setup", () => {
		expect(detectTaskStartServicePromptIds("Please create a task for the crash report")).toEqual(["kanban_mcp"]);
	});

	it("detects add task without article", () => {
		expect(detectTaskStartServicePromptIds("please add task for onboarding")).toEqual(["kanban_mcp"]);
	});

	it("detects ticket and card creation prompts", () => {
		expect(detectTaskStartServicePromptIds("Can you make a ticket for this bug?")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("Create card for release blockers")).toEqual(["kanban_mcp"]);
	});

	it("detects numbered task creation", () => {
		expect(detectTaskStartServicePromptIds("create 3 tasks for the migration")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("add three tasks")).toEqual(["kanban_mcp"]);
	});

	it("detects break down into tasks", () => {
		expect(detectTaskStartServicePromptIds("break down into tasks")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("break this up into tasks")).toEqual(["kanban_mcp"]);
	});

	it("detects split/decompose/turn into tasks", () => {
		expect(detectTaskStartServicePromptIds("split this into tasks")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("decompose into tasks")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("turn this project into tasks")).toEqual(["kanban_mcp"]);
		expect(detectTaskStartServicePromptIds("convert this spec into tickets")).toEqual(["kanban_mcp"]);
	});

	it("detects start tasks", () => {
		expect(detectTaskStartServicePromptIds("start a task for the bug fix")).toEqual(["kanban_mcp"]);
	});

	it("does not trigger kanban for unrelated task mentions", () => {
		expect(detectTaskStartServicePromptIds("this is a difficult task")).toEqual([]);
		expect(detectTaskStartServicePromptIds("finish the remaining tasks")).toEqual([]);
	});

	it("detects both github and kanban when both present", () => {
		const result = detectTaskStartServicePromptIds("Make a task, then check github issue details");
		expect(result).toContain("kanban_mcp");
		expect(result).toContain("github_cli");
	});

	it("detects both linear and github when both present", () => {
		const result = detectTaskStartServicePromptIds(
			"Investigate https://github.com/cline/kanban/issues/42 and then check LINEAR-12",
		);
		expect(result).toContain("github_cli");
		expect(result).toContain("linear_mcp");
	});
});

describe("buildTaskStartServicePromptContent", () => {
	it("returns codex-specific linear install command", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp", {
			selectedAgentId: "codex",
		});
		expect(content.installCommand).toBe("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(content.learnMoreUrl).toBe("https://linear.app/docs/mcp");
	});

	it("returns droid-specific linear install command", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp", {
			selectedAgentId: "droid",
		});
		expect(content.installCommand).toBe("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("returns cline-specific linear install command", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp", {
			selectedAgentId: "cline",
		});
		expect(content.installCommand).toBe("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("returns gemini linear install command with user scope", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp", {
			selectedAgentId: "gemini",
		});
		expect(content.installCommand).toBe(
			"gemini mcp add linear https://mcp.linear.app/mcp --transport http --scope user",
		);
	});

	it("returns claude default linear install command", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp");
		expect(content.installCommand).toBe(
			"claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp",
		);
	});

	it("returns github mac install command", () => {
		const content = buildTaskStartServicePromptContent("github_cli", {
			platform: "mac",
		});
		expect(content.installCommand).toBe("brew install gh");
		expect(content.learnMoreUrl).toBe("https://cli.github.com/");
	});

	it("returns github windows install command", () => {
		const content = buildTaskStartServicePromptContent("github_cli", {
			platform: "windows",
		});
		expect(content.installCommand).toBe("winget install --id GitHub.cli");
	});

	it("returns no github install command for unsupported platforms", () => {
		const content = buildTaskStartServicePromptContent("github_cli", {
			platform: "other",
		});
		expect(content.installCommand).toBeUndefined();
	});

	it("returns kanban mcp install command", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp");
		expect(content.installCommand).toBe("claude mcp add --transport stdio --scope user kanban -- kanban mcp");
		expect(content.learnMoreUrl).toBe("https://github.com/cline/kanban");
	});

	it("returns codex-specific kanban mcp install command", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp", {
			selectedAgentId: "codex",
		});
		expect(content.installCommand).toBe("codex mcp add kanban -- kanban mcp");
	});

	it("returns opencode-specific kanban mcp install command", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp", {
			selectedAgentId: "opencode",
		});
		expect(content.installCommand).toBe("opencode mcp add");
		expect(content.description).toContain("server type: Local MCP server");
		expect(content.description).toContain("command: kanban mcp");
	});

	it("returns droid-specific kanban mcp install command", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp", {
			selectedAgentId: "droid",
		});
		expect(content.installCommand).toBe("droid mcp add kanban -- kanban mcp");
	});

	it("returns cline-specific kanban mcp install command", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp", {
			selectedAgentId: "cline",
		});
		expect(content.installCommand).toBe("droid mcp add kanban -- kanban mcp");
	});

	it("returns gemini kanban mcp install command with user scope", () => {
		const content = buildTaskStartServicePromptContent("kanban_mcp", {
			selectedAgentId: "gemini",
		});
		expect(content.installCommand).toBe("gemini mcp add kanban kanban mcp --scope user");
	});

	it("returns opencode-specific linear guidance with oauth", () => {
		const content = buildTaskStartServicePromptContent("linear_mcp", {
			selectedAgentId: "opencode",
		});
		expect(content.installCommand).toBe("opencode mcp add");
		expect(content.description).toContain("name: linear");
		expect(content.description).toContain("OAuth");
	});
});

describe("getTaskStartServicePromptKey", () => {
	it("builds stable task prompt keys", () => {
		expect(getTaskStartServicePromptKey("task-1", "linear_mcp")).toBe("task-1:linear_mcp");
	});
});
