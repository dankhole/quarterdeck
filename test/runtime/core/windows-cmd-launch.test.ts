import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	buildWindowsCmdArgsArray,
	buildWindowsCmdArgsCommandLine,
	resolveWindowsCompatibleCommand,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
	WindowsCommandResolutionError,
	WindowsCommandSerializationError,
} from "../../../src/core";

function createWindowsBinary(directory: string, fileName: string): string {
	const filePath = join(directory, fileName);
	writeFileSync(filePath, "");
	return filePath;
}

describe("shouldUseWindowsCmdLaunch", () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
		tempDirectories.length = 0;
	});

	it("returns false outside Windows", () => {
		expect(shouldUseWindowsCmdLaunch("codex", "darwin")).toBe(false);
	});

	it("returns false for explicit .exe binaries", () => {
		expect(shouldUseWindowsCmdLaunch("codex.exe", "win32")).toBe(false);
	});

	it("returns true for explicit .cmd shims", () => {
		expect(shouldUseWindowsCmdLaunch("codex.cmd", "win32")).toBe(true);
	});

	it("returns false when PATH resolves a bare binary to .exe", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("treats Windows env keys case-insensitively when PATH resolves a bare binary to .exe", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				Path: tempDirectory,
				Pathext: ".com;.exe;.bat;.cmd",
				comspec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("uses defined case-insensitive PATH when duplicate keys include undefined", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: undefined,
				Path: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("returns true when PATH resolves a bare binary to .cmd", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.cmd");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(true);
	});

	it("keeps cmd wrapping fallback when resolution is ambiguous", () => {
		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: "",
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(true);
	});

	it("resolves an unchanged direct command outside Windows", () => {
		expect(resolveWindowsCompatibleCommand("codex", ["--version"], "darwin")).toEqual({
			binary: "codex",
			args: ["--version"],
		});
	});

	it("wraps a Windows command shim with ComSpec", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		const shimPath = createWindowsBinary(tempDirectory, "codex.cmd");
		const env = {
			PATH: tempDirectory,
			PATHEXT: ".com;.exe;.bat;.cmd",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
		};
		const resolved = resolveWindowsCompatibleCommand("codex", ["--version"], "win32", env);

		expect(resolved.binary).toBe(env.ComSpec);
		expect(resolved.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(resolved.args.at(-1)).toContain(shimPath);
		expect(resolved.args.at(-1)).toContain("--version");
		expect(resolved.commandLine).toBe(buildWindowsCmdArgsCommandLine(shimPath, ["--version"]));
	});

	it("launches a bare Windows executable through its exact inherited-PATH target", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		const executablePath = createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			resolveWindowsCompatibleCommand("codex", ["--version"], "win32", {
				PATH: tempDirectory,
				PATHEXT: ".exe;.cmd",
			}),
		).toEqual({ binary: executablePath, args: ["--version"] });
	});

	it("fails closed when a bare Windows command cannot be resolved", () => {
		expect(() =>
			resolveWindowsCompatibleCommand("codex", ["--version"], "win32", {
				PATH: "",
				PATHEXT: ".EXE;.CMD",
			}),
		).toThrow(WindowsCommandResolutionError);
	});

	it("requires a sibling PowerShell shim for arguments cmd cannot transport unambiguously", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		const shimPath = createWindowsBinary(tempDirectory, "codex.cmd");
		const env = { PATH: tempDirectory, PATHEXT: ".cmd", SystemRoot: "C:\\Windows" };

		for (const argument of ['quoted "value"', "line one\nline two", "carriage\rreturn", "trailing-backslash\\"]) {
			expect(() => buildWindowsCmdArgsCommandLine(shimPath, [argument])).toThrow(WindowsCommandSerializationError);
			expect(() => buildWindowsCmdArgsArray(shimPath, [argument])).toThrow(WindowsCommandSerializationError);
			expect(() => resolveWindowsCompatibleCommand(shimPath, [argument], "win32", env)).toThrow(
				WindowsCommandSerializationError,
			);
		}
	});

	it("requires a sibling PowerShell shim when a batch-command path contains parser metacharacters", () => {
		expect(() => buildWindowsCmdArgsCommandLine("C:\\unsafe %NAME%\\codex.cmd", ["--version"])).toThrow(
			WindowsCommandSerializationError,
		);
	});

	it("single-escapes metacharacters for ordinary batch commands", () => {
		const args = ["space value", "%NAME%", "!DELAYED!", "^", "&", "|", "(value)"];
		const commandLine = buildWindowsCmdArgsCommandLine("codex.cmd", args);
		const commandArgs = buildWindowsCmdArgsArray("codex.cmd", args);

		expect(commandLine).toBe(
			'/d /s /c "codex.cmd ^"space^ value^" ^"^%NAME^%^" ^"^!DELAYED^!^" ^"^^^" ^"^&^" ^"^|^" ^"^(value^)^""',
		);
		expect(commandArgs).toEqual(["/d", "/s", "/c", commandLine.slice("/d /s /c ".length)]);
	});

	it("double-escapes metacharacters for node_modules command shims", () => {
		const commandLine = buildWindowsCmdArgsCommandLine("C:\\repo\\node_modules\\.bin\\codex.cmd", ["%NAME%"]);

		expect(commandLine).toBe('/d /s /c "C:\\repo\\node_modules\\.bin\\codex.cmd ^^^"^^^%NAME^^^%^^^""');
	});

	it("prefers a sibling PowerShell shim so multiline arguments bypass cmd parsing", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-launch-"));
		tempDirectories.push(tempDirectory);
		const cmdPath = createWindowsBinary(tempDirectory, "codex.cmd");
		const powerShellPath = createWindowsBinary(tempDirectory, "codex.ps1");
		const args = ["line one\nline two", "%NAME%", "!value!", 'quoted "value"', 'slash\\"quote'];

		expect(resolveWindowsCompatibleCommand(cmdPath, args, "win32", { SystemRoot: "C:\\Windows" })).toEqual({
			binary: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				powerShellPath,
				"line one\nline two",
				"%NAME%",
				"!value!",
				'quoted \\"value\\"',
				'slash\\\\\\"quote',
			],
		});
	});

	it("resolves a sibling PowerShell shim through quoted PATH and normalized PATHEXT entries", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "quarterdeck win launch "));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.cmd");
		const powerShellPath = createWindowsBinary(tempDirectory, "codex.ps1");

		const resolved = resolveWindowsCompatibleCommand("codex", ["line one\nline two"], "win32", {
			Path: `"${tempDirectory}"`,
			Pathext: " EXE ; CMD ",
			SystemRoot: "C:\\Windows",
		});

		expect(resolved.binary).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(resolved.args).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			powerShellPath,
			"line one\nline two",
		]);
	});

	it("uses an absolute System32 cmd fallback without consulting cwd or PATH", () => {
		expect(
			resolveWindowsComSpec({
				SystemRoot: "D:\\Windows Root",
				PATH: "C:\\untrusted-repository",
			}),
		).toBe("D:\\Windows Root\\System32\\cmd.exe");
	});

	it("rejects relative or shell-shaped ComSpec values", () => {
		for (const comSpec of ["cmd.exe", ".\\cmd.exe", 'C:\\Windows\\System32\\cmd.exe" & decoy']) {
			expect(resolveWindowsComSpec({ SystemRoot: "C:\\Windows", ComSpec: comSpec })).toBe(
				"C:\\Windows\\System32\\cmd.exe",
			);
		}
	});
});
