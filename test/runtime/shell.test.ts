import { afterEach, describe, expect, it } from "vitest";
import { buildShellCommandLine, quoteShellArg, resolveInteractiveShellCommand } from "../../src/core/shell";

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

	it("returns COMSPEC on win32 when set", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "C:\\Windows\\System32\\cmd.exe", args: [] });
	});

	it("falls back to powershell on win32 when COMSPEC is unset", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		delete process.env.COMSPEC;
		const result = resolveInteractiveShellCommand();
		expect(result).toEqual({ binary: "powershell.exe", args: ["-NoLogo"] });
	});
});

describe("quoteShellArg", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("single-quotes on unix", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(quoteShellArg("hello world")).toBe("'hello world'");
	});

	it("escapes embedded single quotes on unix", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		expect(quoteShellArg("it's")).toBe("'it'\\''s'");
	});

	it("double-quotes on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(quoteShellArg("hello world")).toBe('"hello world"');
	});

	it("escapes embedded double quotes on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(quoteShellArg('say "hi"')).toBe('"say ""hi"""');
	});
});

describe("buildShellCommandLine", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("joins binary and args with quoting", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(buildShellCommandLine("/bin/zsh", ["-i"])).toBe("'/bin/zsh' '-i'");
	});

	it("handles empty args", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(buildShellCommandLine("bash", [])).toBe("'bash'");
	});
});
