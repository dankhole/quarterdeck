import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
	estimateWindowsCommandLineCodeUnits,
	findProcessLaunchBudgetViolation,
	getProcessLaunchBudgetPolicy,
	isNativeProcessLaunchSizeError,
	type ProcessLaunchBudgetInput,
} from "../../../src/terminal/process-launch-budget";

const posixInput: ProcessLaunchBudgetInput = { binary: "agent", args: [], env: {}, platform: "linux" };

describe("process launch budget", () => {
	it("counts UTF-8 bytes, NUL terminators and 64-bit argv/env pointers at the boundary", () => {
		// agent\0 + é\0 + TOKEN=😀\0 + argv[3] + envp[2] = 6 + 3 + 11 + 24 + 16.
		const input = { ...posixInput, args: ["é"], env: { TOKEN: "😀" } };
		expect(findProcessLaunchBudgetViolation(input, { combinedBytes: 60 })).toBeNull();
		expect(findProcessLaunchBudgetViolation(input, { combinedBytes: 59 })).toEqual({
			source: "combined",
			unit: "bytes",
			estimatedSize: 60,
			budget: 59,
		});
	});

	it("reserves configurable headroom for helper and loader overhead", () => {
		expect(findProcessLaunchBudgetViolation(posixInput, { combinedBytes: 40, headroomBytes: 11 })).toEqual({
			source: "combined",
			unit: "bytes",
			estimatedSize: 30,
			budget: 29,
		});
	});

	it("accounts for empty and undefined environment values as node-pty serializes them", () => {
		const input = { ...posixInput, env: { A: "", B: undefined } };
		// 30 base bytes + A=\0 (3) + B=undefined\0 (12) + two pointers (16).
		expect(findProcessLaunchBudgetViolation(input, { combinedBytes: 61 })).toBeNull();
		expect(findProcessLaunchBudgetViolation(input, { combinedBytes: 60 })?.estimatedSize).toBe(61);
	});

	it("enforces the Linux per-string policy independently of the combined budget", () => {
		const args = ["a".repeat(128 * 1024 - 1)];
		expect(findProcessLaunchBudgetViolation({ ...posixInput, args })).toBeNull();
		expect(findProcessLaunchBudgetViolation({ ...posixInput, args: [`${args[0]}a`] })).toMatchObject({
			source: "arguments",
		});
		expect(findProcessLaunchBudgetViolation({ ...posixInput, env: { A: "a".repeat(128 * 1024) } })).toMatchObject({
			source: "environment",
		});
	});

	it("counts combined argv/environment and pointer arrays, not just the largest value", () => {
		const args = Array.from({ length: 18 }, () => "a".repeat(100_000));
		expect(findProcessLaunchBudgetViolation({ ...posixInput, args })).toBeNull();
		const env = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`V${index}`, "e".repeat(100_000)]));
		expect(findProcessLaunchBudgetViolation({ ...posixInput, args, env })).toMatchObject({ source: "combined" });
		expect(findProcessLaunchBudgetViolation({ ...posixInput, args: Array(300_000).fill("") })).toMatchObject({
			source: "arguments",
		});
	});

	it("preserves working 300 KiB macOS launches but rejects inputs beyond the 1 MiB policy", () => {
		expect(getProcessLaunchBudgetPolicy("darwin")).toEqual({ combinedBytes: 1024 * 1024, headroomBytes: 16 * 1024 });
		expect(
			findProcessLaunchBudgetViolation({ ...posixInput, platform: "darwin", args: ["a".repeat(1024 * 1024 + 1)] }),
		).toMatchObject({ source: "arguments" });
		expect(
			findProcessLaunchBudgetViolation({
				...posixInput,
				platform: "darwin",
				env: { LARGE: "a".repeat(1024 * 1024 + 1) },
			}),
		).toMatchObject({ source: "environment" });
		expect(
			findProcessLaunchBudgetViolation({ ...posixInput, platform: "darwin", args: ["a".repeat(300 * 1024)] }),
		).toBeNull();
	});

	it("does not invent a POSIX budget for other kernels", () => {
		expect(
			findProcessLaunchBudgetViolation({ ...posixInput, platform: "freebsd", args: ["a".repeat(2_000_000)] }),
		).toBeNull();
	});

	it("matches installed node-pty Windows quoting, including surrogate pairs and pre-escaped strings", () => {
		const require = createRequire(import.meta.url);
		const nativeSerializer = require("node-pty/lib/windowsPtyAgent.js") as {
			argsToCommandLine: (binary: string, args: string[] | string) => string;
		};
		for (const binary of ["agent.exe", "C:\\Program Files\\agent.exe"]) {
			for (const args of [
				[],
				[""],
				["hello world", 'a\\"b', "tail \\", "😀"],
				['"already quoted"'],
				'/d /s /c "escaped^ value"',
				"",
			]) {
				expect(estimateWindowsCommandLineCodeUnits(binary, args)).toBe(
					nativeSerializer.argsToCommandLine(binary, args).length + 1,
				);
			}
		}
	});

	it("counts UTF-16/NUL and reserves 2 KiB rather than claiming launches at the exact native maximum are safe", () => {
		const input = { ...posixInput, binary: "a", platform: "win32" as const, args: ["😀".repeat(15_358)] };
		expect(findProcessLaunchBudgetViolation(input)).toBeNull();
		expect(findProcessLaunchBudgetViolation({ ...input, args: ["😀".repeat(15_359)] })).toMatchObject({
			source: "arguments",
			unit: "UTF-16 code units",
			budget: 32_767 - 2048,
		});
		const atNativeMaximum = { ...input, args: ["😀".repeat(16_382)] };
		expect(estimateWindowsCommandLineCodeUnits(atNativeMaximum.binary, atNativeMaximum.args)).toBe(32_767);
		expect(findProcessLaunchBudgetViolation(atNativeMaximum)).not.toBeNull();
		expect(
			findProcessLaunchBudgetViolation({
				...input,
				binary: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				args: ["-NoProfile", "-File", "C:\\provider\\agent.ps1", "x".repeat(28_000)],
			}),
		).toBeNull();
	});

	it("measures resolved cmd escaping against its smaller command-line limit", () => {
		const input = {
			...posixInput,
			binary: "C:\\Windows\\System32\\cmd.exe",
			platform: "win32" as const,
			args: `/d /s /c ${"a".repeat(8200)}`,
		};
		expect(findProcessLaunchBudgetViolation(input)).toMatchObject({ source: "arguments", budget: 8191 - 256 });
		expect(findProcessLaunchBudgetViolation({ ...input, args: `/d /s /c ${"a".repeat(7800)}` })).toBeNull();
		expect(findProcessLaunchBudgetViolation({ ...input, args: `/d /s /c ${"a".repeat(8000)}` })).toMatchObject({
			budget: 8191 - 256,
		});
		expect(findProcessLaunchBudgetViolation({ ...input, binary: "agent.exe" })).toBeNull();
	});

	it("does not impose the obsolete ANSI 32 KiB total environment limit on Windows", () => {
		expect(
			findProcessLaunchBudgetViolation({ ...posixInput, platform: "win32", env: { LARGE: "x".repeat(100_000) } }),
		).toBeNull();
	});

	it("recognizes native size failures without treating arbitrary prompt text as native evidence", () => {
		expect(isNativeProcessLaunchSizeError({ code: "E2BIG" })).toBe(true);
		expect(isNativeProcessLaunchSizeError(new Error("posix_spawn failed: Argument list too long"))).toBe(true);
		expect(isNativeProcessLaunchSizeError(new Error("Argument list too long"))).toBe(true);
		// cmd prints this to its console; it is not a synchronous native error.
		expect(isNativeProcessLaunchSizeError(new Error("The command line is too long."))).toBe(false);
		// node-pty's numeric 206 alone can also mean an overlong executable path.
		expect(isNativeProcessLaunchSizeError(new Error("Cannot create process, error code: 206"))).toBe(false);
		expect(
			isNativeProcessLaunchSizeError(
				Object.assign(new Error("The filename or extension is too long."), { code: "ERROR_FILENAME_EXCED_RANGE" }),
			),
		).toBe(false);
		expect(isNativeProcessLaunchSizeError(new Error("posix_spawn failed: No such file or directory"))).toBe(false);
		expect(isNativeProcessLaunchSizeError(new Error("provider refused prompt: Argument list too long"))).toBe(false);
	});
});
