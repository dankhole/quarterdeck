import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { mainBuildOptions, preloadBuildOptions } from "../scripts/build-options.mjs";
import { desktopRoot } from "../scripts/paths.mjs";

async function generatedMainPrefix(fixture, virtualArchiveView = false) {
	const result = await build({ ...mainBuildOptions, write: false, sourcemap: false });
	const generated = result.outputFiles[0].text;
	const boundary = generated.indexOf("protocol.registerSchemesAsPrivileged([");
	expect(boundary).toBeGreaterThan(0);
	expect(boundary).toBe(generated.lastIndexOf("protocol.registerSchemesAsPrivileged(["));
	const electronStub = join(fixture, "electron.mjs");
	const rawFsStub = join(fixture, "original-fs.mjs");
	await writeFile(
		electronStub,
		"export const app = null, autoUpdater = null, BrowserWindow = null, ipcMain = null, Menu = null, Notification = null, powerMonitor = null, protocol = null, session = null, shell = null, dialog = null, screen = null;\n",
	);
	// Node supplies the raw filesystem API that Electron's original-fs exposes.
	await writeFile(rawFsStub, 'export { default } from "node:fs";\n');
	let prefix = generated
		.slice(0, boundary)
		.replaceAll('from "electron";', `from ${JSON.stringify(pathToFileURL(electronStub).href)};`)
		.replaceAll('from "original-fs";', `from ${JSON.stringify(pathToFileURL(rawFsStub).href)};`);
	const patchedFsStub = join(fixture, "virtual-fs.mjs");
	if (virtualArchiveView) {
		await writeFile(
			patchedFsStub,
			'export * from "node:fs/promises";\nimport { readFile as rawReadFile } from "node:fs/promises";\nexport async function readFile(path, ...args) { if (String(path).endsWith("app.asar")) throw new Error("ASAR is a virtual directory"); return rawReadFile(path, ...args); }\n',
		);
		prefix = prefix.replaceAll(
			'from "node:fs/promises";',
			`from ${JSON.stringify(pathToFileURL(patchedFsStub).href)};`,
		);
	}
	return { prefix, patchedFsStub };
}

describe("generated desktop bundles", () => {
	it("initializes main's actual bundled ws dependencies in ESM before Electron startup", async () => {
		const cache = join(desktopRoot, ".cache");
		await mkdir(cache, { recursive: true });
		const fixture = await mkdtemp(join(cache, "generated-main-test-"));
		try {
			// Electron is inert; original-fs maps to the same raw Node API. Bundled
			// CommonJS factories run as generated, before app/window/runtime effects.
			const { prefix } = await generatedMainPrefix(fixture);
			const main = join(fixture, "main.mjs");
			await writeFile(main, `${prefix}\nconsole.log('quarterdeck-main-dependencies-ready');\n`);
			const initialized = spawnSync(process.execPath, [main], { encoding: "utf8", timeout: 10_000 });
			expect(initialized.error).toBeUndefined();
			expect(initialized.status, initialized.stderr).toBe(0);
			expect(initialized.stdout.trim()).toBe("quarterdeck-main-dependencies-ready");

			// Prove the caller-path regression is sensitive to the original fault,
			// rather than merely recognizing the bridge's source text.
			await writeFile(main, prefix.replace(mainBuildOptions.banner.js, ""));
			const originalFault = spawnSync(process.execPath, [main], { encoding: "utf8", timeout: 10_000 });
			expect(originalFault.error).toBeUndefined();
			expect(originalFault.status).not.toBe(0);
			expect(originalFault.stderr).toContain('Dynamic require of "events" is not supported');
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("hashes actual archive bytes through main's original-fs binding despite Electron's virtual fs view", async () => {
		const cache = join(desktopRoot, ".cache");
		await mkdir(cache, { recursive: true });
		const fixture = await mkdtemp(join(cache, "generated-asar-test-"));
		try {
			const { prefix, patchedFsStub } = await generatedMainPrefix(fixture, true);
			const resources = join(fixture, "Quarterdeck.app", "Contents", "Resources");
			const runtime = join(resources, "runtime");
			await mkdir(join(runtime, "bin"), { recursive: true });
			await mkdir(join(runtime, "dist"));
			await writeFile(join(runtime, "bin", "node"), "synthetic-node");
			await writeFile(join(runtime, "dist", "cli.js"), "synthetic-cli");
			await writeFile(
				join(runtime, "bundle-manifest.json"),
				JSON.stringify({
					desktopLaunchProtocolVersion: 1,
					platform: "darwin",
					arch: "arm64",
					version: "0.12.8",
					buildId: "build-current",
					sourceSha: "a".repeat(40),
				}),
			);
			const archive = join(resources, "app.asar");
			await writeFile(archive, "raw-archive-bytes");
			const args = [archive, runtime, "0.12.8", "arm64"].map((value) => JSON.stringify(value)).join(", ");
			const main = join(fixture, "main.mjs");
			await writeFile(
				main,
				`${prefix}\nconsole.log((await readDesktopLaunchAppIdentity(${args}, readDesktopArchive)).appAsarSha256);\n`,
			);
			const raw = spawnSync(process.execPath, [main], { encoding: "utf8", timeout: 10_000 });
			expect(raw.error).toBeUndefined();
			expect(raw.status, raw.stderr).toBe(0);
			expect(raw.stdout.trim()).toBe(createHash("sha256").update("raw-archive-bytes").digest("hex"));
			// An ordinary archive read must hit the virtual-directory fault, proving
			// this generated caller test would catch the original patched-fs bug.
			await writeFile(
				main,
				`${prefix}\nawait readDesktopLaunchAppIdentity(${args}, (await import(${JSON.stringify(pathToFileURL(patchedFsStub).href)})).readFile);\n`,
			);
			const virtual = spawnSync(process.execPath, [main], { encoding: "utf8", timeout: 10_000 });
			expect(virtual.error).toBeUndefined();
			expect(virtual.status).not.toBe(0);
			expect(virtual.stderr).toContain("ASAR is a virtual directory");
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("keeps generated preload CJS compatible with an electron-only sandbox require", async () => {
		const result = await build({ ...preloadBuildOptions, write: false, sourcemap: false });
		const required = [];
		const exposed = [];
		runInNewContext(result.outputFiles[0].text, {
			window: { location: { protocol: "app:", host: "quarterdeck", pathname: "/__desktop/starting" } },
			require: (name) => {
				required.push(name);
				if (name !== "electron") throw new Error(`Unavailable sandbox module: ${name}`);
				return { contextBridge: { exposeInMainWorld: (...args) => exposed.push(args) }, ipcRenderer: {} };
			},
		});
		expect(required).toEqual(["electron"]);
		expect(exposed).toEqual([]);
	});
});
