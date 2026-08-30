import { afterEach, describe, expect, it } from "vitest";

import { buildGitCommandArgs, createGitProcessEnv } from "../../../src/core/git-process-env";

describe("createGitProcessEnv", () => {
	const originalGitDir = process.env.Git_Dir;
	const originalPathAlias = process.env.Path;

	afterEach(() => {
		if (originalGitDir === undefined) {
			delete process.env.Git_Dir;
		} else {
			process.env.Git_Dir = originalGitDir;
		}
		if (originalPathAlias === undefined) {
			delete process.env.Path;
		} else {
			process.env.Path = originalPathAlias;
		}
	});

	it("removes case-insensitive repository overrides for Windows child environments", () => {
		process.env.Git_Dir = "C:\\hijacked";

		const result = createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }, "win32");

		expect(result.Git_Dir).toBeUndefined();
		expect(result.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("gives a Windows override precedence over a differently-cased inherited key", () => {
		process.env.Path = "C:\\host";

		const result = createGitProcessEnv({ PATH: "C:\\isolated" }, "win32");

		expect(result.PATH).toBe("C:\\isolated");
		expect(result.Path).toBeUndefined();
	});

	it("preserves case-distinct variables on case-sensitive platforms", () => {
		process.env.Git_Dir = "/tmp/not-the-uppercase-variable";

		expect(createGitProcessEnv({}, "darwin").Git_Dir).toBe("/tmp/not-the-uppercase-variable");
	});
});

describe("buildGitCommandArgs", () => {
	it("enables Git for Windows long-path handling without changing other platforms", () => {
		expect(buildGitCommandArgs(["status"], "win32")).toEqual([
			"-c",
			"core.quotepath=false",
			"-c",
			"core.longpaths=true",
			"status",
		]);
		expect(buildGitCommandArgs(["status"], "linux")).toEqual(["-c", "core.quotepath=false", "status"]);
	});
});
