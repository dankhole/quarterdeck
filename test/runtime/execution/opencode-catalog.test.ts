import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentCommand } from "../../../src/config/agent-registry";
import {
	loadOpencodeCatalog,
	parseOpencodeAgentListOutput,
	parseOpencodeModelsOutput,
} from "../../../src/config/opencode-catalog";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

function fixture(responses: { models?: string | Error; agents?: string | Error }) {
	const calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
	const resolveCommand = vi.fn(
		async (): Promise<ResolvedAgentCommand> => ({
			// TODO(workstream A): drop this cast once "opencode" joins RuntimeAgentId.
			agentId: "opencode" as unknown as ResolvedAgentCommand["agentId"],
			label: "opencode",
			command: "opencode",
			binary: "opencode",
			args: [],
		}),
	);
	const runCommand = vi.fn(
		async (options: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => {
			calls.push(options);
			const isAgentCall = options.args[0] === "agent";
			const response = isAgentCall ? responses.agents : responses.models;
			if (response instanceof Error) throw response;
			return response ?? "";
		},
	);
	return { calls, dependencies: { resolveCommand, runCommand } };
}

describe("opencode model list parsing", () => {
	it("parses provider/model lines and ignores everything else", () => {
		const output = [
			"Loading models…",
			"anthropic/claude-sonnet-4-5",
			"",
			"openai/gpt-5",
			"not-a-model-line",
			"  opencode/grok-code  ",
		].join("\n");
		expect(parseOpencodeModelsOutput(output)).toEqual([
			{ id: "anthropic/claude-sonnet-4-5", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
			{ id: "openai/gpt-5", providerId: "openai", modelId: "gpt-5" },
			{ id: "opencode/grok-code", providerId: "opencode", modelId: "grok-code" },
		]);
	});

	it("strips ANSI escape sequences before matching", () => {
		const output = "\u001B[32manthropic/claude-sonnet-4-5\u001B[0m\n";
		expect(parseOpencodeModelsOutput(output)).toEqual([
			{ id: "anthropic/claude-sonnet-4-5", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
		]);
	});

	it("skips verbose JSON lines mixed into stdout", () => {
		const output = [
			'{"level": "info", "model": "anthropic/claude-sonnet-4-5"}',
			"anthropic/claude-sonnet-4-5",
			'{"nested": {"provider/model": "x"}}',
		].join("\n");
		expect(parseOpencodeModelsOutput(output)).toEqual([
			{ id: "anthropic/claude-sonnet-4-5", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
		]);
	});

	it("caps the number of parsed models", () => {
		const output = Array.from({ length: 5_010 }, (_, index) => `provider/model-${index}`).join("\n");
		expect(parseOpencodeModelsOutput(output)).toHaveLength(5_000);
	});
});

describe("opencode agent list parsing", () => {
	it("parses name (mode) lines, drops subagent-only agents, and skips JSON permission blocks", () => {
		const output = [
			"build (primary)",
			'{"edit":"allow","bash":"ask"}',
			"plan (all)",
			'{"edit":"deny"}',
			"reviewer (subagent)",
			'{"edit":"deny"}',
		].join("\n");
		expect(parseOpencodeAgentListOutput(output)).toEqual([
			{ name: "build", mode: "primary" },
			{ name: "plan", mode: "all" },
		]);
	});

	it("strips ANSI escape sequences before matching", () => {
		const output = "\u001B[1mbuild (primary)\u001B[0m\n";
		expect(parseOpencodeAgentListOutput(output)).toEqual([{ name: "build", mode: "primary" }]);
	});
});

describe("opencode catalog discovery", () => {
	it("resolves the opencode command metadata-only and runs models + agent list concurrently", async () => {
		const f = fixture({ models: "anthropic/claude-sonnet-4-5", agents: "build (primary)" });
		const result = await loadOpencodeCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies);
		expect(result).toEqual({
			models: [{ id: "anthropic/claude-sonnet-4-5", providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
			agents: [{ name: "build", mode: "primary" }],
		});
		expect(f.dependencies.resolveCommand).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAgentId: "opencode" }),
		);
		expect(f.calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ binary: "opencode", args: ["models"], cwd: "/tmp/project" }),
				expect.objectContaining({ binary: "opencode", args: ["agent", "list"], cwd: "/tmp/project" }),
			]),
		);
		for (const call of f.calls) {
			expect(call.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
		}
	});

	it("returns the successful half when one subcommand fails", async () => {
		const f = fixture({ models: new Error("models timed out"), agents: "build (primary)" });
		const result = await loadOpencodeCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies);
		expect(result).toEqual({ models: [], agents: [{ name: "build", mode: "primary" }] });
	});

	it("throws when both subcommands fail", async () => {
		const f = fixture({ models: new Error("models timed out"), agents: new Error("agent list timed out") });
		await expect(loadOpencodeCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies)).rejects.toThrow(
			/models timed out/,
		);
	});

	it("treats an authoritative empty catalog as success, not failure", async () => {
		const f = fixture({ models: "", agents: "" });
		const result = await loadOpencodeCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies);
		expect(result).toEqual({ models: [], agents: [] });
	});
});
