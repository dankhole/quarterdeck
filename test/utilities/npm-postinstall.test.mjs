import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
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
			const path = join(root, "npm-postinstall.cjs");
			await writeFile(path, await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123" }));
			const result = spawnSync(process.execPath, [path], { env: { ...process.env, ...globalInstall, CI: "false", QUARTERDECK_INSTALL_MODE: "", HOME: root, QUARTERDECK_STATE_HOME: join(root, "state") }, encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("published lifecycle entrypoint is missing");
			expect(result.stderr).toContain("npm install -g quarterdeck@0.0.123 --foreground-scripts");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!supportedMac)("reports exact retry guidance after an actual isolated global npm hook failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-failed-global-npm-"));
		try {
			const packageRoot = join(root, "fixture");
			const prefix = join(root, "prefix");
			await mkdir(join(packageRoot, "dist"), { recursive: true });
			await writeFile(join(packageRoot, "npm-postinstall.cjs"), await readFile(new URL("../../npm-postinstall.cjs", import.meta.url)));
			await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('synthetic fixture');\n", { mode: 0o755 });
			await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.0.123", bin: { quarterdeck: "dist/cli.js" }, scripts: { postinstall: "node npm-postinstall.cjs" } }));
			const env = { ...process.env, CI: "false", QUARTERDECK_INSTALL_MODE: "", HOME: root, USERPROFILE: root, QUARTERDECK_STATE_HOME: join(root, "state"), npm_config_cache: join(root, "cache"), npm_config_prefix: prefix, npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc") };
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
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("published lifecycle entrypoint is missing");
			expect(result.stderr).toContain("npm install -g quarterdeck@0.0.123 --foreground-scripts");
			const retention = { package: existsSync(join(prefix, "lib", "node_modules", "quarterdeck", "package.json")), bin: existsSync(join(prefix, "bin", "quarterdeck")) };
			expect(retention).toEqual({ package: false, bin: false });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("distinguishes direct npm link from global install without requiring dependencies", () => {
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", false)).toBe(true);
		expect(launcher.shouldRunPostinstall({ ...globalInstall, npm_command: "link" }, "darwin", "arm64", "25.0", false)).toBe(false);
		expect(launcher.shouldRunPostinstall(globalInstall, "darwin", "arm64", "25.0", true)).toBe(false);
	});
});
