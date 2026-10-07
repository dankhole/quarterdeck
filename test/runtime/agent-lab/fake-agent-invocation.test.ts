import { describe, expect, it } from "vitest";
import { resolveFakeAgentInvocation } from "../../../scripts/agent-lab/fake-agent-protocol";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

describe("fake Codex invocation", () => {
	it.each([
		{ resumeConversation: false, resumeSessionId: undefined, resumeKind: "fresh", requestedSessionId: null },
		{
			resumeConversation: true,
			resumeSessionId: "agent-lab-abc12",
			resumeKind: "targeted",
			requestedSessionId: "agent-lab-abc12",
		},
		{ resumeConversation: true, resumeSessionId: undefined, resumeKind: "continue", requestedSessionId: null },
	] as const)("parses actual adapter $resumeKind arguments", async (example) => {
		const launch = await prepareAgentLaunch({
			agentId: "codex",
			taskId: "abc12",
			args: ["--model", "lab-codex"],
			cwd: "/synthetic/project",
			projectPath: "/synthetic/project",
			projectId: "project-one",
			hookSessionInstanceId: "launch-one",
			prompt: "- synthetic prompt with resume --last -- content",
			resumeConversation: example.resumeConversation,
			resumeSessionId: example.resumeSessionId,
		});
		expect(launch.args).toContain("--no-daemon");
		expect(resolveFakeAgentInvocation("codex", launch.args)).toEqual({
			prompt: "- synthetic prompt with resume --last -- content",
			settingsPath: null,
			resumeKind: example.resumeKind,
			requestedSessionId: example.requestedSessionId,
		});
	});

	it("does not interpret option values or separated prompt bytes as resume intent", () => {
		expect(
			resolveFakeAgentInvocation("codex", ["-c", "resume", "--model=resume", "--", "resume", "--last"]),
		).toMatchObject({ resumeKind: "fresh", requestedSessionId: null, prompt: "resume --last" });
		expect(
			resolveFakeAgentInvocation("codex", ["resume", "agent-lab-abc12", "-c", "model=resume", "--", "--last"]),
		).toMatchObject({ resumeKind: "targeted", requestedSessionId: "agent-lab-abc12", prompt: "--last" });
	});

	it.each(
		[
			["resume"],
			["resume", "--last", "agent-lab-abc12"],
			["resume", "--last", "--last"],
			["resume", "one", "two"],
			["resume", "../outside"],
			["--last"],
			["--continue"],
			["--resume", "one"],
			["resume", "--", "one"],
			["--model"],
		].map((args) => ({ args })),
	)("rejects ambiguous or incomplete Codex resume arguments: $args", ({ args }) => {
		expect(() => resolveFakeAgentInvocation("codex", args)).toThrow();
	});

	it("retains Claude and Pi targeted/continue contracts", () => {
		expect(
			resolveFakeAgentInvocation("claude", [
				"--resume",
				"claude-one",
				"--settings",
				"/synthetic/hooks.json",
				"--",
				"prompt",
			]),
		).toEqual({
			prompt: "prompt",
			resumeKind: "targeted",
			requestedSessionId: "claude-one",
			settingsPath: "/synthetic/hooks.json",
		});
		expect(resolveFakeAgentInvocation("claude", ["--continue", "--settings=/synthetic/hooks.json"])).toMatchObject({
			resumeKind: "continue",
			requestedSessionId: null,
		});
		expect(resolveFakeAgentInvocation("pi", ["--session", "/synthetic/pi-session.jsonl", "prompt"])).toMatchObject({
			prompt: "prompt",
			resumeKind: "targeted",
			requestedSessionId: "/synthetic/pi-session.jsonl",
		});
		expect(resolveFakeAgentInvocation("pi", ["--continue"])).toMatchObject({
			resumeKind: "continue",
			requestedSessionId: null,
		});
	});
});
