import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getGitProcessLimiterSnapshot, runGit } from "../../src/workdir/git-utils";
import { createTempDir } from "../utilities/temp-dir";

const fixtures: Array<{ cleanup: () => void }> = [];

/** Puts a synthetic `git` first on PATH for the spawned command only. */
function fakeGit(script: string): NodeJS.ProcessEnv {
	const fixture = createTempDir("quarterdeck-fake-git-");
	fixtures.push(fixture);
	const binary = join(fixture.path, "git");
	writeFileSync(binary, `#!/bin/sh\n${script}\n`);
	chmodSync(binary, 0o755);
	return { ...process.env, PATH: `${fixture.path}:${process.env.PATH ?? ""}` };
}

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe.skipIf(process.platform === "win32")("Git process termination", () => {
	it("kills a child that ignores SIGTERM and releases its process slot", async () => {
		const env = fakeGit("trap '' TERM\nwhile :; do sleep 1; done");
		const startedAt = Date.now();
		const result = await runGit(process.cwd(), ["status"], { env, timeoutMs: 200 });
		expect(result).toMatchObject({ ok: false, timedOut: true, failureKind: "timed_out" });
		// SIGKILL follows the grace; nothing waits for the ignored SIGTERM.
		expect(Date.now() - startedAt).toBeLessThan(6_000);
		expect(getGitProcessLimiterSnapshot().active).toBe(0);
	});

	it("settles after exit when a grandchild keeps the output pipe open", async () => {
		const env = fakeGit("echo synthetic-output\nsleep 30 &\nexit 0");
		const startedAt = Date.now();
		const result = await runGit(process.cwd(), ["status"], { env, timeoutMs: 20_000 });
		expect(result).toMatchObject({ ok: true, stdout: "synthetic-output" });
		expect(Date.now() - startedAt).toBeLessThan(6_000);
		expect(getGitProcessLimiterSnapshot().active).toBe(0);
	});

	it("settles a timed-out command whose grandchild keeps the output pipe open", async () => {
		const env = fakeGit("sleep 30 &\nwait");
		const startedAt = Date.now();
		const result = await runGit(process.cwd(), ["status"], { env, timeoutMs: 300 });
		expect(result).toMatchObject({ ok: false, timedOut: true });
		expect(Date.now() - startedAt).toBeLessThan(6_000);
		expect(getGitProcessLimiterSnapshot().active).toBe(0);
	});

	it("passes stdin to the command and closes it", async () => {
		const env = fakeGit("cat");
		await expect(
			runGit(process.cwd(), ["update-ref", "--stdin"], { env, stdin: "start\ncommit\n" }),
		).resolves.toMatchObject({
			ok: true,
			stdout: "start\ncommit",
		});
	});
});
