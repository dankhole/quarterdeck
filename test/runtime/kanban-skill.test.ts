import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	installKanbanSkillFiles,
	renderKanbanSkillMarkdown,
	resolveKanbanSkillCommandPrefix,
} from "../../src/skills/kanban-skill.js";

describe("resolveKanbanSkillCommandPrefix", () => {
	it("returns npx prefix for npx transient installs", () => {
		const prefix = resolveKanbanSkillCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/Users/example/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("npx -y kanban");
	});

	it("returns bun x prefix for bun x transient installs", () => {
		const prefix = resolveKanbanSkillCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("bun x kanban");
	});

	it("falls back to kanban for local entrypoints", () => {
		const prefix = resolveKanbanSkillCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("kanban");
	});
});

describe("installKanbanSkillFiles", () => {
	it("installs both .agents and .claude skills when claude is available", async () => {
		const homePath = await mkdtemp(join(tmpdir(), "kanban-skill-install-"));
		const installed = await installKanbanSkillFiles({
			commandPrefix: "npx -y kanban",
			installClaudeSkill: true,
			homePath,
		});

		expect(installed).toHaveLength(2);

		const agentsSkill = await readFile(join(homePath, ".agents", "skills", "kanban", "SKILL.md"), "utf8");
		const claudeSkill = await readFile(join(homePath, ".claude", "skills", "kanban", "SKILL.md"), "utf8");
		expect(agentsSkill).toContain("npx -y kanban task list");
		expect(claudeSkill).toContain("npx -y kanban task list");
	});

	it("installs only .agents skill when claude is not available", async () => {
		const homePath = await mkdtemp(join(tmpdir(), "kanban-skill-install-"));
		const installed = await installKanbanSkillFiles({
			commandPrefix: "kanban",
			installClaudeSkill: false,
			homePath,
		});

		expect(installed).toHaveLength(1);
		const agentsSkill = await readFile(join(homePath, ".agents", "skills", "kanban", "SKILL.md"), "utf8");
		expect(agentsSkill).toContain("kanban task list");
	});
});

describe("renderKanbanSkillMarkdown", () => {
	it("renders standard skill frontmatter and command prefix", () => {
		const rendered = renderKanbanSkillMarkdown("kanban");
		expect(rendered).toContain("name: kanban");
		expect(rendered).toContain("description: Manage tasks on the user's Kanban");
		expect(rendered).toContain("Use when the user asks to create tasks");
		expect(rendered).toContain("kanban task create");
		expect(rendered).toContain("If a task command fails because the runtime is unavailable");
	});
});
