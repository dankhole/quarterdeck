import { describe, expect, it, vi } from "vitest";

import { buildWindowsCmdArgsArray } from "../../src/core";
import {
	type OpenProjectCommandProcessResult,
	openProjectOnHost,
	resolveOpenProjectCommandCandidates,
} from "../../src/server/open-project";

function processResult(overrides: Partial<OpenProjectCommandProcessResult> = {}): OpenProjectCommandProcessResult {
	return {
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		durationMs: 1,
		...overrides,
	};
}

describe("Open Project host launcher", () => {
	it("resolves macOS app targets to direct argv without a shell", () => {
		expect(resolveOpenProjectCommandCandidates("vscode", "/tmp/my repo", "darwin")).toEqual([
			{ executable: "open", args: ["-a", "Visual Studio Code", "/tmp/my repo"] },
		]);
		expect(resolveOpenProjectCommandCandidates("iterm2", "/tmp/my repo", "darwin")).toEqual([
			{ executable: "open", args: ["-a", "iTerm", "/tmp/my repo"] },
			{ executable: "open", args: ["-a", "iTerm2", "/tmp/my repo"] },
		]);
		expect(resolveOpenProjectCommandCandidates("finder", "/tmp/my repo", "darwin")).toEqual([
			{ executable: "open", args: ["/tmp/my repo"] },
		]);
	});

	it("resolves Linux and Windows targets to direct executables", () => {
		expect(resolveOpenProjectCommandCandidates("finder", "/tmp/repo", "linux")).toEqual([
			{ executable: "xdg-open", args: ["/tmp/repo"] },
		]);
		expect(resolveOpenProjectCommandCandidates("finder", "C:\\my repo", "win32")).toEqual([
			{ executable: "explorer.exe", args: ["C:\\my repo"] },
		]);
		expect(resolveOpenProjectCommandCandidates("vscode-insiders", "C:\\my repo", "win32")).toEqual([
			{ executable: "code-insiders", args: ["C:\\my repo"] },
		]);
	});

	it("uses the shared Windows command-shim adapter without accepting shell text from the browser", async () => {
		const runCommand = vi.fn(async () => processResult());
		const projectPath = "C:\\my repo & still one argument";
		const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "", PATHEXT: ".CMD" };

		await openProjectOnHost("vscode", projectPath, { platform: "win32", env, runCommand });

		expect(runCommand).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\cmd.exe",
			buildWindowsCmdArgsArray("code", [projectPath]),
			projectPath,
		);
	});

	it("passes shell metacharacters as one inert path argument", () => {
		const projectPath = "/tmp/repo'; touch /tmp/escaped; '";
		expect(resolveOpenProjectCommandCandidates("cursor", projectPath, "linux")).toEqual([
			{ executable: "cursor", args: [projectPath] },
		]);
	});

	it("falls through alternate macOS app names until one launches", async () => {
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce(processResult({ status: 1, stderr: "not found" }))
			.mockResolvedValueOnce(processResult());

		await expect(openProjectOnHost("ghostty", "/tmp/project", { platform: "darwin", runCommand })).resolves.toEqual({
			kind: "opened",
		});
		expect(runCommand).toHaveBeenNthCalledWith(1, "open", ["-a", "Ghostty", "/tmp/project"], "/tmp/project");
		expect(runCommand).toHaveBeenNthCalledWith(2, "open", ["-a", "Ghostie", "/tmp/project"], "/tmp/project");
	});

	it("reports an unavailable launcher when every executable is missing", async () => {
		const error = Object.assign(new Error("spawn open ENOENT"), { code: "ENOENT" });
		const runCommand = vi.fn(async () => processResult({ status: null, error }));

		await expect(openProjectOnHost("iterm2", "/tmp/project", { platform: "darwin", runCommand })).resolves.toEqual({
			kind: "unavailable",
			error: 'Host launcher "open" is unavailable.',
		});
	});

	it("converts a nonzero launcher result into a typed launch failure", async () => {
		const runCommand = vi.fn(async () => processResult({ status: 7, stderr: "cannot open project" }));

		await expect(openProjectOnHost("vscode", "/tmp/project", { platform: "linux", runCommand })).resolves.toEqual({
			kind: "failed",
			error: "cannot open project",
		});
	});

	it("reports process errors, signals, and timeouts as launch failures", async () => {
		const cases: OpenProjectCommandProcessResult[] = [
			processResult({ status: null, error: new Error("spawn failed") }),
			processResult({ status: null, signal: "SIGTERM" }),
			processResult({ status: null, timedOut: true }),
		];

		for (const result of cases) {
			const runCommand = vi.fn(async () => result);
			const response = await openProjectOnHost("vscode", "/tmp/project", { platform: "linux", runCommand });
			expect(response.kind).toBe("failed");
		}
	});
});
