import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { terminateWindowsProcessTree } from "../../src/core";
import { discoverRuntimeDiagnosticInstances } from "../../src/diagnostics";
import { createGitTestEnv, initGitRepository } from "../utilities/git-env";
import {
	getAvailablePort,
	requestGracefulShutdown,
	startQuarterdeckServer,
	waitForExit,
	waitForProcessStart,
} from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

async function expectStoppedRuntimeDescriptor(stateHome: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	let instances = await discoverRuntimeDiagnosticInstances(stateHome);
	while (Date.now() < deadline && (instances.length !== 1 || instances[0]?.descriptor.status !== "stopped")) {
		await delay(25);
		instances = await discoverRuntimeDiagnosticInstances(stateHome);
	}
	expect(instances).toHaveLength(1);
	expect(instances[0]?.descriptor.status).toBe("stopped");
	expect(instances[0]?.descriptor.stoppedAt).not.toBeNull();
}

async function forceStopProcessTree(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			process.kill(pid, "SIGKILL");
		}
		return;
	}
	await new Promise<void>((resolveStop) => {
		terminateWindowsProcessTree(pid, "SIGKILL", () => resolveStop());
	});
}

describe.sequential("CLI parent disconnect integration", () => {
	it("finishes runtime cleanup before exiting after stdin closes", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-parent-disconnect-");
		const projectPath = join(sandboxRoot, "project");
		const stateHome = join(sandboxRoot, "state");
		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);

		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: sandboxRoot,
			port: await getAvailablePort(),
			extraEnv: { QUARTERDECK_STATE_HOME: stateHome },
		});
		let stopped = false;
		try {
			await server.stop();
			stopped = true;

			await expectStoppedRuntimeDescriptor(stateHome);
		} finally {
			if (!stopped) await server.stop().catch(() => undefined);
			cleanup();
		}
	});

	it("propagates parent disconnect through the source-watching development wrapper", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-dev-parent-disconnect-");
		const stateHome = join(sandboxRoot, "state");
		const port = await getAvailablePort();
		const child = spawn(
			process.execPath,
			[resolve(process.cwd(), "scripts/dev-runtime.mjs"), "--no-open", "--no-native-ui", "--port", String(port)],
			{
				cwd: process.cwd(),
				env: createGitTestEnv({
					HOME: sandboxRoot,
					USERPROFILE: sandboxRoot,
					QUARTERDECK_STATE_HOME: stateHome,
				}),
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stopped = false;
		try {
			await waitForProcessStart(child);
			await requestGracefulShutdown(child);
			stopped = await waitForExit(child, 5_000);
			expect(stopped).toBe(true);
			await expectStoppedRuntimeDescriptor(stateHome);
		} finally {
			if (!stopped) {
				await forceStopProcessTree(child.pid);
				await waitForExit(child, 5_000);
			}
			cleanup();
		}
	});
});
