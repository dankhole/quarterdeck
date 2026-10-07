import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
