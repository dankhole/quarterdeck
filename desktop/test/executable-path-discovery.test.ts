import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDesktopExecutableDirectories } from "../src/executable-path-discovery.js";
import { createDesktopLaunchEnvironmentResolver } from "../src/launch-environment.js";

const fixtures: string[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHome(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-executable-discovery-"));
	fixtures.push(root);
	const home = join(root, "Home With Spaces");
	await mkdir(home);
	return home;
}

async function writeAlias(nvm: string, name: string, selector: string): Promise<void> {
	const path = join(nvm, "alias", name);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, selector);
}

async function install(nvm: string, version: string): Promise<string> {
	const bin = join(nvm, "versions", "node", version, "bin");
	await mkdir(bin, { recursive: true });
	// Discovery must only inspect the filesystem; these files must never execute.
	await writeFile(join(bin, "node"), "throw new Error('do not execute discovery fixtures');\n", { mode: 0o755 });
	await writeFile(join(bin, "codex"), "throw new Error('do not execute discovery fixtures');\n", { mode: 0o755 });
	return bin;
}

describe("desktop executable directory discovery", () => {
	it("finds existing direct user installation directories in a fixed order", async () => {
		const home = await createHome();
		const expected = [".local/bin", ".npm-global/bin", "bin", ".volta/bin"].map((path) => join(home, path));
		await Promise.all(expected.map((path) => mkdir(path, { recursive: true })));
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual(expected);
	});

	it("does not add absent directories or regular files named bin", async () => {
		const home = await createHome();
		await writeFile(join(home, "bin"), "not a directory");
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([]);
	});

	it("uses explicit absolute manager roots without reading the default roots", async () => {
		const home = await createHome();
		const nvm = join(home, "Custom Node Manager");
		const volta = join(home, "Custom Volta");
		const selected = await install(nvm, "v22.15.0");
		await install(join(home, ".nvm"), "v99.0.0");
		await mkdir(join(volta, "bin"), { recursive: true });
		await writeAlias(nvm, "default", "22");
		expect(await discoverDesktopExecutableDirectories({ HOME: home, NVM_DIR: nvm, VOLTA_HOME: volta })).toEqual([
			join(volta, "bin"),
			selected,
		]);
	});

	it("uses a supplied home fallback and rejects unsafe manager paths", async () => {
		const home = await createHome();
		const expected = join(home, ".local", "bin");
		await mkdir(expected, { recursive: true });
		const getHomeDirectory = vi.fn(() => home);
		expect(
			await discoverDesktopExecutableDirectories(
				{ HOME: "relative", NVM_DIR: "/invalid\0root", VOLTA_HOME: "relative" },
				{ getHomeDirectory },
			),
		).toEqual([expected]);
		expect(getHomeDirectory).toHaveBeenCalledOnce();
	});

	it.each(["v20.9.0", "20.9.0", "20", "v20.9"])(
		"selects the installed version matching default %s",
		async (selector) => {
			const home = await createHome();
			const nvm = join(home, ".nvm");
			await install(nvm, "v20.8.0");
			const expected = await install(nvm, "v20.9.0");
			await install(nvm, "v24.1.0");
			await writeAlias(nvm, "default", `${selector}\n`);
			expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
		},
	);

	it("resolves default and LTS alias chains without executing nvm", async () => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		const expected = await install(nvm, "v22.17.0");
		await install(nvm, "v24.1.0");
		await writeAlias(nvm, "default", "work");
		await writeAlias(nvm, "work", "lts/*");
		await writeAlias(nvm, "lts/*", "lts/jod");
		await writeAlias(nvm, "lts/jod", "v22.17.0");
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
	});

	it("honors an explicit nvm system default", async () => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		await install(nvm, "v24.1.0");
		await writeAlias(nvm, "default", "system");
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([]);
	});

	it.each(["node", "stable"])("selects the numerically latest stable installed version for %s", async (selector) => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		await install(nvm, "v9.99.0");
		await install(nvm, "v24.2.0");
		const expected = await install(nvm, "v24.11.0");
		await install(nvm, "v25.0.0-rc.1");
		await writeAlias(nvm, "default", selector);
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
	});

	it.each(["missing", "cycle", "oversized", "malformed", "unavailable", "symlink", "invalid-utf8"])(
		"uses deterministic installed fallback when default metadata is %s",
		async (condition) => {
			const home = await createHome();
			const nvm = join(home, ".nvm");
			await install(nvm, "v20.10.0");
			const expected = await install(nvm, "v22.2.0");
			if (condition === "cycle") {
				await writeAlias(nvm, "default", "work");
				await writeAlias(nvm, "work", "default");
			} else if (condition === "oversized") await writeAlias(nvm, "default", "v20.10.0".padEnd(1025, " "));
			else if (condition === "malformed") await writeAlias(nvm, "default", "../../outside");
			else if (condition === "unavailable") await writeAlias(nvm, "default", "18");
			else if (condition === "symlink") {
				await writeAlias(nvm, "work", "v20.10.0");
				await symlink("work", join(nvm, "alias", "default"));
			} else if (condition === "invalid-utf8") {
				await writeAlias(nvm, "default", "ignored");
				await writeFile(join(nvm, "alias", "default"), Buffer.from([0xff]));
			}
			expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"ignores unreadable alias metadata",
		async () => {
			const home = await createHome();
			const nvm = join(home, ".nvm");
			await install(nvm, "v20.10.0");
			const expected = await install(nvm, "v22.2.0");
			await writeAlias(nvm, "default", "v20.10.0");
			await chmod(join(nvm, "alias", "default"), 0);
			expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
		},
	);

	it.skipIf(process.platform === "win32")("does not block opening FIFO alias metadata", async () => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		const expected = await install(nvm, "v22.2.0");
		await mkdir(join(nvm, "alias"));
		execFileSync("/usr/bin/mkfifo", [join(nvm, "alias", "default")]);
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
	});

	it("skips incomplete or non-executable nvm installations", async () => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		const expected = await install(nvm, "v20.10.0");
		await mkdir(join(nvm, "versions", "node", "v22.0.0", "bin"), { recursive: true });
		const nonExecutable = await install(nvm, "v24.0.0");
		await rm(join(nonExecutable, "node"));
		await mkdir(join(nonExecutable, "node"));
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([expected]);
	});

	it("bounds alias traversal even for a long acyclic chain", async () => {
		const readRegularFile = vi.fn(
			async (_path: string, _maxBytes: number): Promise<string> => `alias${readRegularFile.mock.calls.length}`,
		);
		await discoverDesktopExecutableDirectories(
			{ HOME: "/synthetic/home" },
			{
				fileSystem: {
					isDirectory: async () => false,
					isExecutableFile: async () => false,
					readDirectory: async () => [],
					readRegularFile,
				},
			},
		);
		expect(readRegularFile).toHaveBeenCalledTimes(8);
		expect(readRegularFile.mock.calls.every((call) => call[1] === 1024)).toBe(true);
	});

	it("ignores an nvm directory whose listing exceeds the fixed scan bound", async () => {
		const home = await createHome();
		const nvm = join(home, ".nvm");
		await install(nvm, "v22.2.0");
		await Promise.all(
			Array.from({ length: 512 }, (_, index) => mkdir(join(nvm, "versions", "node", `irrelevant-${index}`))),
		);
		expect(await discoverDesktopExecutableDirectories({ HOME: home })).toEqual([]);
	});

	it("merges discovery after inherited PATH, before system fallback, with pinned Node first", async () => {
		const home = await createHome();
		const direct = join(home, ".local", "bin");
		await mkdir(direct, { recursive: true });
		const nvm = join(home, ".nvm");
		const selected = await install(nvm, "v22.15.0");
		await writeAlias(nvm, "default", "22");
		const getLoginShell = vi.fn(() => "/bin/zsh");
		const spawnCapture = vi.fn(() => {
			throw new Error("shell must never run by default");
		});
		const inherited = { HOME: home, PATH: `/caller/bin:${direct}:/usr/bin:/caller/bin`, TERM_PROGRAM: "Terminal" };
		const resolver = createDesktopLaunchEnvironmentResolver({
			nodePath: "/Application With Spaces/runtime/bin/node",
			inheritedEnvironment: inherited,
			platform: "darwin",
			getLoginShell,
			spawnCapture,
		});
		const result = await resolver();
		expect(result.source).toBe("inherited");
		expect(result.environment.PATH?.split(":")).toEqual([
			"/Application With Spaces/runtime/bin",
			"/caller/bin",
			direct,
			"/usr/bin",
			selected,
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]);
		expect(getLoginShell).not.toHaveBeenCalled();
		expect(spawnCapture).not.toHaveBeenCalled();
		expect(await resolver()).toBe(result);
		expect(inherited.PATH).toBe(`/caller/bin:${direct}:/usr/bin:/caller/bin`);
	});

	it("preserves discovered directories when an unsafe inherited PATH is rejected", async () => {
		const home = await createHome();
		const direct = join(home, ".local", "bin");
		await mkdir(direct, { recursive: true });
		const result = await createDesktopLaunchEnvironmentResolver({
			nodePath: "/Bundle/runtime/bin/node",
			inheritedEnvironment: { HOME: home, PATH: "/unsafe\0path", NODE_OPTIONS: "--require untrusted.js" },
			platform: "darwin",
		})();
		expect(result.environment.PATH?.split(":").slice(0, 3)).toEqual([
			"/Bundle/runtime/bin",
			direct,
			"/usr/local/bin",
		]);
		expect(result.environment.NODE_OPTIONS).toBeUndefined();
	});
});
