import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopAppRoot } from "../src/app-layout.js";
import { withDesktopPath } from "../src/helper-path.js";
import { createDesktopLaunchEnvironmentResolver, sanitizeDesktopHelperEnvironment } from "../src/launch-environment.js";
import { desktopMenuTemplate } from "../src/native-menus.js";
import { readRuntimeBundle } from "../src/runtime-bundle.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows desktop portability", () => {
	it("rejects current-drive-relative executables and excludes rooted PATH entries", () => {
		expect(() => withDesktopPath({}, "\\app\\node.exe", [], "win32")).toThrow("absolute path");
		expect(withDesktopPath({ Path: "\\ambiguous;C:relative;C:\\Tools" }, "C:\\App\\node.exe", [], "win32").PATH).toBe(
			"C:\\App;C:\\Tools",
		);
	});
	it("preserves drive letters, Path casing, spaces and provider configuration without Node injection", () => {
		const environment = sanitizeDesktopHelperEnvironment(
			{
				Path: "C:\\Tools;D:\\Agent Tools;c:\\tools;;relative",
				NODE_OPTIONS: "--inspect",
				node_path: "injection",
				PROVIDER_TOKEN: "synthetic",
			},
			"C:\\Quarterdeck\\bin\\node.exe",
			[],
			"win32",
		);
		expect(environment.PATH).toBe("C:\\Quarterdeck\\bin;C:\\Tools;D:\\Agent Tools");
		expect(environment.Path).toBeUndefined();
		expect(environment.NODE_OPTIONS).toBeUndefined();
		expect(environment.node_path).toBeUndefined();
		expect(environment.PROVIDER_TOKEN).toBe("synthetic");
		expect(withDesktopPath(environment, "C:\\Quarterdeck\\bin\\node.exe", ["D:\\Agent Tools"], "win32").PATH).toBe(
			"C:\\Quarterdeck\\bin;D:\\Agent Tools;C:\\Tools",
		);
	});
	it("never starts a login shell on Windows", async () => {
		const spawnCapture = vi.fn();
		const result = await createDesktopLaunchEnvironmentResolver({
			nodePath: "C:\\App\\node.exe",
			inheritedEnvironment: { Path: "C:\\Agents" },
			platform: "win32",
			mode: "login-shell",
			spawnCapture,
		})();
		expect(result.source).toBe("inherited");
		expect(result.environment.PATH).toBe("C:\\App;C:\\Agents");
		expect(spawnCapture).not.toHaveBeenCalled();
	});
	it("resolves platform package layouts and rejects unrecognized archive paths", () => {
		expect(desktopAppRoot("C:\\Program Files\\Quarterdeck\\resources\\app.asar", "win32")).toBe(
			"C:\\Program Files\\Quarterdeck",
		);
		expect(desktopAppRoot("/Applications/Quarterdeck.app/Contents/Resources/app.asar", "darwin")).toBe(
			"/Applications/Quarterdeck.app",
		);
		expect(() => desktopAppRoot("C:\\app\\app.asar", "win32")).toThrow("packaged");
	});
	it("loads a Windows Node bundle and refuses a different platform or missing executable", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-windows-bundle-")));
		roots.push(root);
		await mkdir(join(root, "bin"));
		await mkdir(join(root, "dist"));
		await writeFile(join(root, "bin", "node.exe"), "synthetic");
		await writeFile(join(root, "dist", "cli.js"), "synthetic");
		await writeFile(
			join(root, "bundle-manifest.json"),
			JSON.stringify({
				platform: "win32",
				arch: "x64",
				version: "0.12.16",
				desktopLaunchProtocolVersion: 1,
				buildId: "synthetic",
				sourceSha: "a".repeat(40),
			}),
		);
		expect(readRuntimeBundle(root, "0.12.16", "x64", "win32").nodePath).toBe(join(root, "bin", "node.exe"));
		expect(readRuntimeBundle(root, "0.12.16", "x64", "win32").windowsNodeHostPath).toBeUndefined();
		expect(() => readRuntimeBundle(root, "0.12.16", "x64", "win32", true)).toThrow();
		await writeFile(join(root, "bin", "nodeHost.exe"), "synthetic");
		expect(readRuntimeBundle(root, "0.12.16", "x64", "win32", true).windowsNodeHostPath).toBe(
			join(root, "bin", "nodeHost.exe"),
		);
		expect(() => readRuntimeBundle(root, "0.12.16", "x64", "darwin")).toThrow("identity");
		await rm(join(root, "bin", "node.exe"));
		expect(() => readRuntimeBundle(root, "0.12.16", "x64", "win32")).toThrow();
	});
	it("uses Ctrl commands and File application actions without macOS-only menu roles", () => {
		const template = desktopMenuTemplate({
			platform: "win32",
			appName: "Quarterdeck",
			productReady: true,
			availableCommands: ["settings", "new-task"],
			updateGuidanceAvailable: true,
			dispatch: vi.fn(),
			showUpdateGuidance: vi.fn(),
			reloadWindow: vi.fn(),
		});
		const flattened = template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? item.submenu : [])]);
		expect(flattened.find((item) => item.id === "desktop.newTask")?.accelerator).toBe("Ctrl+N");
		expect(
			flattened.some((item) =>
				["services", "hide", "hideOthers", "unhide", "front", "zoom"].includes(String(item.role)),
			),
		).toBe(false);
		const file = template.find((item) => item.label === "File");
		expect(Array.isArray(file?.submenu) && file.submenu.some((item) => item.id === "desktop.settings")).toBe(true);
	});
});
