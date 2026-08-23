import { delimiter } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentLabEnvironment } from "../../scripts/agent-lab/environment";
import {
	extractPromptArgument,
	parseFakeAgentCommand,
	resolveFakeAgentScenario,
} from "../../scripts/agent-lab/fake-agent-protocol";
import { assertSafeRunId, createAgentLabRunId, getAgentLabBrowserCachePath } from "../../scripts/agent-lab/paths";

describe("agent-lab browser cache", () => {
	it("shares browser binaries through the primary checkout", () => {
		expect(
			getAgentLabBrowserCachePath("/repo/.quarterdeck/worktrees/task/quarterdeck", "/repo/quarterdeck/.git"),
		).toBe("/repo/quarterdeck/web-ui/node_modules/.cache/agent-lab-playwright");
	});

	it("falls back to the active checkout for nonstandard Git layouts", () => {
		expect(getAgentLabBrowserCachePath("/repo/quarterdeck", "/repo/quarterdeck.git")).toBe(
			"/repo/quarterdeck/web-ui/node_modules/.cache/agent-lab-playwright",
		);
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
				fakeBinPath: "/tmp/lab/bin",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeCodexPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
			},
		);

		expect(environment.OPENAI_API_KEY).toBeUndefined();
		expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(environment.HOME).toBe("/tmp/lab/home");
		expect(environment.QUARTERDECK_STATE_HOME).toBe("/tmp/lab/state");
		expect(environment.QUARTERDECK_RUNTIME_PORT).toBe("35001");
		expect(environment.PATH).toBe(["/tmp/lab/bin", "/host/bin"].join(delimiter));
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
