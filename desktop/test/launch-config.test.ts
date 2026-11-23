import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFileSystemPathForComparison } from "../../src/core/path-comparison.js";
import { resolveCanonicalRuntimeStateHome } from "../../src/server/runtime-ownership.js";
import type { DesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import { readDesktopLaunchConfig, validateDesktopLaunchRequest } from "../src/launch-config.js";

const roots: string[] = [];
const priorHome = process.env.QUARTERDECK_STATE_HOME;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (priorHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = priorHome;
});

async function temporaryRoot(base = tmpdir()): Promise<string> {
	const path = await mkdtemp(join(base, "quarterdeck-desktop-profile-"));
	roots.push(path);
	return await realpath(path);
}

describe("ordinary desktop profile preparation", () => {
	it("selects the requested canonical profile before default environment storage and retains its project intent", async () => {
		const root = await temporaryRoot();
		mkdirSync(join(root, "project"));
		process.env.QUARTERDECK_STATE_HOME = join(root, "unrelated-env-state");
		const request: DesktopLaunchRequest = {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			appPath: join(root, "Quarterdeck.app"),
			buildId: "build",
			appAsarSha256: "a".repeat(64),
			stateHome: await resolveCanonicalRuntimeStateHome(join(root, "requested-state")),
			projectPath: await realpath(join(root, "project")),
		};
		const first = await readDesktopLaunchConfig(undefined, join(root, "electron"), request);
		expect(first.stateHome).toBe(request.stateHome);
		expect(first.request).toEqual(request);
		expect((await readDesktopLaunchConfig(undefined, join(root, "electron"), request)).userDataPath).toBe(
			first.userDataPath,
		);
		expect(existsSync(request.stateHome)).toBe(false);
		expect((await readDesktopLaunchConfig(undefined, join(root, "electron"))).userDataPath).not.toBe(
			first.userDataPath,
		);
	});
	it("rejects aliased or missing project paths before any runtime or profile storage is selected", async () => {
		const root = await temporaryRoot();
		mkdirSync(join(root, "state"));
		mkdirSync(join(root, "project"));
		symlinkSync(join(root, "state"), join(root, "state-alias"), process.platform === "win32" ? "junction" : "dir");
		symlinkSync(
			join(root, "project"),
			join(root, "project-alias"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const request: DesktopLaunchRequest = {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			appPath: join(root, "Quarterdeck.app"),
			buildId: "build",
			appAsarSha256: "a".repeat(64),
			stateHome: await resolveCanonicalRuntimeStateHome(join(root, "state")),
			projectPath: await realpath(join(root, "project")),
		};
		await expect(validateDesktopLaunchRequest(request)).resolves.toEqual(request);
		await expect(
			validateDesktopLaunchRequest({
				...request,
				stateHome: normalizeFileSystemPathForComparison(join(root, "state-alias")),
			}),
		).rejects.toThrow("canonical state home");
		await expect(
			validateDesktopLaunchRequest({ ...request, projectPath: join(root, "project-alias") }),
		).rejects.toThrow("project is unavailable");
		await expect(validateDesktopLaunchRequest({ ...request, projectPath: join(root, "missing") })).rejects.toThrow();
		expect(existsSync(join(root, "electron"))).toBe(false);
	});
	it("accepts typed fixture requests without weakening lab storage, process or project isolation", async () => {
		// Lab admission uses the real Windows profile's Temp, not an overridden TEMP.
		const base = process.platform === "win32" ? join(userInfo().homedir, "AppData", "Local", "Temp") : tmpdir();
		const root = await temporaryRoot(base);
		const outside = await temporaryRoot(base);
		for (const name of ["state", "electron", "project", "second-project"]) mkdirSync(join(root, name));
		writeFileSync(join(root, "host.json"), "{}", { mode: 0o600 });
		const secondProject = await realpath(join(root, "second-project"));
		const lab = {
			version: 1,
			tempRoot: root,
			stateHome: await resolveCanonicalRuntimeStateHome(join(root, "state")),
			userDataPath: await realpath(join(root, "electron")),
			projectPath: await realpath(join(root, "project")),
			hostSimulationConfigPath: await realpath(join(root, "host.json")),
			processEvidencePath: join(root, "processes.json"),
			showWindow: false,
		};
		const configPath = join(root, "desktop.json");
		writeFileSync(configPath, JSON.stringify(lab), { mode: 0o600 });
		const request: DesktopLaunchRequest = {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			appPath: join(root, "Quarterdeck.app"),
			buildId: "build",
			appAsarSha256: "a".repeat(64),
			stateHome: lab.stateHome,
			projectPath: lab.projectPath,
		};
		const launch = await readDesktopLaunchConfig(configPath, join(outside, "unused-profile"), request);
		expect(launch).toEqual({ ...lab, synthetic: true, labConfigPath: configPath, lab, request });
		expect(existsSync(join(outside, "unused-profile"))).toBe(false);
		await expect(
			readDesktopLaunchConfig(configPath, "unused", {
				...request,
				stateHome: await resolveCanonicalRuntimeStateHome(outside),
			}),
		).rejects.toThrow("exact isolated state home");
		await expect(readDesktopLaunchConfig(configPath, "unused", { ...request, projectPath: outside })).rejects.toThrow(
			"temporary root",
		);
		await expect(
			validateDesktopLaunchRequest({ ...request, projectPath: secondProject }, launch.lab),
		).resolves.toMatchObject({ projectPath: secondProject });
		await expect(validateDesktopLaunchRequest({ ...request, projectPath: outside }, launch.lab)).rejects.toThrow(
			"temporary root",
		);
	});
	it("creates only scoped presentation storage before Electron setPath needs it", async () => {
		const root = await temporaryRoot();
		process.env.QUARTERDECK_STATE_HOME = join(root, "runtime-not-created");
		const launch = await readDesktopLaunchConfig(undefined, join(root, "electron-not-created"));
		expect(launch.synthetic).toBe(false);
		expect(launch.lab).toBeNull();
		expect(existsSync(launch.userDataPath)).toBe(true);
		expect(existsSync(launch.stateHome)).toBe(false);
	});
	it("uses one profile for canonical aliases and a different profile for another state home", async () => {
		const root = await temporaryRoot();
		mkdirSync(join(root, "state"));
		symlinkSync(join(root, "state"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		process.env.QUARTERDECK_STATE_HOME = join(root, "state");
		const first = await readDesktopLaunchConfig(undefined, join(root, "electron"));
		process.env.QUARTERDECK_STATE_HOME = join(root, "alias");
		expect((await readDesktopLaunchConfig(undefined, join(root, "electron"))).userDataPath).toBe(first.userDataPath);
		process.env.QUARTERDECK_STATE_HOME = join(root, "other-state");
		expect((await readDesktopLaunchConfig(undefined, join(root, "electron"))).userDataPath).not.toBe(
			first.userDataPath,
		);
	});
});
