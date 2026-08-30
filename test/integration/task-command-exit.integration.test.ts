import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { commitAll, createGitTestEnv, initGitRepository, runGit } from "../utilities/git-env";
import {
	getAvailablePort,
	requestGracefulShutdown,
	resolveTsxLoaderImportSpecifier,
	waitForExit,
	waitForProcessStart,
} from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

function installBrowserOpenStub(binDir: string, logPath: string, failurePath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [ -f ${JSON.stringify(failurePath)} ]; then
  exit 1
fi
`;
	const commandNames = ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolveDelay) => {
			setTimeout(resolveDelay, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const childProcess = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	childProcess.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	childProcess.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const closed = new Promise<void>((resolveClose) => {
		childProcess.once("close", () => resolveClose());
	});

	const didExit = await waitForExit(childProcess, options.timeoutMs ?? 8_000);
	if (!didExit) {
		childProcess.kill("SIGKILL");
	}
	await closed;

	return {
		stdout,
		stderr,
		exitCode: childProcess.exitCode,
		didExit,
	};
}

function initGitRepositoryWithMainBranch(path: string): void {
	initGitRepository(path);
	runGit(path, ["checkout", "-B", "main"]);
}

describe("source CLI commands", () => {
	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		// macOS deliberately uses the absolute /usr/bin/open launcher. Its exit
		// behavior is covered by browser.test.ts; keep this PATH-stubbed source-CLI
		// lifecycle test on Linux so it can never open a developer's real browser.
		if (process.platform !== "linux") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("quarterdeck-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-root-launch-open-");

		try {
			initGitRepositoryWithMainBranch(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			const browserOpenFailurePath = join(homeDir, "browser-open.fail");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath, browserOpenFailurePath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				QUARTERDECK_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				["--import", resolveTsxLoaderImportSpecifier(), resolve(process.cwd(), "src/cli.ts")],
				{
					cwd: projectPath,
					env,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);

			try {
				await waitForProcessStart(serverProcess);
				await waitForBrowserOpenCount(browserOpenLogPath, 1);

				for (const [args, expectedOpenCount] of [
					[[], 2],
					[["--no-open"], 2],
					[["--help"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}

				writeFileSync(browserOpenFailurePath, "fail\n", "utf8");
				const failedOpen = await runCliCommandAndCollectOutput({
					args: [],
					cwd: projectPath,
					env,
				});
				expect(failedOpen.didExit).toBe(true);
				expect(failedOpen.exitCode).toBe(0);
				expect(failedOpen.stderr).toContain("Could not open browser automatically");
				await waitForBrowserOpenCount(browserOpenLogPath, 4);
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
