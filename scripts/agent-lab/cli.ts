import { spawn } from "node:child_process";
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
import { type AgentLabManifest, type AgentLabScenario, AgentLabScenarioSchema } from "./types";

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

function browserCommand(manifest: AgentLabManifest): string {
	return `npm run agent:browser -- --config ${JSON.stringify(manifest.browserConfigPath)} -s=${JSON.stringify(manifest.browserSession)} open ${JSON.stringify(manifest.projectUrl)}`;
}

function printManifestSummary(manifest: AgentLabManifest): void {
	process.stdout.write(`Agent lab ${manifest.runId}: ${manifest.status}\n`);
	process.stdout.write(`UI: ${manifest.projectUrl}\n`);
	process.stdout.write(`Manifest: ${manifest.manifestPath}\n`);
	process.stdout.write(`Artifacts: ${manifest.artifactDir}\n`);
	process.stdout.write(`Browser: ${browserCommand(manifest)}\n`);
}

async function waitForManifest(
	manifestPath: string,
	predicate: (manifest: AgentLabManifest) => boolean,
	timeoutMs: number,
	supervisorPid?: number,
): Promise<AgentLabManifest> {
	const deadline = Date.now() + timeoutMs;
	let lastManifest: AgentLabManifest | null = null;
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
		manifest = await waitForManifest(
			config.manifestPath,
			(value) => value.status === "ready" || value.status === "failed",
			START_TIMEOUT_MS,
			supervisor.pid,
		);
	} catch (error) {
		await writeJsonAtomic(config.stopRequestPath, {
			requestedAt: new Date().toISOString(),
			requestedBy: process.pid,
			reason: "start failed or timed out",
		}).catch(() => {});
		throw error;
	}
	if (manifest.status === "failed") {
		throw new Error(`Agent lab failed: ${manifest.failure ?? "unknown failure"}. Inspect ${manifest.artifactDir}.`);
	}
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
		return;
	}
	printManifestSummary(stopped);
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
		.filter((manifest): manifest is AgentLabManifest => manifest !== null)
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
