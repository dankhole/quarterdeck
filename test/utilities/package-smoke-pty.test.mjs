import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInstalledPty, probePty } from "../../scripts/package-smoke-pty.mjs";

function terminalFixture() {
	let onData;
	let onExit;
	const terminal = {
		pid: 12345,
		write: vi.fn(),
		kill: vi.fn(),
		onData: vi.fn((listener) => {
			onData = listener;
			return { dispose: vi.fn() };
		}),
		onExit: vi.fn((listener) => {
			onExit = listener;
			return { dispose: vi.fn() };
		}),
	};
	return {
		terminal,
		pty: { spawn: vi.fn(() => terminal) },
		data: (data) => onData(data),
		exit: (exitCode = 0, signal = 0) => onExit({ exitCode, signal }),
	};
}

describe("installed artifact native PTY smoke", () => {
	let root;
	afterEach(async () => {
		vi.useRealTimers();
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("requires a ready TTY, submitted input, success output, and normal exit", async () => {
		const fixture = terminalFixture();
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, isAlive: () => false });
		fixture.data("quarterdeck-installed-pty-");
		expect(fixture.terminal.write).not.toHaveBeenCalled();
		fixture.data("ready");
		expect(fixture.terminal.write).toHaveBeenCalledExactlyOnceWith("quarterdeck-installed-pty-input");
		fixture.data("quarterdeck-installed-pty-ok");
		fixture.exit();
		await expect(result).resolves.toEqual({ pid: 12345, exitCode: 0 });
	});

	it("rejects a clean exit whose output did not establish usable TTY transport", async () => {
		const fixture = terminalFixture();
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, isAlive: () => false });
		fixture.data("quarterdeck-installed-pty-ready");
		fixture.data("quarterdeck-installed-pty-input");
		fixture.exit();
		await expect(result).rejects.toThrow("input=true, output=false");
	});

	it.each([
		[41, 0],
		[0, 9],
	])("rejects native child failure or signal (%i, %i)", async (exitCode, signal) => {
		const fixture = terminalFixture();
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, isAlive: () => false });
		fixture.data("quarterdeck-installed-pty-readyquarterdeck-installed-pty-ok");
		fixture.exit(exitCode, signal);
		await expect(result).rejects.toThrow(`exitCode=${exitCode}, signal=${signal}`);
	});

	it("kills only the probe terminal on timeout and waits for its exit", async () => {
		vi.useFakeTimers();
		const fixture = terminalFixture();
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, timeoutMs: 10, isAlive: () => false });
		const rejected = expect(result).rejects.toThrow("before the deadline");
		await vi.advanceTimersByTimeAsync(10);
		expect(fixture.terminal.kill).toHaveBeenCalledOnce();
		fixture.exit(0, 9);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports unconfirmed cleanup when the bounded kill does not establish process absence", async () => {
		vi.useFakeTimers();
		const fixture = terminalFixture();
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, timeoutMs: 10, isAlive: () => true });
		const rejected = expect(result).rejects.toMatchObject({ cleanupConfirmed: false });
		await vi.advanceTimersByTimeAsync(1010);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("captures a native write error, kills the owned terminal, and confirms cleanup", async () => {
		const fixture = terminalFixture();
		fixture.terminal.write.mockImplementation(() => {
			throw new Error("native write failed");
		});
		const result = probePty({ pty: fixture.pty, cwd: "/synthetic", env: {}, isAlive: () => false });
		fixture.data("quarterdeck-installed-pty-ready");
		expect(fixture.terminal.kill).toHaveBeenCalledOnce();
		fixture.exit(0, 9);
		await expect(result).rejects.toMatchObject({ message: "native write failed", cleanupConfirmed: true });
	});

	it("preserves a native spawn failure instead of accepting installed assets alone", async () => {
		const pty = {
			spawn: vi.fn(() => {
				throw new Error("posix_spawn failed");
			}),
		};
		await expect(probePty({ pty, cwd: "/synthetic", env: {} })).rejects.toThrow("posix_spawn failed");
	});

	it.each([
		{ exitCode: 0, reportLivePid: false, expectedStatus: 0, cleanup: "confirmed" },
		{ exitCode: 41, reportLivePid: false, expectedStatus: 1, cleanup: "confirmed" },
		{ exitCode: 0, reportLivePid: true, expectedStatus: 1, cleanup: "unconfirmed" },
	])(
		"finishes the one-shot owner with a referenced output worker (exit=$exitCode, live PID=$reportLivePid)",
		async ({ exitCode, reportLivePid, expectedStatus, cleanup }) => {
			root = await mkdtemp(join(tmpdir(), "quarterdeck-installed-pty-owner-test-"));
			const installRoot = join(root, "install");
			const packageRoot = join(installRoot, "node_modules", "quarterdeck");
			const installedPty = join(packageRoot, "node_modules", "node-pty");
			const installedCli = join(packageRoot, "dist", "cli.js");
			await mkdir(installedPty, { recursive: true });
			await mkdir(join(packageRoot, "dist"));
			await writeFile(installedCli, "");
			await writeFile(
				join(installedPty, "package.json"),
				JSON.stringify({ name: "node-pty", version: "synthetic", main: "index.cjs" }),
			);
			// Model the Windows adapter's referenced worker after a real child's exit.
			// TTY semantics are covered by probePty and the actual installed-artifact gate.
			const childProgram = `
setTimeout(() => process.exit(42), 2000);
process.stdin.on('end', () => process.exit(99));
process.stdin.on('data', () => {
  process.stdout.write('quarterdeck-installed-pty-ok', () => process.exit(${exitCode}));
});
process.stdout.write('quarterdeck-installed-pty-ready');
`;
			await writeFile(
				join(installedPty, "index.cjs"),
				`
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
exports.spawn = (nodeBinary, _args, options) => {
  new Worker('setInterval(() => {}, 1000)', { eval: true });
  const child = spawn(nodeBinary, ['-e', ${JSON.stringify(childProgram)}], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  return {
    pid: ${reportLivePid ? "process.pid" : "child.pid"},
    write: data => child.stdin.write(data),
    kill: () => child.kill(),
    onData(listener) {
      const onData = data => listener(data.toString());
      child.stdout.on('data', onData);
      return { dispose: () => child.stdout.off('data', onData) };
    },
    onExit(listener) {
      const onExit = code => listener({ exitCode: code, signal: 0 });
      child.on('close', onExit);
      return { dispose: () => child.off('close', onExit) };
    },
  };
};
`,
			);
			const result = spawnSync(
				process.execPath,
				[resolve("scripts/package-smoke-pty.mjs"), installedCli, installRoot],
				{ cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true },
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(expectedStatus);
			expect(result.signal).toBeNull();
			expect(result.stdout).toContain(`Installed PTY cleanup ${cleanup}`);
			if (expectedStatus === 0) {
				expect(result.stdout).toContain("TTY input/output passed");
				expect(result.stderr).toBe("");
			} else if (reportLivePid) {
				expect(result.stderr).toContain("did not have confirmed process cleanup");
				expect(result.stdout).toContain("retain the isolated fixture");
			} else {
				expect(result.stderr).toContain("exitCode=41");
			}
		},
		10_000,
	);

	it("rejects a dependency symlink escaping the isolated installation", async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-installed-pty-test-"));
		const installRoot = join(root, "install");
		const packageRoot = join(installRoot, "lib", "node_modules", "quarterdeck");
		const externalPty = join(root, "external-node-pty");
		await mkdir(join(packageRoot, "node_modules"), { recursive: true });
		await mkdir(externalPty);
		await writeFile(join(externalPty, "package.json"), JSON.stringify({ name: "node-pty", version: "synthetic" }));
		await symlink(
			externalPty,
			join(packageRoot, "node_modules", "node-pty"),
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(() => loadInstalledPty(join(packageRoot, "dist", "cli.js"), installRoot)).toThrow(
			"outside the isolated installed package",
		);
	});
});
