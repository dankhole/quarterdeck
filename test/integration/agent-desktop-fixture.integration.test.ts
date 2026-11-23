import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { sanitizeDesktopHelperEnvironment } from "../../desktop/src/launch-environment";
import { prepareDesktopLabFixture, resolveDesktopAppExecutable } from "../../scripts/agent-lab/desktop-fixture";
import { DesktopLabConfigSchema } from "../../scripts/agent-lab/desktop-types";
import { readFakeInvocationReceipt } from "../../scripts/agent-lab/fake-invocation-receipt";
import { useProcessTestBudget } from "../utilities/process-test-budget";

useProcessTestBudget();
const execFileAsync = promisify(execFile);

async function createFakeBundle(root: string): Promise<string> {
	const appPath = join(root, "Quarterdeck.app");
	const executableDirectory = join(appPath, "Contents", "MacOS");
	await mkdir(executableDirectory, { recursive: true });
	const executablePath = join(executableDirectory, "Quarterdeck");
	await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(executablePath, 0o755);
	await writeFile(
		join(appPath, "Contents", "Info.plist"),
		'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Quarterdeck</string></dict></plist>',
	);
	const runtime = join(appPath, "Contents", "Resources", "runtime");
	const node = join(runtime, "bin", "node");
	await Promise.all([
		mkdir(join(runtime, "bin"), { recursive: true }),
		mkdir(join(runtime, "dist"), { recursive: true }),
	]);
	await writeFile(node, '#!/bin/sh\nexport SYNTHETIC_BUNDLE_NODE=1\nexec "$QUARTERDECK_AGENT_LAB_NODE" "$@"\n', {
		mode: 0o755,
	});
	await writeFile(
		join(runtime, "dist", "hooks.js"),
		`require("node:fs").writeFileSync(process.env.SYNTHETIC_HOOK_CAPTURE, JSON.stringify({
			argv: process.argv.slice(2),
			bundleNode: process.env.SYNTHETIC_BUNDLE_NODE,
			execArgv: process.execArgv,
			sessionInstanceId: process.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID,
		}));`,
	);
	return appPath;
}

describe.skipIf(process.platform !== "darwin")("isolated desktop fixture", () => {
	it("uses the declared native bootstrap even when the bundle also contains an Electron host", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-bundle-test-"));
		try {
			await expect(resolveDesktopAppExecutable(root)).rejects.toThrow("packaged macOS .app");
			const appPath = await createFakeBundle(root);
			const extra = join(appPath, "Contents", "MacOS", "Other");
			await writeFile(extra, "#!/bin/sh\nexit 0\n");
			await chmod(extra, 0o755);
			expect((await resolveDesktopAppExecutable(appPath)).executablePath).toBe(
				join(await realpath(appPath), "Contents", "MacOS", "Quarterdeck"),
			);
			await writeFile(
				join(appPath, "Contents", "Info.plist"),
				'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>../../outside</string></dict></plist>',
			);
			await expect(resolveDesktopAppExecutable(appPath)).rejects.toThrow();
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

	it("sends the exact fake Codex startup hook through bundled Node without a source CLI or TSX loader", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-fake-hook-test-"));
		let disposableRoot: string | undefined;
		try {
			const fixture = await prepareDesktopLabFixture({
				appPath: await createFakeBundle(root),
				artifactRoot: join(root, "artifacts"),
			});
			disposableRoot = fixture.config.tempRoot;
			const taskId = "synthetic-task";
			const sessionInstanceId = "synthetic-launch";
			const capturePath = join(root, "hook.json");
			const execution = execFileAsync(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx"),
					resolve("scripts/agent-lab/fake-codex.ts"),
					"-c",
					'hooks.Interrupt=[{ command = "synthetic hook contract" }]',
					"--",
					"[agent-lab:idle] synthetic startup",
				],
				{
					cwd: fixture.config.projectPath,
					env: sanitizeDesktopHelperEnvironment(
						{
							...fixture.environment,
							QUARTERDECK_AGENT_LAB_PROVIDER: "codex",
							QUARTERDECK_AGENT_LAB_TSX_CLI: join(root, "cannot-use-tsx-for-the-hook.mjs"),
							QUARTERDECK_HOOK_TASK_ID: taskId,
							QUARTERDECK_HOOK_SESSION_INSTANCE_ID: sessionInstanceId,
							SYNTHETIC_HOOK_CAPTURE: capturePath,
						},
						join(fixture.manifest.appPath, "Contents/Resources/runtime/bin/node"),
					),
					timeout: 10_000,
				},
			);
			const completion = execution.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			try {
				await expect
					.poll(async () => JSON.parse(await readFile(capturePath, "utf8")) as unknown, { timeout: 5_000 })
					.toEqual({
						argv: [
							"hooks",
							"ingest",
							"--event",
							"activity",
							"--source",
							"codex",
							"--transcript-path",
							join(fixture.environment.HOME ?? "", ".codex/sessions", `rollout-agent-lab-${taskId}.jsonl`),
							"--hook-event-name",
							"SessionStart",
							"--session-id",
							`agent-lab-${taskId}`,
							"--turn-id",
							"agent-lab-turn-1",
							"--activity-text",
							"Agent-lab session started",
						],
						bundleNode: "1",
						execArgv: [],
						sessionInstanceId,
					});
				expect(
					await readFakeInvocationReceipt({ stateHome: fixture.config.stateHome, sessionInstanceId }),
				).toMatchObject({
					taskId,
					sessionInstanceId,
					pid: execution.child.pid,
					providerSessionId: `agent-lab-${taskId}`,
				});
				execution.child.stdin?.end();
				const outcome = await completion;
				if ("error" in outcome) throw outcome.error;
				expect(outcome.result.stderr).toBe("");
			} finally {
				if (execution.child.exitCode === null && execution.child.signalCode === null) execution.child.kill();
				await completion;
			}
		} finally {
			if (disposableRoot) await rm(disposableRoot, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});
});
