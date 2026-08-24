import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, Option } from "commander";

import { closeAgentLabBrowserSession } from "./browser-session";
import { buildSupervisorEnvironment } from "./environment";
import { createAgentLabLaunchConfig, persistAgentLabLaunchConfig } from "./launch-config";
import {
	AGENT_LAB_REPO_ROOT,
	getAgentLabArtifactRoot,
	isProcessAlive,
	readAgentLabManifest,
	resolveRunArtifactDir,
	writeJsonAtomic,
} from "./paths";
import { captureAgentLabSnapshot } from "./snapshot";
import {
	AGENT_LAB_SCHEMA_VERSION,
	type AgentLabManifest,
	type AgentLabRuntimeRestartResult,
	AgentLabRuntimeRestartResultSchema,
	type AgentLabScenario,
	AgentLabScenarioSchema,
	type ReadableAgentLabManifest,
} from "./types";

const START_TIMEOUT_MS = 75_000;
const STOP_TIMEOUT_MS = 20_000;

interface OutputOptions {
	json?: boolean;
}

interface StartOptions extends OutputOptions {
	name: string;
	scenario: AgentLabScenario;
	keepTemp?: boolean;
	runtimePort: number | null;
	webPort: number | null;
}

interface RestartRuntimeOptions extends OutputOptions {
	mode: "graceful";
}

interface LatestRunPointer {
	runId: string;
	manifestPath: string;
}

function parsePort(value: string): number | null {
	if (value === "auto") {
		return null;
	}
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid port ${JSON.stringify(value)}; use 1-65535 or "auto".`);
	}
	return port;
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function browserCommand(manifest: ReadableAgentLabManifest): string {
	return `npm run agent:browser -- --config ${JSON.stringify(manifest.browserConfigPath)} -s=${JSON.stringify(manifest.browserSession)} open ${JSON.stringify(manifest.projectUrl)}`;
}

function printManifestSummary(manifest: ReadableAgentLabManifest): void {
	process.stdout.write(`Agent lab ${manifest.runId}: ${manifest.status}\n`);
	process.stdout.write(`UI: ${manifest.projectUrl}\n`);
	process.stdout.write(`Manifest: ${manifest.manifestPath}\n`);
	process.stdout.write(`Artifacts: ${manifest.artifactDir}\n`);
	process.stdout.write(`Browser: ${browserCommand(manifest)}\n`);
}

function assertAgentLabDidNotFail(manifest: ReadableAgentLabManifest): void {
	if (manifest.status === "failed") {
		throw new Error(`Agent lab failed: ${manifest.failure ?? "unknown failure"}. Inspect ${manifest.artifactDir}.`);
	}
}

async function waitForManifest(
	manifestPath: string,
	predicate: (manifest: ReadableAgentLabManifest) => boolean,
	timeoutMs: number,
	supervisorPid?: number,
): Promise<ReadableAgentLabManifest> {
	const deadline = Date.now() + timeoutMs;
	let lastManifest: ReadableAgentLabManifest | null = null;
	while (Date.now() < deadline) {
		try {
			lastManifest = await readAgentLabManifest(manifestPath);
			if (predicate(lastManifest)) {
				return lastManifest;
			}
		} catch (error) {
			const isMissing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!isMissing) {
				throw error;
			}
		}
		if (supervisorPid && !isProcessAlive(supervisorPid)) {
			throw new Error(
				`Agent-lab supervisor ${supervisorPid} exited before the run became ready. Inspect ${join(dirname(manifestPath), "supervisor.log")}.`,
			);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
	}
	throw new Error(
		`Timed out waiting for agent lab at ${manifestPath}.${lastManifest ? ` Last status: ${lastManifest.status}.` : ""}`,
	);
}

async function writeLatestPointer(pointer: LatestRunPointer): Promise<void> {
	await writeJsonAtomic(join(getAgentLabArtifactRoot(AGENT_LAB_REPO_ROOT), "latest.json"), pointer);
}

async function readLatestPointer(): Promise<LatestRunPointer> {
	const path = join(getAgentLabArtifactRoot(AGENT_LAB_REPO_ROOT), "latest.json");
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("runId" in parsed) ||
		typeof parsed.runId !== "string" ||
		!("manifestPath" in parsed) ||
		typeof parsed.manifestPath !== "string"
	) {
		throw new Error(`Invalid agent-lab latest pointer: ${path}`);
	}
	return { runId: parsed.runId, manifestPath: parsed.manifestPath };
}

async function resolveManifestPath(runId?: string): Promise<string> {
	if (runId) {
		return join(resolveRunArtifactDir(runId, getAgentLabArtifactRoot(AGENT_LAB_REPO_ROOT)), "manifest.json");
	}
	return (await readLatestPointer()).manifestPath;
}

async function startAgentLab(options: StartOptions): Promise<void> {
	const config = await createAgentLabLaunchConfig({
		name: options.name,
		repoRoot: AGENT_LAB_REPO_ROOT,
		scenario: options.scenario,
		keepTemp: options.keepTemp,
		runtimePort: options.runtimePort,
		webPort: options.webPort,
	});
	const configPath = await persistAgentLabLaunchConfig(config);
	const supervisorPath = join(AGENT_LAB_REPO_ROOT, "scripts", "agent-lab", "supervisor.ts");
	const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
	const supervisorLogPath = join(config.artifactDir, "supervisor.log");
	const supervisorLogDescriptor = openSync(supervisorLogPath, "a");
	const supervisor = spawn(process.execPath, [tsxCliPath, supervisorPath, configPath], {
		cwd: AGENT_LAB_REPO_ROOT,
		env: buildSupervisorEnvironment(process.env, config.tempRoot),
		stdio: ["ignore", supervisorLogDescriptor, supervisorLogDescriptor],
		detached: true,
	});
	closeSync(supervisorLogDescriptor);
	if (supervisor.pid === undefined) {
		throw new Error(`Agent-lab supervisor failed to start. Inspect ${supervisorLogPath}.`);
	}
	supervisor.unref();
	await writeLatestPointer({ runId: config.runId, manifestPath: config.manifestPath });
	let manifest: AgentLabManifest;
	try {
		const readyManifest = await waitForManifest(
			config.manifestPath,
			(value) => value.status === "ready" || value.status === "failed",
			START_TIMEOUT_MS,
			supervisor.pid,
		);
		if (readyManifest.schemaVersion !== AGENT_LAB_SCHEMA_VERSION) {
			throw new Error(
				`New Agent Lab run ${config.runId} wrote unexpected manifest schema ${readyManifest.schemaVersion}.`,
			);
		}
		manifest = readyManifest;
	} catch (error) {
		await writeJsonAtomic(config.stopRequestPath, {
			requestedAt: new Date().toISOString(),
			requestedBy: process.pid,
			reason: "start failed or timed out",
		}).catch(() => {});
		throw error;
	}
	assertAgentLabDidNotFail(manifest);
	if (options.json) {
		printJson(manifest);
		return;
	}
	printManifestSummary(manifest);
}

async function statusAgentLab(runId: string | undefined, options: OutputOptions): Promise<void> {
	const manifest = await readAgentLabManifest(await resolveManifestPath(runId));
	const status = { ...manifest, supervisorAlive: isProcessAlive(manifest.supervisorPid) };
	if (options.json) {
		printJson(status);
		return;
	}
	printManifestSummary(manifest);
	process.stdout.write(
		`Supervisor: ${status.supervisorAlive ? "alive" : "not running"} (${manifest.supervisorPid})\n`,
	);
}

async function stopAgentLab(runId: string | undefined, options: OutputOptions): Promise<void> {
	const manifestPath = await resolveManifestPath(runId);
	let manifest = await readAgentLabManifest(manifestPath);
	if (manifest.status === "stopped" || manifest.status === "failed") {
		if (options.json) {
			printJson(manifest);
		} else {
			printManifestSummary(manifest);
		}
		assertAgentLabDidNotFail(manifest);
		return;
	}
	if (!isProcessAlive(manifest.supervisorPid)) {
		const liveChildren = Object.entries(manifest.processes)
			.filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
			.filter(([, child]) => isProcessAlive(child.pid));
		if (liveChildren.length > 0) {
			throw new Error(
				`Agent-lab supervisor ${manifest.supervisorPid} is not running, but managed processes still appear alive (${liveChildren.map(([label, child]) => `${label}:${child.pid}`).join(", ")}). Inspect ${manifest.artifactDir} before terminating them.`,
			);
		}
		manifest = {
			...manifest,
			status: "failed",
			stoppedAt: new Date().toISOString(),
			failure: manifest.failure ?? `Supervisor ${manifest.supervisorPid} exited without finalizing the run.`,
		};
		await closeAgentLabBrowserSession(manifest.repoRoot, manifest.browserSession).catch(() => {});
		await writeJsonAtomic(manifestPath, manifest);
		if (options.json) {
			printJson(manifest);
		} else {
			printManifestSummary(manifest);
		}
		assertAgentLabDidNotFail(manifest);
		return;
	}
	await writeJsonAtomic(manifest.stopRequestPath, { requestedAt: new Date().toISOString(), requestedBy: process.pid });
	const stopped = await waitForManifest(
		manifestPath,
		(value) => value.status === "stopped" || value.status === "failed",
		STOP_TIMEOUT_MS + 5_000,
	);
	if (options.json) {
		printJson(stopped);
	} else {
		printManifestSummary(stopped);
	}
	assertAgentLabDidNotFail(stopped);
}

async function waitForRuntimeRestart(
	manifestPath: string,
	resultPath: string,
	requestId: string,
	supervisorPid: number,
): Promise<AgentLabRuntimeRestartResult> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const contents = await readFile(resultPath, "utf8");
			const result = AgentLabRuntimeRestartResultSchema.parse(JSON.parse(contents) as unknown);
			if (result.requestId === requestId) return result;
		} catch (error) {
			const isMissing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!isMissing) throw error;
		}
		const manifest = await readAgentLabManifest(manifestPath);
		if (manifest.status === "failed") {
			throw new Error(`Agent lab failed during runtime restart: ${manifest.failure ?? "unknown failure"}.`);
		}
		if (!isProcessAlive(supervisorPid)) {
			throw new Error(`Agent-lab supervisor ${supervisorPid} exited during runtime restart.`);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
	}
	throw new Error(`Timed out waiting for Agent Lab runtime restart request ${requestId}.`);
}

async function restartAgentLabRuntime(runId: string | undefined, options: RestartRuntimeOptions): Promise<void> {
	const manifestPath = await resolveManifestPath(runId);
	const manifest = await readAgentLabManifest(manifestPath);
	if (manifest.schemaVersion !== AGENT_LAB_SCHEMA_VERSION) {
		throw new Error("This Agent Lab run predates same-state runtime restart support; start a new run.");
	}
	if (manifest.status !== "ready") {
		throw new Error(`Agent Lab runtime can restart only from ready status; current status is ${manifest.status}.`);
	}
	if (!isProcessAlive(manifest.supervisorPid)) {
		throw new Error(`Agent-lab supervisor ${manifest.supervisorPid} is not running.`);
	}
	try {
		await access(manifest.runtimeRestartRequestPath);
		throw new Error("An Agent Lab runtime restart request is already pending.");
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	const requestId = randomUUID();
	await writeJsonAtomic(manifest.runtimeRestartRequestPath, {
		schemaVersion: 1,
		requestId,
		mode: options.mode,
		requestedAt: new Date().toISOString(),
		requestedBy: process.pid,
	});
	const result = await waitForRuntimeRestart(
		manifestPath,
		manifest.runtimeRestartResultPath,
		requestId,
		manifest.supervisorPid,
	);
	if (options.json) {
		printJson(result);
	} else {
		process.stdout.write(
			`Runtime restarted: generation ${result.fromGeneration} -> ${result.toGeneration ?? "failed"} (${result.status})\n`,
		);
	}
	if (result.status !== "completed") {
		throw new Error(result.error ?? "Agent Lab runtime restart failed.");
	}
}

async function snapshotAgentLab(runId: string | undefined, label: string, options: OutputOptions): Promise<void> {
	const manifest = await readAgentLabManifest(await resolveManifestPath(runId));
	if (!isProcessAlive(manifest.supervisorPid) && !manifest.keepTemp) {
		throw new Error(
			"The lab is no longer running and its temporary fixture was removed; use its final snapshot instead.",
		);
	}
	const snapshot = await captureAgentLabSnapshot(manifest, label);
	if (options.json) {
		printJson(snapshot);
		return;
	}
	process.stdout.write(`Snapshot: ${snapshot.path}\n`);
}

async function listAgentLabs(options: OutputOptions): Promise<void> {
	const artifactRoot = getAgentLabArtifactRoot(AGENT_LAB_REPO_ROOT);
	try {
		await access(artifactRoot);
	} catch {
		if (options.json) {
			printJson([]);
		} else {
			process.stdout.write("No agent-lab runs found.\n");
		}
		return;
	}
	const entries = await readdir(artifactRoot, { withFileTypes: true });
	const manifests = (
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => readAgentLabManifest(join(artifactRoot, entry.name, "manifest.json")).catch(() => null)),
		)
	)
		.filter((manifest): manifest is ReadableAgentLabManifest => manifest !== null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const summaries = manifests.map((manifest) => ({
		runId: manifest.runId,
		status: manifest.status,
		createdAt: manifest.createdAt,
		projectUrl: manifest.projectUrl,
		supervisorAlive: isProcessAlive(manifest.supervisorPid),
		artifactDir: manifest.artifactDir,
	}));
	if (options.json) {
		printJson(summaries);
		return;
	}
	if (summaries.length === 0) {
		process.stdout.write("No agent-lab runs found.\n");
		return;
	}
	for (const summary of summaries) {
		process.stdout.write(
			`${summary.runId}\t${summary.status}\t${summary.supervisorAlive ? "alive" : "stopped"}\t${summary.projectUrl}\n`,
		);
	}
}

export async function runAgentLabCli(argv = process.argv): Promise<void> {
	const program = new Command();
	program.name("agent-lab").description("Run a disposable Quarterdeck instance for agent-driven UI testing.");
	program
		.command("start")
		.description("Start an isolated runtime, web UI, git fixture, and fake Codex agent.")
		.option("--name <name>", "Human-readable run-name prefix.", "run")
		.addOption(
			new Option("--scenario <scenario>", "Default fake-agent scenario.")
				.choices(AgentLabScenarioSchema.options)
				.default("idle"),
		)
		.option("--runtime-port <port>", 'Runtime port or "auto".', parsePort, null)
		.option("--web-port <port>", 'Web port or "auto".', parsePort, null)
		.option("--keep-temp", "Keep the disposable home/state/project directories after shutdown.")
		.option("--json", "Print the ready manifest as JSON.")
		.action(async (options: StartOptions) => startAgentLab(options));
	program
		.command("status [run-id]")
		.description("Show one run; defaults to the most recently started run.")
		.option("--json", "Print JSON.")
		.action(async (runId: string | undefined, options: OutputOptions) => statusAgentLab(runId, options));
	program
		.command("stop [run-id]")
		.description("Request graceful shutdown; defaults to the most recently started run.")
		.option("--json", "Print the final manifest as JSON.")
		.action(async (runId: string | undefined, options: OutputOptions) => stopAgentLab(runId, options));
	program
		.command("restart-runtime [run-id]")
		.description("Gracefully restart only the runtime against the same disposable state and browser session.")
		.addOption(new Option("--mode <mode>", "Restart mode.").choices(["graceful"]).default("graceful"))
		.option("--json", "Print the completed restart record as JSON.")
		.action(async (runId: string | undefined, options: RestartRuntimeOptions) =>
			restartAgentLabRuntime(runId, options),
		);
	program
		.command("snapshot [run-id]")
		.description("Capture Quarterdeck state and git diagnostics without stopping the run.")
		.option("--label <label>", "Snapshot label.", "manual")
		.option("--json", "Print JSON.")
		.action(async (runId: string | undefined, options: OutputOptions & { label: string }) =>
			snapshotAgentLab(runId, options.label, options),
		);
	program
		.command("list")
		.description("List recorded runs.")
		.option("--json", "Print JSON.")
		.action(async (options: OutputOptions) => listAgentLabs(options));
	await program.parseAsync(argv);
}
