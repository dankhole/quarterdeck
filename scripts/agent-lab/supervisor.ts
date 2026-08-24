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
import {
	type AgentLabLaunchConfig,
	AgentLabLaunchConfigSchema,
	type AgentLabManifest,
	type AgentLabRuntimeRestartRecord,
	type AgentLabRuntimeRestartRequest,
	AgentLabRuntimeRestartRequestSchema,
	type AgentLabRuntimeRestartResult,
} from "./types";

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
	promise: Promise<SupervisorAction>;
	dispose: () => void;
}

type SupervisorAction =
	| { kind: "stop"; reason: string }
	| { kind: "restart_runtime"; request: AgentLabRuntimeRestartRequest };

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

async function stopManagedChildGracefully(child: ManagedChild): Promise<void> {
	if (child.getExitResult() || child.process.pid === undefined) {
		child.logStream.end();
		return;
	}
	const pid = child.process.pid;
	try {
		child.process.kill("SIGTERM");
	} catch {
		// The process may have exited between the liveness check and signal.
	}
	const exited = await Promise.race([
		child.exit.then(() => true),
		new Promise<false>((resolveTimeout) => {
			const timeout = setTimeout(() => resolveTimeout(false), STOP_TIMEOUT_MS);
			timeout.unref();
		}),
	]);
	if (!exited) {
		await new Promise<void>((resolveKill) => {
			treeKill(pid, "SIGKILL", () => resolveKill());
		});
	}
	child.logStream.end();
}

async function waitForManagedChildExit(child: ManagedChild, timeoutMs = 2_000): Promise<boolean> {
	if (child.getExitResult()) return true;
	return await Promise.race([
		child.exit.then(() => true),
		new Promise<false>((resolveTimeout) => {
			const timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
			timeout.unref();
		}),
	]);
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

function createSupervisorControl(stopRequestPath: string, runtimeRestartRequestPath: string): SupervisorControl {
	let interval: NodeJS.Timeout | null = null;
	let disposed = false;
	let reading = false;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const promise = new Promise<SupervisorAction>((resolveControlPromise, rejectControlPromise) => {
		interval = setInterval(() => {
			if (reading) return;
			reading = true;
			void access(stopRequestPath)
				.then(() => resolveControlPromise({ kind: "stop", reason: "stop request" }))
				.catch(async () => {
					try {
						const contents = await readFile(runtimeRestartRequestPath, "utf8");
						const request = AgentLabRuntimeRestartRequestSchema.parse(JSON.parse(contents) as unknown);
						resolveControlPromise({ kind: "restart_runtime", request });
					} catch (error) {
						if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
							return;
						}
						rejectControlPromise(error);
					}
				})
				.finally(() => {
					reading = false;
				});
		}, 200);
		for (const signal of [
			"SIGINT",
			"SIGTERM",
			...(process.platform === "win32" ? [] : ["SIGHUP"]),
		] as NodeJS.Signals[]) {
			const handler = () => resolveControlPromise({ kind: "stop", reason: signal });
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
		const webLogPath = join(config.artifactDir, "web.log");
		manifest = {
			schemaVersion: config.schemaVersion,
			runId: config.runId,
			status: "starting",
			repoRoot: config.repoRoot,
			artifactDir: config.artifactDir,
			manifestPath: config.manifestPath,
			stopRequestPath: config.stopRequestPath,
			runtimeRestartRequestPath: config.runtimeRestartRequestPath,
			runtimeRestartResultPath: config.runtimeRestartResultPath,
			tempRoot: config.tempRoot,
			homePath: fixture.homePath,
			statePath: fixture.statePath,
			projectPath: fixture.projectPath,
			additionalProjectPath: fixture.additionalProjectPath,
			forbiddenHostLaunchLogPath: fixture.forbiddenHostLaunchLogPath,
			hostEventLedgerPath: fixture.hostEventLedgerPath,
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
			runtimeGeneration: 1,
			runtimeRestarts: [],
			createdAt: new Date().toISOString(),
			readyAt: null,
			stoppedAt: null,
			failure: null,
		};
		await writeJsonAtomic(config.manifestPath, manifest);
		const runManifest = manifest;
		const nativeUiArgs = config.runtimeCapabilities.nativeUiAvailable ? [] : ["--no-native-ui"];
		const startRuntimeGeneration = async (generation: number): Promise<ManagedChild> => {
			const runtimeLogPath = join(config.artifactDir, `runtime-${generation}.log`);
			const child = createManagedChild(
				`Quarterdeck runtime generation ${generation}`,
				process.execPath,
				[
					tsxCliPath,
					cliEntrypointPath,
					...nativeUiArgs,
					"--simulate-host-integrations",
					fixture.hostSimulationConfigPath,
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
			if (child.process.pid === undefined) {
				throw new Error(`Quarterdeck runtime generation ${generation} did not receive a process id.`);
			}
			runManifest.runtimeGeneration = generation;
			runManifest.processes.runtime = { pid: child.process.pid, logPath: runtimeLogPath };
			await writeJsonAtomic(config.manifestPath, runManifest);
			await waitForUrl(`${runtimeUrl}/api/trpc/projects.list`, child, child.label);
			return child;
		};

		runtime = await startRuntimeGeneration(1);

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
		while (true) {
			control = createSupervisorControl(config.stopRequestPath, config.runtimeRestartRequestPath);
			const action = await Promise.race([control.promise, childFailure(runtime), childFailure(web)]);
			control.dispose();
			control = null;
			if (action.kind === "stop") {
				break;
			}

			const request = action.request;
			const previousProcess = manifest.processes.runtime;
			if (!previousProcess) {
				throw new Error("Agent Lab cannot restart a runtime that has no managed process.");
			}
			const restartRecord: AgentLabRuntimeRestartRecord = {
				requestId: request.requestId,
				mode: request.mode,
				status: "pending",
				fromGeneration: manifest.runtimeGeneration,
				toGeneration: null,
				requestedAt: request.requestedAt,
				completedAt: null,
				previousProcess: { ...previousProcess },
				replacementProcess: null,
				error: null,
			};
			manifest.runtimeRestarts.push(restartRecord);
			manifest.status = "restarting";
			await writeJsonAtomic(config.manifestPath, manifest);
			await captureAgentLabSnapshot(manifest, `pre-runtime-restart-${manifest.runtimeGeneration}`).catch(
				(error: unknown) => {
					process.stderr.write(
						`[agent-lab supervisor] pre-runtime-restart diagnostic capture failed: ${errorMessage(error)}\n`,
					);
				},
			);

			try {
				await stopManagedChildGracefully(runtime);
				if (!(await waitForManagedChildExit(runtime))) {
					throw new Error(`Runtime generation ${manifest.runtimeGeneration} did not confirm process exit.`);
				}
				const nextGeneration = manifest.runtimeGeneration + 1;
				runtime = await startRuntimeGeneration(nextGeneration);
				restartRecord.status = "completed";
				restartRecord.toGeneration = nextGeneration;
				restartRecord.completedAt = new Date().toISOString();
				restartRecord.replacementProcess = manifest.processes.runtime ? { ...manifest.processes.runtime } : null;
				manifest.status = "ready";
				await writeJsonAtomic(config.manifestPath, manifest);
				await captureAgentLabSnapshot(manifest, `post-runtime-restart-${nextGeneration}`).catch(
					(error: unknown) => {
						process.stderr.write(
							`[agent-lab supervisor] post-runtime-restart diagnostic capture failed: ${errorMessage(error)}\n`,
						);
					},
				);
				await writeJsonAtomic(config.runtimeRestartResultPath, {
					schemaVersion: 1,
					...restartRecord,
				} satisfies AgentLabRuntimeRestartResult);
				await rm(config.runtimeRestartRequestPath, { force: true });
			} catch (error) {
				const restartFailure = errorMessage(error);
				restartRecord.status = "failed";
				restartRecord.completedAt = new Date().toISOString();
				restartRecord.error = restartFailure;
				await writeJsonAtomic(config.runtimeRestartResultPath, {
					schemaVersion: 1,
					...restartRecord,
				} satisfies AgentLabRuntimeRestartResult).catch(() => {});
				await rm(config.runtimeRestartRequestPath, { force: true }).catch(() => {});
				throw error;
			}
		}
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
					runtime ? stopManagedChildGracefully(runtime) : Promise.resolve(),
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
				await captureAgentLabSnapshot(manifest, "final", { flushHostEvents: false }).catch(
					(snapshotError: unknown) => {
						process.stderr.write(
							`[agent-lab supervisor] final diagnostic capture failed: ${errorMessage(snapshotError)}\n`,
						);
					},
				);
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
