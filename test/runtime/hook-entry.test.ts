import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main, parseHookEntryArgs } from "../../src/hook-entry";
import { runHooksIngest, runHooksNotify } from "../../src/hooks-runtime-client";

vi.mock("../../src/hooks-runtime-client", () => ({
	parseHookEvent: vi.fn((value: string) => {
		if (value !== "to_review" && value !== "to_in_progress" && value !== "activity") {
			throw new Error(`Invalid event "${value}". Must be one of: to_review, to_in_progress, activity`);
		}
		return value;
	}),
	runHooksIngest: vi.fn(async () => {}),
	runHooksNotify: vi.fn(async () => {}),
}));

describe("hook-entry argv parsing", () => {
	it("extracts --event, metadata flags, and a trailing positional payload", () => {
		expect(
			parseHookEntryArgs([
				"--event",
				"to_review",
				"--source",
				"claude",
				"--tool-name",
				"Bash",
				"--session-instance-id",
				"process-1",
				'{"raw":true}',
			]),
		).toEqual({
			event: "to_review",
			options: { source: "claude", toolName: "Bash", sessionInstanceId: "process-1" },
			payload: '{"raw":true}',
			unknownFlag: null,
		});
	});

	it("supports a leading positional payload before flags", () => {
		expect(parseHookEntryArgs(["payload-arg", "--event", "activity"])).toEqual({
			event: "activity",
			options: {},
			payload: "payload-arg",
			unknownFlag: null,
		});
	});

	it("defaults event to an empty string when --event is missing", () => {
		expect(parseHookEntryArgs(["--source", "codex"])).toEqual({
			event: "",
			options: { source: "codex" },
			payload: undefined,
			unknownFlag: null,
		});
	});

	it("supports commander's --flag=value form for --event and metadata flags alike", () => {
		expect(parseHookEntryArgs(["--event=to_review", "--source=claude", "--tool-name=Bash"])).toEqual({
			event: "to_review",
			options: { source: "claude", toolName: "Bash" },
			payload: undefined,
			unknownFlag: null,
		});
	});

	it("treats -- as the end of options, matching commander", () => {
		expect(parseHookEntryArgs(["--event", "activity", "--", "--source", "looks-like-a-flag"])).toEqual({
			event: "activity",
			options: {},
			payload: "--source",
			unknownFlag: null,
		});
	});

	it("reports the first unrecognized flag instead of silently ignoring it, matching commander's unknownOption error", () => {
		expect(parseHookEntryArgs(["--event", "activity", "--unknown-flag", "value", "--source", "pi"])).toEqual({
			event: "activity",
			options: {},
			payload: undefined,
			unknownFlag: "--unknown-flag",
		});
	});

	it("reports the bare flag name as unknown even when given in --flag=value form", () => {
		expect(parseHookEntryArgs(["--event", "activity", "--unknown-flag=value"]).unknownFlag).toBe("--unknown-flag");
	});
});

describe("hook-entry main()", () => {
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	async function run(argv: string[]): Promise<{ stderr: string }> {
		process.argv = ["node", "hooks.js", ...argv];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await main();
		const output = stderr.mock.calls.map((call) => String(call[0])).join("");
		stderr.mockRestore();
		return { stderr: output };
	}

	it("rejects an unrecognized subcommand with usage text and a failing exit code", async () => {
		const { stderr } = await run(["hooks", "frobnicate"]);

		expect(stderr).toContain("Usage: quarterdeck hooks <ingest|notify>");
		expect(process.exitCode).toBe(1);
		expect(runHooksIngest).not.toHaveBeenCalled();
		expect(runHooksNotify).not.toHaveBeenCalled();
	});

	it("dispatches a valid ingest invocation with the parsed event and options", async () => {
		await run(["hooks", "ingest", "--event", "to_review", "--source", "claude"]);

		expect(runHooksIngest).toHaveBeenCalledExactlyOnceWith("to_review", { source: "claude" }, undefined);
	});

	it("dispatches a valid notify invocation with the parsed event and options", async () => {
		await run(["hooks", "notify", "--event", "activity", "--source", "pi"]);

		expect(runHooksNotify).toHaveBeenCalledExactlyOnceWith("activity", { source: "pi" }, undefined);
	});

	it("writes a stderr error and fails for an invalid --event on ingest", async () => {
		const { stderr } = await run(["hooks", "ingest", "--event", "bogus"]);

		expect(stderr).toContain("quarterdeck hooks ingest:");
		expect(process.exitCode).toBe(1);
		expect(runHooksIngest).not.toHaveBeenCalled();
	});

	it("silently swallows an invalid --event on notify", async () => {
		const { stderr } = await run(["hooks", "notify", "--event", "bogus"]);

		expect(stderr).toBe("");
		expect(process.exitCode).toBeUndefined();
		expect(runHooksNotify).not.toHaveBeenCalled();
	});

	it("rejects an unrecognized flag on ingest the same way commander's parser would, before dispatch", async () => {
		const { stderr } = await run(["hooks", "ingest", "--event", "to_review", "--unknown-flag", "x"]);

		expect(stderr).toContain("error: unknown option '--unknown-flag'");
		expect(process.exitCode).toBe(1);
		expect(runHooksIngest).not.toHaveBeenCalled();
	});

	it("rejects an unrecognized flag on notify too — this is a parse failure, not a best-effort runtime failure", async () => {
		const { stderr } = await run(["hooks", "notify", "--event", "activity", "--unknown-flag", "x"]);

		expect(stderr).toContain("error: unknown option '--unknown-flag'");
		expect(process.exitCode).toBe(1);
		expect(runHooksNotify).not.toHaveBeenCalled();
	});
});
