import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import launcher from "../../npm-postinstall.cjs";
import { resolveNpmCommand } from "../../scripts/npm-command.mjs";

const globalInstall = { npm_config_global: "true", npm_command: "install", npm_lifecycle_event: "postinstall" };
const supportedMac = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch) && Number.parseInt(release(), 10) >= 22;

describe("source-safe npm lifecycle launcher", () => {
	it("does not require dist during clean source dependency installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-postinstall-"));
		try {
			const path = join(root, "npm-postinstall.cjs");
			await writeFile(path, await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			const result = spawnSync(process.execPath, [path], { env: { ...process.env, npm_config_global: "false", npm_command: "ci" }, encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("runs an actual source npm install without a compiled artifact or app effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-source-npm-"));
		try {
			await writeFile(join(root, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "quarterdeck-source-lifecycle-fixture", version: "1.0.0", scripts: { postinstall: "node npm-postinstall.cjs" } }));
			const env = { ...process.env, HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state"), npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"), npm_config_global: "false" };
			const invocation = resolveNpmCommand(["install", "--offline", "--package-lock=false", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund"], { env });
			const result = spawnSync(invocation.command, invocation.args, { cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("node npm-postinstall.cjs");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac)("fails a supported global package with a missing lifecycle artifact and exact retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-broken-postinstall-"));
		try {
			const prefix = join(root, "prefix");
			const packageRoot = join(prefix, "lib", "node_modules", "quarterdeck");
			await mkdir(packageRoot, { recursive: true });
			const path = join(packageRoot, "npm-postinstall.cjs");
			await writeFile(path, await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123" }));
			const result = spawnSync(process.execPath, [path], { env: { ...process.env, ...globalInstall, npm_config_prefix: prefix, CI: "false", QUARTERDECK_INSTALL_MODE: "desktop", HOME: root, QUARTERDECK_STATE_HOME: join(root, "state") }, encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("published lifecycle entrypoint is missing");
			expect(result.stderr).toContain("QUARTERDECK_INSTALL_MODE=desktop npm install -g quarterdeck@0.0.123 --foreground-scripts");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac).each([undefined, "browser", "desktop"])("uses %s mode in an actual isolated global npm installation", async (installMode) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-failed-global-npm-"));
		try {
			const packageRoot = join(root, "fixture");
			const prefix = join(root, "prefix");
			await mkdir(join(packageRoot, "dist"), { recursive: true });
			await writeFile(join(packageRoot, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('synthetic fixture');\n", { mode: 0o755 });
			await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123", bin: { quarterdeck: "dist/cli.js" }, scripts: { postinstall: "node npm-postinstall.cjs" } }));
			const env = { ...process.env, CI: "false", QUARTERDECK_INSTALL_MODE: installMode, HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state"), npm_config_cache: join(root, "cache"), npm_config_prefix: prefix, npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc") };
			const pinnedNpm = fileURLToPath(new URL("../../.cache/npm-tools/node_modules/npm/bin/npm-cli.js", import.meta.url));
			const runNpm = (args) => {
				const invocation = existsSync(pinnedNpm) ? { command: process.execPath, args: [pinnedNpm, ...args] } : resolveNpmCommand(args, { env });
				return spawnSync(invocation.command, invocation.args, { cwd: packageRoot, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
			};
			const packed = runNpm(["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", root]);
			expect(packed.error).toBeUndefined();
			expect(packed.status, packed.stderr).toBe(0);
			const artifact = join(root, JSON.parse(packed.stdout)[0].filename);
			const result = runNpm(["install", "--global", "--prefix", prefix, "--offline", "--package-lock=false", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund", artifact]);
			expect(result.error).toBeUndefined();
			if (installMode === "desktop") {
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("published lifecycle entrypoint is missing");
				expect(result.stderr).toContain("QUARTERDECK_INSTALL_MODE=desktop npm install -g quarterdeck@0.0.123 --foreground-scripts");
			} else {
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("node npm-postinstall.cjs");
				expect(existsSync(join(root, "Applications"))).toBe(false);
				expect(existsSync(join(root, "Library"))).toBe(false);
			}
			const retention = { package: existsSync(join(prefix, "lib", "node_modules", "quarterdeck", "package.json")), bin: existsSync(join(prefix, "bin", "quarterdeck")) };
			expect(retention).toEqual({ package: installMode !== "desktop", bin: installMode !== "desktop" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac).each([
		{ label: "fresh ad-hoc default", capability: "adhoc-v1", mode: undefined, desktopDefault: true },
		{ label: "ignored legacy browser mode", capability: "adhoc-v1", mode: "browser", desktopDefault: true },
		{ label: "fresh signed default", capability: "signed-v1", mode: undefined, desktopDefault: true },
		{ label: "ignored saved browser preference", capability: "adhoc-v1", mode: undefined, desktopDefault: true, savedPreference: true },
		{ label: "headless ad-hoc runtime path", capability: "adhoc-v1", mode: undefined, desktopDefault: false, graphicalSession: false },
		{ label: "SSH ad-hoc runtime path", capability: "adhoc-v1", mode: undefined, desktopDefault: false, ssh: true },
	])("preserves $label through actual packed global npm installation and upgrade", async ({ capability, mode, desktopDefault, graphicalSession = true, ssh = false, savedPreference = false }) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-packed-lifecycle-"));
		try {
			const packageRoot = join(root, "fixture");
			const prefix = join(root, "prefix");
			const installedRoot = join(prefix, "lib", "node_modules", "quarterdeck");
			const preference = join(installedRoot, "..", ".quarterdeck-install-mode.json");
			const installLog = join(root, "synthetic-install.jsonl");
			if (savedPreference) {
				await mkdir(join(installedRoot, ".."), { recursive: true });
				await writeFile(preference, JSON.stringify({ schemaVersion: 1, mode: "browser" }));
			}
			await mkdir(join(packageRoot, "dist"), { recursive: true });
			await writeFile(join(packageRoot, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('synthetic fixture');\n", { mode: 0o755 });
			// Only OS session inspection is faked; npm still executes the actual hook
			// and canonical global-slot check on the installed package.
			await writeFile(join(packageRoot, "fake-session.cjs"), "const child=require('node:child_process'); const original=child.spawnSync; child.spawnSync=(command,...args)=>command==='/bin/launchctl'?{status:0,stdout:process.env.FIXTURE_GRAPHICAL_SESSION==='true'?'Aqua':'Background'}:original(command,...args);\n");
			// This is the entire installer: log invocation/version. No production installer,
			// desktop dependencies, network access, or application/runtime launch is included.
			await writeFile(join(packageRoot, "dist", "npm-install.js"), "const {appendFileSync}=require('node:fs'); appendFileSync(process.env.FIXTURE_INSTALL_LOG, JSON.stringify({version:require('../package.json').version, mode:process.env.QUARTERDECK_INSTALL_MODE ?? null})+'\\n');\n");
			const env = { ...process.env, CI: "false", HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state"), FIXTURE_INSTALL_LOG: installLog, FIXTURE_GRAPHICAL_SESSION: String(graphicalSession), SSH_CONNECTION: ssh ? "fixture remote" : undefined, SSH_TTY: undefined, npm_config_cache: join(root, "cache"), npm_config_prefix: prefix, npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc") };
			const pinnedNpm = fileURLToPath(new URL("../../.cache/npm-tools/node_modules/npm/bin/npm-cli.js", import.meta.url));
			const runNpm = (args, installMode) => {
				const childEnv = { ...env, QUARTERDECK_INSTALL_MODE: installMode };
				const invocation = existsSync(pinnedNpm) ? { command: process.execPath, args: [pinnedNpm, ...args] } : resolveNpmCommand(args, { env: childEnv });
				const result = spawnSync(invocation.command, invocation.args, { cwd: packageRoot, env: childEnv, encoding: "utf8", timeout: 15_000, windowsHide: true });
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				return result;
			};
			const install = async (version, desktopRelease, installMode) => {
				await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version, quarterdeck: { desktopRelease }, files: ["dist", "npm-postinstall.cjs", "fake-session.cjs"], bin: { quarterdeck: "dist/cli.js" }, scripts: { postinstall: "node --require ./fake-session.cjs npm-postinstall.cjs" } }));
				const packed = runNpm(["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", root]);
				const artifact = join(root, JSON.parse(packed.stdout)[0].filename);
				const result = runNpm(["install", "--global", "--prefix", prefix, "--offline", "--package-lock=false", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund", artifact], installMode);
				expect(result.stdout).toContain("npm-postinstall.cjs");
				if (installMode === "browser" || savedPreference) expect(result.stderr).toContain("preferences no longer apply");
				const invoked = existsSync(installLog) && (await readFile(installLog, "utf8")).includes(version);
				if (!invoked) {
					expect(result.stderr).toContain("Desktop app installation was skipped");
					expect(result.stderr).toContain("CLI package alone is not a working Quarterdeck app");
					expect(result.stderr).toContain("quarterdeck desktop install");
				} else expect(result.stderr).not.toContain("installation was skipped");
				if (desktopRelease === "adhoc-v1" && invoked) {
					expect(result.stdout).toContain("not Apple-notarized");
					expect(result.stdout).toContain("Privacy & Security > Open Anyway");
					expect(result.stdout).toContain("Managed Macs may block it");
				} else expect(result.stdout).not.toContain("Open Anyway");
				expect(JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")).version).toBe(version);
				expect(existsSync(join(prefix, "bin", "quarterdeck"))).toBe(true);
			};
			const calls = async () => existsSync(installLog) ? (await readFile(installLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) : [];
			await install("0.0.123", capability, mode);
			const firstCalls = desktopDefault ? [{ version: "0.0.123", mode: mode ?? null }] : [];
			expect(await calls()).toEqual(firstCalls);
			expect(existsSync(preference)).toBe(savedPreference);
			await install("0.0.124", capability, undefined);
			expect(await calls()).toEqual(desktopDefault ? [...firstCalls, { version: "0.0.124", mode: null }] : []);
			await install("0.0.125", capability, "desktop");
			expect((await calls()).at(-1)).toEqual({ version: "0.0.125", mode: "desktop" });
			expect(existsSync(preference)).toBe(savedPreference);
			if (savedPreference) expect(JSON.parse(await readFile(preference, "utf8"))).toEqual({ schemaVersion: 1, mode: "browser" });
			expect(existsSync(join(root, "Applications"))).toBe(false);
			expect(existsSync(join(root, "Library"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac)("keeps CI global package hooks quiet without installing an app", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-ci-postinstall-"));
		try {
			const prefix = join(root, "prefix");
			const packageRoot = join(prefix, "lib", "node_modules", "quarterdeck");
			await mkdir(packageRoot, { recursive: true });
			await writeFile(join(packageRoot, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123", quarterdeck: { desktopRelease: "adhoc-v1" } }));
			await writeFile(join(packageRoot, "..", ".quarterdeck-install-mode.json"), JSON.stringify({ schemaVersion: 1, mode: "browser" }));
			const result = spawnSync(process.execPath, [join(packageRoot, "npm-postinstall.cjs")], {
				env: { ...process.env, ...globalInstall, npm_config_prefix: prefix, CI: "true", QUARTERDECK_INSTALL_MODE: "browser", HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state") }, encoding: "utf8",
			});
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(existsSync(join(root, "Applications"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac).each([undefined, "desktop"])("keeps a packed nested global dependency inert with %s install mode", async (installMode) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-nested-global-"));
		try {
			const packageRoot = join(root, "quarterdeck");
			const parentRoot = join(root, "parent");
			const prefix = join(root, "prefix");
			const lifecycleLog = join(root, "lifecycle.json");
			const installLog = join(root, "unexpected-installer-call");
			await mkdir(join(packageRoot, "dist"), { recursive: true });
			await mkdir(parentRoot);
			await writeFile(join(packageRoot, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "probe.cjs"), "require('node:fs').writeFileSync(process.env.FIXTURE_LIFECYCLE_LOG, JSON.stringify({global:process.env.npm_config_global, prefix:process.env.npm_config_prefix, root:__dirname})); const child=require('node:child_process'); const original=child.spawnSync; child.spawnSync=(command,...args)=>command==='/bin/launchctl'?{status:0,stdout:'Aqua'}:original(command,...args);\n");
			await writeFile(join(packageRoot, "dist", "npm-install.js"), "require('node:fs').writeFileSync(process.env.FIXTURE_INSTALL_LOG, 'unexpected installer invocation');\n");
			await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123", quarterdeck: { desktopRelease: "adhoc-v1" }, scripts: { postinstall: "node --require ./probe.cjs npm-postinstall.cjs" } }));
			const env = { ...process.env, CI: "false", HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state"), QUARTERDECK_INSTALL_MODE: installMode, FIXTURE_LIFECYCLE_LOG: lifecycleLog, FIXTURE_INSTALL_LOG: installLog, npm_config_cache: join(root, "cache"), npm_config_prefix: prefix, npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc") };
			const pinnedNpm = fileURLToPath(new URL("../../.cache/npm-tools/node_modules/npm/bin/npm-cli.js", import.meta.url));
			const runNpm = (args, cwd) => {
				const invocation = existsSync(pinnedNpm) ? { command: process.execPath, args: [pinnedNpm, ...args] } : resolveNpmCommand(args, { env });
				const result = spawnSync(invocation.command, invocation.args, { cwd, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				return result;
			};
			const packed = runNpm(["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", root], packageRoot);
			const dependency = join(root, JSON.parse(packed.stdout)[0].filename);
			await writeFile(join(parentRoot, "package.json"), JSON.stringify({ name: "quarterdeck-parent-fixture", version: "1.0.0", dependencies: { quarterdeck: `file:${dependency}` } }));
			const parentPacked = runNpm(["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", root], parentRoot);
			const parentArtifact = join(root, JSON.parse(parentPacked.stdout)[0].filename);
			runNpm(["install", "--global", "--prefix", prefix, "--offline", "--package-lock=false", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund", parentArtifact], parentRoot);
			const nestedRoot = join(prefix, "lib", "node_modules", "quarterdeck-parent-fixture", "node_modules", "quarterdeck");
			expect(JSON.parse(await readFile(lifecycleLog, "utf8"))).toEqual({ global: "true", prefix, root: await realpath(nestedRoot) });
			expect(existsSync(join(nestedRoot, "package.json"))).toBe(true);
			expect(existsSync(installLog)).toBe(false);
			expect(existsSync(join(prefix, "lib", "node_modules", ".quarterdeck-install-mode.json"))).toBe(false);
			expect(existsSync(join(nestedRoot, "..", ".quarterdeck-install-mode.json"))).toBe(false);
			expect(existsSync(join(root, "Applications"))).toBe(false);
			expect(existsSync(join(root, "Library"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("enables automatic lifecycle work only for a desktop-capable supported global install", () => {
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", false, true, true, true)).toBe(true);
		expect(launcher.shouldRunPostinstall({ ...globalInstall, npm_command: "update" }, "darwin", "arm64", "25.0", false, true, true, true)).toBe(true);
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", false, true, false, true)).toBe(false);
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", false, true, true, false)).toBe(false);
		expect(launcher.shouldRunPostinstall({ ...globalInstall, QUARTERDECK_INSTALL_MODE: "browser" }, "darwin", "arm64", "25.0", false, true, true, true)).toBe(true);
		for (const env of [{ ...globalInstall, CI: "true" }, { ...globalInstall, SSH_CONNECTION: "remote" }, { ...globalInstall, SSH_TTY: "/dev/ttys001" }, { ...globalInstall, npm_config_global: "false" }, { ...globalInstall, npm_command: "exec" }]) {
			expect(launcher.shouldRunPostinstall(env, "darwin", "arm64", "25.0", false, true, true, true)).toBe(false);
		}
		for (const [platform, arch, release] of [["linux", "x64", "25"], ["win32", "x64", "6.3"], ["darwin", "arm64", "21"], ["darwin", "ia32", "25"]]) {
			expect(launcher.shouldRunPostinstall(globalInstall, platform, arch, release, false, true, true, true)).toBe(false);
		}
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "x64", "22.0", false, true, true, true)).toBe(true);
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", true, true, true, true)).toBe(false);
	});

	it("distinguishes direct npm link from global install without requiring dependencies", () => {
		const desktopInstall = { ...globalInstall, QUARTERDECK_INSTALL_MODE: "desktop" };
		expect(launcher.shouldRunPostinstall(desktopInstall, "darwin", "arm64", "25.0", false, false, true)).toBe(true);
		expect(launcher.shouldRunPostinstall({ ...desktopInstall, npm_command: "link" }, "darwin", "arm64", "25.0", false, false, true)).toBe(false);
		expect(launcher.shouldRunPostinstall(desktopInstall, "darwin", "arm64", "25.0", true, false, true)).toBe(false);
	});
	it.each([undefined, "", "browser", "unknown"])("does not invent desktop artifacts for undeclared releases with %s mode", (installMode) => {
		expect(launcher.shouldRunPostinstall({ ...globalInstall, QUARTERDECK_INSTALL_MODE: installMode }, "darwin", "arm64", "25.0", false, false, true)).toBe(false);
	});
});
