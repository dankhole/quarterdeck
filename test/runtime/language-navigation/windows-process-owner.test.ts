import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWindowsProcessArgsCommandLine } from "../../../src/core/windows-cmd-launch";
import { resolveWindowsPowerShellPath } from "../../../src/core/windows-system-paths";
import { spawnWindowsLanguageProcess } from "../../../src/language-navigation/windows-process-owner";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("Windows language server supervisor launch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("transports executable and arguments as private environment data and keeps protocol pipes", () => {
		const command = "C:\\Program Files\\语言\\server.exe";
		const args = ["space here", 'quote"\\', "'; Stop-Process -Id $PID; #", "first\nsecond", ""];
		const env = { PATH: "configured", TOKEN: "synthetic-value" };
		spawnWindowsLanguageProcess(command, args, "C:\\project", env);
		const [binary, actualArgs, options] = vi.mocked(spawn).mock.calls[0];
		expect(binary).toBe(resolveWindowsPowerShellPath());
		expect(actualArgs?.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
		const script = Buffer.from(String(actualArgs?.at(-1)), "base64").toString("utf16le");
		const keys = [...script.matchAll(/GetEnvironmentVariable\('([^']+)'\)/gu)].map((match) => match[1]);
		expect(keys).toHaveLength(2);
		expect(keys.map((key) => options?.env?.[key])).toEqual([
			command,
			buildWindowsProcessArgsCommandLine([command, ...args]),
		]);
		for (const key of keys) expect(script).toContain(`SetEnvironmentVariable('${key}', $null, 'Process')`);

		expect(script).not.toContain(args[2]);
		expect(script).not.toContain(env.TOKEN);
		expect(options).toMatchObject({ cwd: "C:\\project", env, stdio: "pipe", shell: false, windowsHide: true });
		expect(Object.keys(env)).toEqual(["PATH", "TOKEN"]);
	});
	it.each(["x".repeat(6500), "语🚢".repeat(5000)])(
		"keeps supervisor size independent of long argument data",
		(argument) => {
			spawnWindowsLanguageProcess("C:\\server.exe", [argument], "C:\\project", {});
			const [binary, args] = vi.mocked(spawn).mock.calls[0];
			expect(buildWindowsProcessArgsCommandLine([String(binary), ...(args ?? [])]).length).toBeLessThan(32_767);
		},
	);

	it("accepts the native UTF-16 boundary and rejects only commands beyond it", () => {
		const command = "C:\\server.exe";
		const overhead = buildWindowsProcessArgsCommandLine([command, ""]).length;
		const argument = `🚢${"语".repeat(32_766 - overhead - 2)}`;
		expect(buildWindowsProcessArgsCommandLine([command, argument])).toHaveLength(32_766);
		expect(() => spawnWindowsLanguageProcess(command, [argument], "C:\\project", {})).not.toThrow();
		expect(() => spawnWindowsLanguageProcess(command, [`${argument}x`], "C:\\project", {})).toThrow(
			"Windows command-line limit",
		);
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
