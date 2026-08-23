#!/usr/bin/env node

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import treeKill from "tree-kill";

import { closeAgentLabBrowserSession } from "./browser-session";
import { buildAgentLabEnvironment } from "./environment";
import { prepareAgentLabFixture } from "./fixture";
import { resolveLoopbackPort } from "./loopback-port";
import { writeJsonAtomic } from "./paths";
import { captureAgentLabSnapshot } from "./snapshot";
import { type AgentLabLaunchConfig, AgentLabLaunchConfigSchema, type AgentLabManifest } from "./types";

interface ManagedChild {
	label: string;
	process: ChildProcess;
	logPath: string;
	logStream: WriteStream;
	exit: Promise<ManagedChildExit>;
	getExitResult: () => ManagedChildExit | null;
}

interface ManagedChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error: Error | null;
}

interface SupervisorControl {
	promise: Promise<string>;
	dispose: () => void;
}

interface AgentLabShutdownSequence {
	capturePreShutdown: () => Promise<void>;
	closeBrowser: () => Promise<void>;
	stopChildren: () => Promise<void>;
	finalizeManifest: () => Promise<void>;
	captureFinal: () => Promise<void>;
	removeTemporaryFixture: () => Promise<void>;
}

const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createManagedChild(
	label: string,
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; forwardLogs: boolean },
): ManagedChild {
	const logStream = createWriteStream(options.logPath, { flags: "a" });
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	child.stdout?.pipe(logStream, { end: false });
	child.stderr?.pipe(logStream, { end: false });
	if (options.forwardLogs) {
		child.stdout?.pipe(process.stdout, { end: false });
		child.stderr?.pipe(process.stderr, { end: false });
	}
	let exitResult: ManagedChildExit | null = null;
	const exit = new Promise<ManagedChildExit>((resolveExit) => {
		const settle = (result: ManagedChildExit) => {
			if (exitResult) {
				return;
			}
			exitResult = result;
			resolveExit(result);
		};
		child.once("error", (error) => settle({ code: null, signal: null, error }));
		child.once("exit", (code, signal) => settle({ code, signal, error: null }));
	});
	return { label, process: child, logPath: options.logPath, logStream, exit, getExitResult: () => exitResult };
}

async function stopManagedChild(child: ManagedChild): Promise<void> {
	if (child.getExitResult() || child.process.pid === undefined) {
		child.logStream.end();
		return;
	}
	const pid = child.process.pid;
	await new Promise<void>((resolveStop) => {
		let settled = false;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			resolveStop();
		};
		const timeout = setTimeout(() => {
			treeKill(pid, "SIGKILL", finish);
		}, STOP_TIMEOUT_MS);
		timeout.unref();
		treeKill(pid, "SIGTERM", () => {
			void child.exit.finally(() => {
				clearTimeout(timeout);
				finish();
			});
		});
	});
	child.logStream.end();
}

async function waitForUrl(url: string, child: ManagedChild, label: string): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	let lastFailure = "not reachable";
	while (Date.now() < deadline) {
		const exitResult = child.getExitResult();
		if (exitResult) {
			const reason = exitResult.error?.message ?? exitResult.signal ?? exitResult.code;
			throw new Error(`${label} exited during startup with ${reason}. See ${child.logPath}`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
			if (response.status < 500) {
				return;
			}
			lastFailure = `HTTP ${response.status}`;
		} catch (error) {
			lastFailure = errorMessage(error);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
	}
	throw new Error(`${label} did not become ready at ${url}: ${lastFailure}. See ${child.logPath}`);
}

function createSupervisorControl(stopRequestPath: string): SupervisorControl {
	let interval: NodeJS.Timeout | null = null;
	let disposed = false;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const promise = new Promise<string>((resolveControlPromise) => {
		interval = setInterval(() => {
			void access(stopRequestPath)
				.then(() => resolveControlPromise("stop request"))
				.catch(() => {});
		}, 200);
		for (const signal of [
			"SIGINT",
			"SIGTERM",
			...(process.platform === "win32" ? [] : ["SIGHUP"]),
		] as NodeJS.Signals[]) {
			const handler = () => resolveControlPromise(signal);
			signalHandlers.set(signal, handler);
			process.once(signal, handler);
		}
	});

	return {
		promise,
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			if (interval) {
				clearInterval(interval);
			}
			for (const [signal, handler] of signalHandlers) {
				process.removeListener(signal, handler);
			}
		},
	};
}

function childFailure(child: ManagedChild): Promise<never> {
	return child.exit.then(({ code, signal, error }) => {
		throw new Error(
			`${child.label} exited unexpectedly with ${error?.message ?? signal ?? code}. See ${child.logPath}`,
		);
	});
}

async function loadSupervisorConfig(configPath: string): Promise<AgentLabLaunchConfig> {
	const contents = await readFile(configPath, "utf8");
	return AgentLabLaunchConfigSchema.parse(JSON.parse(contents) as unknown);
}

async function assertNoForbiddenHostLaunches(logPath: string): Promise<void> {
	const launches = (await readFile(logPath, "utf8")).trim();
	if (launches) {
		throw new Error(`Agent Lab invoked a forbidden host launcher. See ${logPath}:\n${launches}`);
	}
}

/** Preserves the forensic boundary: the final bundle observes a stopped runtime and finalized manifest. */
export async function executeAgentLabShutdownSequence(sequence: AgentLabShutdownSequence): Promise<void> {
	await sequence.capturePreShutdown();
	await sequence.closeBrowser();
	await sequence.stopChildren();
	await sequence.finalizeManifest();
	await sequence.captureFinal();
	await sequence.removeTemporaryFixture();
}

export async function runAgentLabSupervisor(config: AgentLabLaunchConfig): Promise<void> {
	let manifest: AgentLabManifest | null = null;
	let runtime: ManagedChild | null = null;
	let web: ManagedChild | null = null;
	let control: SupervisorControl | null = null;
	let failure: string | null = null;
	try {
		const runtimePort = await resolveLoopbackPort(config.runtimePort, "runtime");
		const webPort = await resolveLoopbackPort(config.webPort, "web");
		if (runtimePort === webPort) {
			throw new Error(`Runtime and web resolved to the same port (${runtimePort}).`);
		}
		const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
		const webUrl = `http://127.0.0.1:${webPort}`;
		const fixture = await prepareAgentLabFixture(config, webUrl);
		const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
		const cliEntrypointPath = join(config.repoRoot, "src", "cli.ts");
		const fakeCodexPath = join(config.repoRoot, "scripts", "agent-lab", "fake-codex.ts");
		const environment = buildAgentLabEnvironment(process.env, {
			...fixture,
			tempRoot: config.tempRoot,
			repoRoot: config.repoRoot,
			tsxCliPath,
			fakeCodexPath,
			cliEntrypointPath,
			runtimePort,
			webPort,
			scenario: config.scenario,
		});
		const runtimeLogPath = join(config.artifactDir, "runtime.log");
		const webLogPath = join(config.artifactDir, "web.log");
		manifest = {
			schemaVersion: config.schemaVersion,
			runId: config.runId,
			status: "starting",
			repoRoot: config.repoRoot,
			artifactDir: config.artifactDir,
			manifestPath: config.manifestPath,
			stopRequestPath: config.stopRequestPath,
			tempRoot: config.tempRoot,
			homePath: fixture.homePath,
			statePath: fixture.statePath,
			projectPath: fixture.projectPath,
			additionalProjectPath: fixture.additionalProjectPath,
			forbiddenHostLaunchLogPath: fixture.forbiddenHostLaunchLogPath,
			runtimeCapabilities: config.runtimeCapabilities,
			projectUrl: `${webUrl}/project`,
			runtimeUrl,
			webUrl,
			browserConfigPath: fixture.browserConfigPath,
			browserOutputPath: join(config.artifactDir, "browser"),
			browserSession: `qd-${config.runId}`,
			scenario: config.scenario,
			keepTemp: config.keepTemp,
			supervisorPid: process.pid,
			processes: { runtime: null, web: null },
			createdAt: new Date().toISOString(),
			readyAt: null,
			stoppedAt: null,
			failure: null,
		};
		await writeJsonAtomic(config.manifestPath, manifest);
		const nativeUiArgs = config.runtimeCapabilities.nativeUiAvailable ? [] : ["--no-native-ui"];

		runtime = createManagedChild(
			"Quarterdeck runtime",
			process.execPath,
			[
				tsxCliPath,
				cliEntrypointPath,
				"--no-open",
				...nativeUiArgs,
				"--skip-shutdown-cleanup",
				"--port",
				String(runtimePort),
			],
			{
				cwd: fixture.projectPath,
				env: environment,
				logPath: runtimeLogPath,
				forwardLogs: config.forwardLogs,
			},
		);
		if (runtime.process.pid === undefined) {
			throw new Error("Quarterdeck runtime did not receive a process id.");
		}
		manifest.processes.runtime = { pid: runtime.process.pid, logPath: runtimeLogPath };
		await writeJsonAtomic(config.manifestPath, manifest);
		await waitForUrl(`${runtimeUrl}/api/trpc/projects.list`, runtime, "Quarterdeck runtime");

		const viteCliPath = join(config.repoRoot, "web-ui", "node_modules", "vite", "bin", "vite.js");
		web = createManagedChild(
			"Quarterdeck web UI",
			process.execPath,
			[viteCliPath, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
			{
				cwd: join(config.repoRoot, "web-ui"),
				env: environment,
				logPath: webLogPath,
				forwardLogs: config.forwardLogs,
			},
		);
		if (web.process.pid === undefined) {
			throw new Error("Quarterdeck web UI did not receive a process id.");
		}
		manifest.processes.web = { pid: web.process.pid, logPath: webLogPath };
		await writeJsonAtomic(config.manifestPath, manifest);
		await waitForUrl(webUrl, web, "Quarterdeck web UI");

		manifest.status = "ready";
		manifest.readyAt = new Date().toISOString();
		await writeJsonAtomic(config.manifestPath, manifest);
		await captureAgentLabSnapshot(manifest, "ready").catch((error: unknown) => {
			process.stderr.write(`[agent-lab supervisor] ready diagnostic capture failed: ${errorMessage(error)}\n`);
		});
		control = createSupervisorControl(config.stopRequestPath);
		await Promise.race([control.promise, childFailure(runtime), childFailure(web)]);
		await assertNoForbiddenHostLaunches(fixture.forbiddenHostLaunchLogPath);
		manifest.status = "stopping";
		await writeJsonAtomic(config.manifestPath, manifest);
	} catch (error) {
		failure = errorMessage(error);
		if (manifest) {
			manifest.status = "failed";
			manifest.failure = failure;
			await writeJsonAtomic(config.manifestPath, manifest).catch(() => {});
			await captureAgentLabSnapshot(manifest, "failure").catch((snapshotError: unknown) => {
				process.stderr.write(
					`[agent-lab supervisor] failure diagnostic capture failed: ${errorMessage(snapshotError)}\n`,
				);
			});
		}
	} finally {
		control?.dispose();
		await executeAgentLabShutdownSequence({
			capturePreShutdown: async () => {
				if (!manifest) return;
				await captureAgentLabSnapshot(manifest, "pre-shutdown").catch((snapshotError: unknown) => {
					process.stderr.write(
						`[agent-lab supervisor] pre-shutdown diagnostic capture failed: ${errorMessage(snapshotError)}\n`,
					);
				});
			},
			closeBrowser: async () => {
				if (manifest) await closeAgentLabBrowserSession(manifest.repoRoot, manifest.browserSession).catch(() => {});
			},
			stopChildren: async () => {
				await Promise.all([
					web ? stopManagedChild(web) : Promise.resolve(),
					runtime ? stopManagedChild(runtime) : Promise.resolve(),
				]);
			},
			finalizeManifest: async () => {
				if (!manifest) return;
				manifest.status = failure ? "failed" : "stopped";
				manifest.failure = failure;
				manifest.stoppedAt = new Date().toISOString();
				await writeJsonAtomic(config.manifestPath, manifest).catch(() => {});
			},
			captureFinal: async () => {
				if (!manifest) return;
				await captureAgentLabSnapshot(manifest, "final").catch((snapshotError: unknown) => {
					process.stderr.write(
						`[agent-lab supervisor] final diagnostic capture failed: ${errorMessage(snapshotError)}\n`,
					);
				});
			},
			removeTemporaryFixture: async () => {
				if (!config.keepTemp) await rm(config.tempRoot, { recursive: true, force: true });
			},
		});
	}
	if (failure) {
		throw new Error(failure);
	}
}

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (!configPath) {
		throw new Error("Usage: supervisor.ts <config-path>");
	}
	const config = await loadSupervisorConfig(configPath);
	await runAgentLabSupervisor(config);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error: unknown) => {
		process.stderr.write(`[agent-lab supervisor] ${errorMessage(error)}\n`);
		process.exitCode = 1;
	});
}
