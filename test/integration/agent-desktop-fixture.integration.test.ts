import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareDesktopLabFixture, resolveDesktopAppExecutable } from "../../scripts/agent-lab/desktop-fixture";
import { DesktopLabConfigSchema } from "../../scripts/agent-lab/desktop-types";

async function createFakeBundle(root: string): Promise<string> {
	const appPath = join(root, "Quarterdeck.app");
	const executableDirectory = join(appPath, "Contents", "MacOS");
	await mkdir(executableDirectory, { recursive: true });
	const executablePath = join(executableDirectory, "Quarterdeck");
	await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(executablePath, 0o755);
	return appPath;
}

describe.skipIf(process.platform !== "darwin")("isolated desktop fixture", () => {
	it("rejects loose Electron binaries and ambiguous bundle executables", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-bundle-test-"));
		try {
			await expect(resolveDesktopAppExecutable(root)).rejects.toThrow("packaged macOS .app");
			const appPath = await createFakeBundle(root);
			const extra = join(appPath, "Contents", "MacOS", "Other");
			await writeFile(extra, "#!/bin/sh\nexit 0\n");
			await chmod(extra, 0o755);
			await expect(resolveDesktopAppExecutable(appPath)).rejects.toThrow("exactly one main executable");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses synthetic fixtures with private desktop state and no account environment", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-fixture-test-"));
		let disposableRoot: string | undefined;
		try {
			const fixture = await prepareDesktopLabFixture({
				appPath: await createFakeBundle(root),
				artifactRoot: join(root, "artifacts"),
				sourceEnvironment: {
					PATH: process.env.PATH,
					HOME: "/real/home",
					OPENAI_API_KEY: "fake-secret",
					AWS_SECRET_ACCESS_KEY: "fake-secret",
					SSH_AUTH_SOCK: "/real/ssh",
					ELECTRON_RUN_AS_NODE: "1",
				},
			});
			disposableRoot = fixture.config.tempRoot;
			expect(fixture.manifest.surface).toBe("electron");
			expect(fixture.config.showWindow).toBe(false);
			expect(fixture.manifest.showWindow).toBe(false);
			expect(fixture.manifest.mainPid).toBeNull();
			expect(fixture.manifest.helperPid).toBeNull();
			expect(fixture.config.tempRoot).toBe(await realpath(fixture.config.tempRoot));
			for (const path of Object.values(fixture.config).filter(
				(value): value is string => typeof value === "string",
			)) {
				expect(path === fixture.config.tempRoot || path.startsWith(`${fixture.config.tempRoot}/`)).toBe(true);
			}
			expect(fixture.environment.HOME).toBe(join(fixture.config.tempRoot, "home"));
			expect(fixture.environment.QUARTERDECK_STATE_HOME).toBe(fixture.config.stateHome);
			expect(fixture.environment.QUARTERDECK_RUNTIME_PORT).toBeUndefined();
			expect(fixture.environment.QUARTERDECK_DESKTOP_LAB_CONFIG).toBe(fixture.configPath);
			expect(fixture.environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe("codex,pi");
			expect(fixture.environment.PATH?.split(":")[0]).toBe(join(fixture.config.tempRoot, "bin"));
			for (const key of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "ELECTRON_RUN_AS_NODE"])
				expect(fixture.environment[key]).toBeUndefined();
			expect(
				DesktopLabConfigSchema.parse(JSON.parse(await readFile(fixture.configPath, "utf8")) as unknown),
			).toEqual(fixture.config);
			expect((await stat(fixture.configPath)).mode & 0o777).toBe(0o600);
			expect(await readFile(fixture.forbiddenHostLaunchLogPath, "utf8")).toBe("");
			expect(await readFile(join(fixture.config.projectPath, "README.md"), "utf8")).toContain("disposable");
		} finally {
			if (disposableRoot) await rm(disposableRoot, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});
});
