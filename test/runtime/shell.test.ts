import { afterEach, describe, expect, it } from "vitest";
import {
	buildShellCommandLine,
	buildWindowsProcessArgsCommandLine,
	resolveInteractiveShellCommand,
	resolveWindowsPowerShellPath,
	resolveWindowsSystem32ExecutablePath,
} from "../../src/core";

const WINDOWS_TEST_ENV = { SystemRoot: "C:\\Windows" };
const WINDOWS_SHELL_COMMAND_PREFIX =
	'""C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ';

function decodeWindowsLaunch(command: string): { fileName: string; arguments: string } {
	expect(command.startsWith(WINDOWS_SHELL_COMMAND_PREFIX)).toBe(true);
	expect(command.endsWith('"')).toBe(true);
	const encodedScript = command.slice(WINDOWS_SHELL_COMMAND_PREFIX.length, -1);
	const script = Buffer.from(encodedScript, "base64").toString("utf16le");
	const prefix = "$launch = ConvertFrom-Json -InputObject '";
	const suffix = "'; $startInfo = New-Object System.Diagnostics.ProcessStartInfo";
	expect(script.startsWith(prefix)).toBe(true);
	const suffixIndex = script.indexOf(suffix, prefix.length);
	expect(suffixIndex).toBeGreaterThan(prefix.length);
	const payload = script.slice(prefix.length, suffixIndex).replaceAll("''", "'");
	return JSON.parse(payload) as { fileName: string; arguments: string };
}

describe("resolveInteractiveShellCommand", () => {
	const originalPlatform = process.platform;
	const originalEnv = { ...process.env };

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		process.env = { ...originalEnv };
	});

	it("returns SHELL with -i on unix when SHELL is set", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		process.env.SHELL = "/bin/zsh";
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "/bin/zsh", args: ["-i"] });
	});

	it("falls back to bash -i on unix when SHELL is unset", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		delete process.env.SHELL;
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "bash", args: ["-i"] });
	});

	it("trims whitespace from SHELL", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		process.env.SHELL = "  /bin/fish  ";
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "/bin/fish", args: ["-i"] });
	});

	it("ignores empty SHELL", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		process.env.SHELL = "   ";
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "bash", args: ["-i"] });
	});

	it("returns an absolute case-insensitive ComSpec on win32", () => {
		const result = resolveInteractiveShellCommand("win32", {
			comspec: "D:\\Windows\\System32\\cmd.exe",
		});
		expect(result).toEqual({ binary: "D:\\Windows\\System32\\cmd.exe", args: [] });
	});

	it("falls back to absolute System32 cmd on win32 when ComSpec is unset", () => {
		const result = resolveInteractiveShellCommand("win32", { WINDIR: "D:\\Windows Root" });
		expect(result).toEqual({ binary: "D:\\Windows Root\\System32\\cmd.exe", args: [] });
	});
});

describe("buildShellCommandLine", () => {
	it("joins binary and args with quoting", () => {
		expect(buildShellCommandLine("/bin/zsh", ["-i"], "darwin")).toBe("'/bin/zsh' '-i'");
	});

	it("escapes embedded single quotes on Unix", () => {
		expect(buildShellCommandLine("/bin/tool", ["it's"], "linux")).toBe("'/bin/tool' 'it'\\''s'");
	});

	it("encodes a direct Windows process launch without exposing cmd metacharacters", () => {
		const binary = "C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe";
		const args = ["space value", "%NAME%", "!", "^", "&", "|", "(round trip)"];
		const command = buildShellCommandLine(binary, args, "win32", WINDOWS_TEST_ENV);

		expect(command).toMatch(
			/^""C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+"$/u,
		);
		expect(command).not.toContain(binary);
		for (const argument of args) {
			expect(command).not.toContain(argument);
		}
		expect(decodeWindowsLaunch(command)).toEqual({
			fileName: binary,
			arguments: '"space value" "%NAME%" "!" "^" "&" "|" "(round trip)"',
		});
	});

	it("resolves PowerShell from the absolute system root without consulting cwd or PATH", () => {
		expect(
			resolveWindowsPowerShellPath({
				systemroot: "D:\\Windows Root",
				PATH: "C:\\untrusted-repository;C:\\also-untrusted",
			}),
		).toBe("D:\\Windows Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	});

	it("resolves trusted System32 executables without consulting cwd or PATH", () => {
		expect(
			resolveWindowsSystem32ExecutablePath("taskkill.exe", {
				windir: "D:\\Windows Root",
				PATH: "C:\\untrusted-repository;C:\\also-untrusted",
			}),
		).toBe("D:\\Windows Root\\System32\\taskkill.exe");
		expect(() => resolveWindowsSystem32ExecutablePath("..\\taskkill.exe", WINDOWS_TEST_ENV)).toThrow(
			"must not contain a path or shell syntax",
		);
	});

	it("rejects malformed system-root environment values", () => {
		expect(resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows" & decoy' })).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
	});

	it("serializes quotes, trailing backslashes, and empty Windows argv entries", () => {
		expect(buildWindowsProcessArgsCommandLine(['say "hi"', "C:\\tail\\", ""])).toBe(
			'"say \\"hi\\"" "C:\\tail\\\\" ""',
		);
	});
});
