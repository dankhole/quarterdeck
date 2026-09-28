import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWindowsProcessArgsCommandLine } from "../../src/core/windows-cmd-launch";
import { spawnWindowsLanguageProcess } from "../../src/language-navigation/windows-process-owner";

// These assertions require kernel Job Object behavior; mocked launches on POSIX
// cannot establish worker cleanup after the server or supervisor disappears.
describe.skipIf(process.platform !== "win32")("native Windows language process ownership", () => {
	let directory: string | undefined;
	let owner: ChildProcessWithoutNullStreams | undefined;
	afterEach(async () => {
		if (owner && owner.exitCode === null && owner.signalCode === null) {
			const closed = new Promise<void>((done) => owner?.once("close", () => done()));
			owner.kill("SIGKILL");
			await closed;
		}
		if (directory) await rm(directory, { force: true, recursive: true });
	});

	it("closes the kernel job when its supervisor is forcibly terminated", async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-lsp-job-"));
		const events = join(directory, "events.jsonl");
		owner = spawnWindowsLanguageProcess(
			process.execPath,
			[resolve("test/utilities/fake-language-server.mjs")],
			directory,
			{ ...process.env, LSP_TEST_CHILD: "1", LSP_TEST_EVENTS: events },
		);
		owner.stdout.resume();
		owner.stderr.resume();
		let child: { pid: number; childPid: number } | undefined;
		await expect
			.poll(
				async () => {
					try {
						child = JSON.parse((await readFile(events, "utf8")).trim().split("\n")[0]);
						return child?.childPid;
					} catch {
						return undefined;
					}
				},
				{ timeout: 10_000 },
			)
			.toEqual(expect.any(Number));
		const exited = new Promise<void>((done) => owner?.once("exit", () => done()));
		expect(owner.kill("SIGKILL")).toBe(true);
		await exited;
		for (const pid of [child?.pid, child?.childPid]) {
			await expect
				.poll(() => {
					try {
						process.kill(Number(pid), 0);
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
		}
	});
	it("preserves long Unicode argv at the native limit without inheriting transport variables", async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-lsp-job-argv-"));
		const code =
			"process.stdout.write(JSON.stringify({argument:process.argv[1],transport:Object.keys(process.env).filter(k=>k.startsWith('QUARTERDECK_LSP_LAUNCH_'))}))";
		const overhead = buildWindowsProcessArgsCommandLine([process.execPath, "-e", code, ""]).length;
		const argument = `🚢${"语".repeat(32_766 - overhead - 2)}`;
		owner = spawnWindowsLanguageProcess(process.execPath, ["-e", code, argument], directory, process.env);
		let stdout = "";
		owner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		owner.stderr.resume();
		await new Promise<void>((done, reject) => {
			owner?.once("error", reject);
			owner?.once("close", () => done());
		});
		expect(owner.exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ argument, transport: [] });
	});
});
