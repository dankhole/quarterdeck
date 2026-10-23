import { type SpawnOptions, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDesktopEnvironmentPreferences } from "../src/environment-preferences.js";
import { resolveDesktopRuntimeEnvironment } from "../src/runtime-environment.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-runtime-environment-"));
	roots.push(root);
	const home = join(root, "home with spaces");
	const discovered = join(home, ".local", "bin");
	await mkdir(discovered, { recursive: true });
	const nodePath = join(root, "bundled", "bin", "node");
	const getLoginShell = vi.fn(() => "/bin/zsh");
	const spawnCapture = vi.fn(() => {
		throw new Error("Synthetic shell capture failure.");
	});
	return {
		root,
		discovered,
		options: {
			userDataPath: join(root, "app-data"),
			nodePath,
			platform: "darwin" as const,
			inheritedEnvironment: { HOME: home, PATH: "/synthetic/inherited", CUSTOM_VALUE: "synthetic" },
			getLoginShell,
			spawnCapture,
		},
	};
}

describe("desktop runtime environment composition", () => {
	it.each(["absent", "legacy"])(
		"imports the login shell for %s saved preferences on ordinary desktop startup",
		async (saved) => {
			const { options, discovered } = await fixture();
			if (saved === "legacy") {
				const directory = join(options.userDataPath, "environment-preferences");
				await mkdir(directory, { recursive: true });
				await writeFile(
					join(directory, "folders.json"),
					JSON.stringify({ version: 1, extraExecutableDirectories: [] }),
				);
			}
			const spawnCapture = vi.fn((_executable: string, _args: string[], captureOptions: SpawnOptions) =>
				spawn(
					process.execPath,
					["-e", "require('node:fs').writeSync(3, 'PATH=/synthetic/login/bin\\0CUSTOM_VALUE=imported\\0')"],
					captureOptions,
				),
			);
			const result = await resolveDesktopRuntimeEnvironment({ ...options, spawnCapture });
			expect(result.source).toBe("login-shell");
			expect(result.preferences.importLoginShellEnvironment).toBe(true);
			expect(result.environment.PATH?.split(":")).toContain("/synthetic/login/bin");
			expect(result.environment.PATH?.split(":")).not.toContain(discovered);
			expect(result.environment.CUSTOM_VALUE).toBe("imported");
			expect(options.getLoginShell).toHaveBeenCalledOnce();
			expect(spawnCapture).toHaveBeenCalledOnce();
		},
	);

	it("preserves explicit opt-out with shell-free executable discovery", async () => {
		const { options, discovered } = await fixture();
		await writeDesktopEnvironmentPreferences(options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: false,
		});
		const result = await resolveDesktopRuntimeEnvironment(options);
		expect(result.source).toBe("inherited");
		expect(result.preferences.importLoginShellEnvironment).toBe(false);
		expect(result.environment.PATH?.split(":")).toContain(discovered);
		expect(result.environment.CUSTOM_VALUE).toBe("synthetic");
		expect(options.getLoginShell).not.toHaveBeenCalled();
		expect(options.spawnCapture).not.toHaveBeenCalled();
	});

	it("applies saved mode and folder precedence on each startup or guarded refresh", async () => {
		const { options, root } = await fixture();
		const override = join(root, "manual tools");
		await writeDesktopEnvironmentPreferences(options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [override],
			importLoginShellEnvironment: true,
		});
		const spawnCapture = vi.fn((_executable: string, _args: string[], captureOptions: SpawnOptions) =>
			spawn(
				process.execPath,
				[
					"-e",
					"require('node:fs').writeSync(3, 'PATH=/synthetic/login/bin\\0CUSTOM_VALUE=imported\\0NODE_OPTIONS=--inspect\\0')",
				],
				captureOptions,
			),
		);
		const first = await resolveDesktopRuntimeEnvironment({ ...options, spawnCapture });
		expect(first.source).toBe("login-shell");
		expect(first.preferences.importLoginShellEnvironment).toBe(true);
		expect(first.environment.PATH?.split(":").slice(0, 3)).toEqual([
			join(root, "bundled", "bin"),
			override,
			"/synthetic/login/bin",
		]);
		expect(first.environment.CUSTOM_VALUE).toBe("imported");
		expect(first.environment.NODE_OPTIONS).toBeUndefined();
		expect(spawnCapture).toHaveBeenCalledOnce();
		await writeDesktopEnvironmentPreferences(options.userDataPath, {
			...first.preferences,
			importLoginShellEnvironment: false,
		});
		const refreshed = await resolveDesktopRuntimeEnvironment(options);
		expect(refreshed.source).toBe("inherited");
		expect(refreshed.environment.CUSTOM_VALUE).toBe("synthetic");
		expect(refreshed.environment.PATH?.split(":")[1]).toBe(override);
		expect(options.spawnCapture).not.toHaveBeenCalled();
	});

	it("preserves capture cleanup and saved mode when login-shell import fails", async () => {
		const { options, root } = await fixture();
		const override = join(root, "tools");
		await writeDesktopEnvironmentPreferences(options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [override],
			importLoginShellEnvironment: true,
		});
		const result = await resolveDesktopRuntimeEnvironment(options);
		expect(result).toMatchObject({
			source: "fallback",
			failureReason: "capture_failed",
			processCleanup: "not_needed",
			preferences: { importLoginShellEnvironment: true },
		});
		expect(result.environment.PATH?.split(":")[1]).toBe(override);
	});

	it("keeps synthetic labs isolated even with a saved shell import preference", async () => {
		const { options, discovered } = await fixture();
		await writeDesktopEnvironmentPreferences(options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: true,
		});
		const result = await resolveDesktopRuntimeEnvironment({ ...options, isolatedLab: true });
		expect(result.source).toBe("inherited");
		expect(result.environment.PATH?.split(":")).not.toContain(discovered);
		expect(options.getLoginShell).not.toHaveBeenCalled();
		expect(options.spawnCapture).not.toHaveBeenCalled();
	});
});
