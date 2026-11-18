import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
	collectDiagnosticCapture,
	selectRuntimeDiagnosticInstance,
	writeDiagnosticBundle,
} from "../../src/diagnostics";
import type { DesktopLabFixture } from "./desktop-fixture";

/** Synthetic state only. Never copy credential-bearing runtime or diagnostics descriptors. */
export async function copyAgentLabJsonState(
	sourceRoot: string,
	destinationRoot: string,
	currentPath = sourceRoot,
): Promise<void> {
	const entries = await readdir(currentPath, { withFileTypes: true });
	for (const entry of entries) {
		const source = join(currentPath, entry.name);
		const scopedPath = relative(sourceRoot, source);
		if (["diagnostics", "runtime-ownership", "hooks"].includes(scopedPath.split(sep)[0] ?? "")) continue;
		if (entry.isDirectory()) await copyAgentLabJsonState(sourceRoot, destinationRoot, source);
		else if (entry.isFile() && entry.name.endsWith(".json") && (await stat(source)).size <= 2 * 1024 * 1024) {
			const destination = join(destinationRoot, scopedPath);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await writeFile(destination, await readFile(source), { mode: 0o600 });
		}
	}
}

/** Canonical diagnostic bundles survive removal of the standalone browser supervisor. */
export async function captureDesktopDiagnosticSnapshot(fixture: DesktopLabFixture, label: string): Promise<void> {
	if (!/^[a-z][a-z0-9-]{0,50}$/u.test(label)) throw new Error("Invalid desktop diagnostic checkpoint label.");
	const { manifest, config } = fixture;
	if (!manifest.helperPid) return; // Recovery-admission checkpoints can precede helper construction.
	const instance = await selectRuntimeDiagnosticInstance({
		stateHome: config.stateHome,
		runtimePid: manifest.helperPid,
	});
	if (!instance) throw new Error("Packaged diagnostic checkpoint has no exact runtime instance.");
	const capture = await collectDiagnosticCapture(instance, { requestBrowser: true, fallbackToJournal: true });
	const staging = await mkdtemp(join(manifest.artifactDir, ".snapshot-evidence-"));
	try {
		await copyAgentLabJsonState(config.stateHome, join(staging, "state"));
		await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		await writeDiagnosticBundle({
			quarterdeckVersion: capture.descriptor.quarterdeckVersion,
			descriptor: capture.descriptor,
			records: capture.records,
			snapshot: capture.snapshot,
			findings: capture.findings,
			health: capture.health,
			warnings: capture.warnings,
			tier: "agent-lab",
			outputDirectory: join(manifest.artifactDir, "snapshots", `${label}-${Date.now()}`),
			contentFlags: { includePaths: true, includeTaskText: true, includeTerminal: true, includeGitDiff: true },
			additionalEvidence: [
				{ sourcePath: staging, bundlePath: "lab", required: true },
				{ sourcePath: join(manifest.artifactDir, "host-events.json"), bundlePath: "lab/host-events.json" },
				{ sourcePath: join(manifest.artifactDir, `${label}-sockets.json`), bundlePath: "lab/sockets.json" },
			],
		});
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
