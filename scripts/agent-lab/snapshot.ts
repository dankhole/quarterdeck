import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import {
	type DiagnosticSnapshot,
	type PublicRuntimeDiagnosticDescriptor,
	runtimeHostIntegrationEventLedgerFileSchema,
} from "../../src/core";
import {
	type CollectedDiagnosticCapture,
	collectDiagnosticCapture,
	type DiagnosticBundleEvidenceSource,
	evaluateDiagnosticSnapshot,
	selectRuntimeDiagnosticInstance,
	writeDiagnosticBundle,
} from "../../src/diagnostics";
import type { AgentLabSnapshotResult, ReadableAgentLabManifest } from "./types";

const execFileAsync = promisify(execFile);
const MAX_STATE_FILE_BYTES = 2 * 1024 * 1024;
const ACTION_TRANSCRIPT_NAME = "browser-actions.jsonl";

function sanitizeLabel(label: string): string {
	const sanitized = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
	return sanitized || "snapshot";
}

function isDiagnosticsStatePath(sourceRoot: string, sourcePath: string): boolean {
	return relative(sourceRoot, sourcePath).split(sep)[0] === "diagnostics";
}

async function copyJsonState(sourceRoot: string, destinationRoot: string, currentPath = sourceRoot): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(currentPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const sourcePath = join(currentPath, entry.name);
		if (entry.isDirectory()) {
			// The canonical bundle already contains the recorder journal and public
			// descriptor. Copying this directory would leak its authentication token.
			if (!isDiagnosticsStatePath(sourceRoot, sourcePath)) {
				await copyJsonState(sourceRoot, destinationRoot, sourcePath);
			}
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const fileStats = await stat(sourcePath);
		if (fileStats.size > MAX_STATE_FILE_BYTES) continue;
		const destinationPath = join(destinationRoot, relative(sourceRoot, sourcePath));
		await mkdir(dirname(destinationPath), { recursive: true });
		await writeFile(destinationPath, await readFile(sourcePath));
	}
}

async function captureGitCommand(projectPath: string, destinationPath: string, args: string[]): Promise<void> {
	try {
		const result = await execFileAsync("git", args, {
			cwd: projectPath,
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			maxBuffer: 5 * 1024 * 1024,
		});
		await writeFile(destinationPath, `${result.stdout}${result.stderr}`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await writeFile(destinationPath, `[agent-lab snapshot failed]\n${message}\n`, "utf8");
	}
}

async function captureTaskWorktreeGitState(manifest: ReadableAgentLabManifest, gitPath: string): Promise<void> {
	const worktreesRoot = join(manifest.statePath, "worktrees");
	let entries: Dirent[];
	try {
		entries = await readdir(worktreesRoot, { withFileTypes: true });
	} catch {
		return;
	}

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const projectPath = join(worktreesRoot, entry.name, "project");
				const destinationPath = join(gitPath, "task-worktrees", entry.name);
				await mkdir(destinationPath, { recursive: true });
				await Promise.all([
					captureGitCommand(projectPath, join(destinationPath, "status.txt"), ["status", "--short", "--branch"]),
					captureGitCommand(projectPath, join(destinationPath, "diff.patch"), ["diff", "--no-ext-diff"]),
					captureGitCommand(projectPath, join(destinationPath, "diff-cached.patch"), [
						"diff",
						"--cached",
						"--no-ext-diff",
					]),
				]);
			}),
	);
}

async function captureHostEventLedger(
	manifest: ReadableAgentLabManifest,
	labPath: string,
	flushRuntime: boolean,
): Promise<void> {
	if (manifest.schemaVersion === 1) {
		return;
	}
	if (flushRuntime) {
		const flushResponse = await fetch(`${manifest.runtimeUrl}/api/agent-lab/host-events/flush`, {
			method: "POST",
			signal: AbortSignal.timeout(5_000),
		});
		if (!flushResponse.ok) {
			throw new Error(`Could not flush Agent Lab host events (HTTP ${flushResponse.status}).`);
		}
	}
	const contents = await readFile(manifest.hostEventLedgerPath, "utf8");
	const ledger = runtimeHostIntegrationEventLedgerFileSchema.parse(JSON.parse(contents) as unknown);
	await writeFile(join(labPath, "host-events.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function platformFamily(): PublicRuntimeDiagnosticDescriptor["platform"] {
	if (process.platform === "darwin") return "mac";
	if (process.platform === "linux") return "linux";
	if (process.platform === "win32") return "windows";
	return "other";
}

async function readQuarterdeckVersion(repoRoot: string): Promise<string> {
	try {
		const parsed = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}

async function createMissingRuntimeCapture(manifest: ReadableAgentLabManifest): Promise<CollectedDiagnosticCapture> {
	const runtimeInstanceId = `agent-lab-${manifest.runId}`;
	const descriptor: PublicRuntimeDiagnosticDescriptor = {
		version: 1,
		runtimeInstanceId,
		status: "failed",
		pid: manifest.processes.runtime?.pid ?? manifest.supervisorPid,
		host: "127.0.0.1",
		port: Number.parseInt(new URL(manifest.runtimeUrl).port, 10) || 1,
		quarterdeckVersion: await readQuarterdeckVersion(manifest.repoRoot),
		nodeMajorVersion: Number.parseInt(process.versions.node.split(".")[0] ?? "", 10) || 1,
		platform: platformFamily(),
		startedAt: manifest.createdAt,
		readyAt: manifest.readyAt,
		stoppedAt: manifest.stoppedAt,
		failure: manifest.failure ?? "Runtime diagnostic descriptor was unavailable.",
	};
	const snapshot: DiagnosticSnapshot = {
		version: 1,
		runtimeInstanceId,
		capturedAt: Date.now(),
		providers: [
			{
				name: "runtime",
				status: "unavailable",
				durationMs: 0,
				error: "Runtime diagnostic descriptor was unavailable; only lab process/state evidence was captured.",
			},
		],
	};
	return {
		descriptor,
		health: null,
		records: [],
		snapshot,
		findings: evaluateDiagnosticSnapshot(snapshot, []),
		warnings: ["No runtime diagnostic descriptor was available; canonical lab evidence is partial."],
	};
}

async function collectSharedDiagnostics(manifest: ReadableAgentLabManifest): Promise<CollectedDiagnosticCapture> {
	const instance = await selectRuntimeDiagnosticInstance({
		stateHome: manifest.statePath,
		runtimePid: manifest.processes.runtime?.pid,
	});
	if (!instance) return await createMissingRuntimeCapture(manifest);
	return await collectDiagnosticCapture(instance, { requestBrowser: true, fallbackToJournal: true });
}

function evidenceSources(manifest: ReadableAgentLabManifest, labPath: string): DiagnosticBundleEvidenceSource[] {
	const runtimeLogPaths = new Set<string>();
	if (manifest.processes.runtime?.logPath) {
		runtimeLogPaths.add(manifest.processes.runtime.logPath);
	}
	if (manifest.schemaVersion === 3 || manifest.schemaVersion === 4) {
		for (const restart of manifest.runtimeRestarts) {
			runtimeLogPaths.add(restart.previousProcess.logPath);
			if (restart.replacementProcess) runtimeLogPaths.add(restart.replacementProcess.logPath);
		}
	}
	const runtimeLogs = Array.from(runtimeLogPaths).map((sourcePath) => ({
		sourcePath,
		bundlePath: `lab/process/${basename(sourcePath)}`,
	}));
	return [
		{ sourcePath: labPath, bundlePath: "lab", required: true },
		{ sourcePath: join(manifest.artifactDir, ACTION_TRANSCRIPT_NAME), bundlePath: `lab/${ACTION_TRANSCRIPT_NAME}` },
		{ sourcePath: manifest.browserOutputPath, bundlePath: "lab/playwright" },
		...runtimeLogs,
		{ sourcePath: join(manifest.artifactDir, "web.log"), bundlePath: "lab/process/web.log" },
		{ sourcePath: join(manifest.artifactDir, "supervisor.log"), bundlePath: "lab/process/supervisor.log" },
	];
}

export async function captureAgentLabSnapshot(
	manifest: ReadableAgentLabManifest,
	requestedLabel: string,
	options: { flushHostEvents?: boolean } = {},
): Promise<AgentLabSnapshotResult> {
	const createdAt = new Date().toISOString();
	const timestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const label = sanitizeLabel(requestedLabel);
	const snapshotPath = join(manifest.artifactDir, "snapshots", `${timestamp}-${label}`);
	const stagingRoot = await mkdtemp(join(manifest.artifactDir, ".snapshot-evidence-"));
	const labPath = join(stagingRoot, "lab");
	const stateDestination = join(labPath, "state");
	const gitPath = join(labPath, "git");
	const agent = manifest.schemaVersion === 4 ? manifest.agent : ({ mode: "fake" } as const);
	try {
		await Promise.all([
			mkdir(stateDestination, { recursive: true }),
			mkdir(join(gitPath, "main"), { recursive: true }),
		]);
		await copyJsonState(manifest.statePath, stateDestination);
		await writeFile(join(labPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await Promise.all([
			captureHostEventLedger(manifest, labPath, options.flushHostEvents !== false),
			captureGitCommand(manifest.projectPath, join(gitPath, "main", "status.txt"), [
				"status",
				"--short",
				"--branch",
			]),
			captureGitCommand(manifest.projectPath, join(gitPath, "main", "log.txt"), [
				"log",
				"-n",
				"10",
				"--oneline",
				"--decorate",
			]),
			captureGitCommand(manifest.projectPath, join(gitPath, "main", "diff.patch"), ["diff", "--no-ext-diff"]),
			captureGitCommand(manifest.projectPath, join(gitPath, "main", "diff-cached.patch"), [
				"diff",
				"--cached",
				"--no-ext-diff",
			]),
			captureTaskWorktreeGitState(manifest, gitPath),
		]);
		await writeFile(
			join(labPath, "checkpoint.json"),
			`${JSON.stringify(
				{
					version: 1,
					runId: manifest.runId,
					label,
					createdAt,
					scenario: manifest.scenario,
					agent,
					...(agent.mode === "fake" ? { fakeAgentProtocol: "quarterdeck-agent-lab-v1" } : {}),
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const capture = await collectSharedDiagnostics(manifest);
		const result = await writeDiagnosticBundle({
			quarterdeckVersion: capture.descriptor.quarterdeckVersion,
			descriptor: capture.descriptor,
			records: capture.records,
			snapshot: capture.snapshot,
			findings: capture.findings,
			health: capture.health,
			warnings: capture.warnings,
			tier: "agent-lab",
			outputDirectory: snapshotPath,
			contentFlags: {
				includePaths: true,
				includeTaskText: true,
				includeTerminal: true,
				includeGitDiff: true,
			},
			additionalEvidence: evidenceSources(manifest, labPath),
		});
		return {
			label,
			path: result.path,
			createdAt,
			bundleId: result.manifest.bundleId,
			status: result.manifest.status,
			warnings: result.manifest.warnings,
		};
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}
}
